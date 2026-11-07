const hre = require("hardhat");
const {
  assertConfiguredNetwork,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");

const NFT_COLLECTIONS = [
  "COMMON",
  "RARE",
  "EPIC",
  "FLASH",
  "SCATTERY",
  "BRUSHVIOLET",
];

const NFT_ABI = [
  "function owner() view returns (address)",
  "function customPaymentToken() view returns (address)",
  "function publicPrice() view returns (uint256)",
  "function isInvestorMintActive() view returns (bool)",
  "function isPublicMintActive() view returns (bool)",
  "function setPublicPrice(uint256)",
  "function setMintPhases(bool,bool)",
];

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const [admin] = await hre.ethers.getSigners();
  if (!admin) throw new Error("Wallet admin tidak tersedia; isi PRIVATE_KEY di .env.");

  const collections = NFT_COLLECTIONS.map((collection) => {
    const addressValue = requiredNetworkEnv(hre, `NFT_${collection}_ADDRESS`);
    if (!hre.ethers.isAddress(addressValue) || addressValue === hre.ethers.ZeroAddress) {
      throw new Error(`NFT_${collection}_ADDRESS_${suffix} harus berupa alamat valid.`);
    }

    const priceValue = requiredNetworkEnv(hre, `NFT_PUBLIC_PRICE_${collection}`);
    const price = hre.ethers.parseUnits(priceValue, 18);
    if (price <= 0n) {
      throw new Error(`NFT_PUBLIC_PRICE_${collection}_${suffix} harus lebih besar dari nol.`);
    }

    return {
      collection,
      address: hre.ethers.getAddress(addressValue),
      price,
    };
  });

  const code = await Promise.all(
    collections.map(({ address }) => hre.ethers.provider.getCode(address)),
  );
  const missingContract = collections.find((_, index) => code[index] === "0x");
  if (missingContract) {
    throw new Error(`NFT ${missingContract.collection} ${missingContract.address} bukan kontrak di ${suffix}.`);
  }

  const nfts = await Promise.all(collections.map(async (item) => {
    const contract = new hre.ethers.Contract(item.address, NFT_ABI, admin);
    const [owner, paymentToken, currentPrice, investorMintActive, publicMintActive] =
      await Promise.all([
        contract.owner(),
        contract.customPaymentToken(),
        contract.publicPrice(),
        contract.isInvestorMintActive(),
        contract.isPublicMintActive(),
      ]);

    if (owner.toLowerCase() !== admin.address.toLowerCase()) {
      throw new Error(
        `Wallet admin bukan owner NFT ${item.collection} (owner: ${owner}); owner kontrak harus menjalankan konfigurasi.`,
      );
    }
    if ((await hre.ethers.provider.getCode(paymentToken)) === "0x") {
      throw new Error(`Token pembayaran NFT ${item.collection} ${paymentToken} bukan kontrak.`);
    }

    return {
      ...item,
      contract,
      paymentToken,
      currentPrice,
      investorMintActive,
      publicMintActive,
    };
  }));

  const paymentToken = nfts[0].paymentToken.toLowerCase();
  if (nfts.some((nft) => nft.paymentToken.toLowerCase() !== paymentToken)) {
    throw new Error("Semua koleksi harus menggunakan token pembayaran yang sama.");
  }
  const token = new hre.ethers.Contract(
    nfts[0].paymentToken,
    ["function symbol() view returns (string)", "function decimals() view returns (uint8)"],
    hre.ethers.provider,
  );
  const [tokenSymbol, tokenDecimals] = await Promise.all([token.symbol(), token.decimals()]);
  if (tokenSymbol !== "SRP" || tokenDecimals !== 18n) {
    throw new Error(
      `Token pembayaran harus SRP dengan 18 desimal; didapat ${tokenSymbol} dengan ${tokenDecimals} desimal.`,
    );
  }

  for (const nft of nfts) {
    if (nft.currentPrice !== nft.price) {
      const tx = await nft.contract.setPublicPrice(nft.price);
      await tx.wait();
      console.log(
        `Harga ${nft.collection} diset ke ${hre.ethers.formatUnits(nft.price, 18)} SRP (tx: ${tx.hash}).`,
      );
    } else {
      console.log(`Harga ${nft.collection} sudah ${hre.ethers.formatUnits(nft.price, 18)} SRP.`);
    }
  }

  for (const nft of nfts) {
    if (!nft.publicMintActive) {
      const tx = await nft.contract.setMintPhases(nft.investorMintActive, true);
      await tx.wait();
      console.log(`Public mint ${nft.collection} diaktifkan (tx: ${tx.hash}).`);
    } else {
      console.log(`Public mint ${nft.collection} sudah aktif.`);
    }
  }

  for (const nft of nfts) {
    const [configuredPrice, publicMintActive] = await Promise.all([
      nft.contract.publicPrice(),
      nft.contract.isPublicMintActive(),
    ]);
    if (configuredPrice !== nft.price || !publicMintActive) {
      throw new Error(`Verifikasi public sale NFT ${nft.collection} gagal.`);
    }
  }

  console.log(`Public mint keenam koleksi aktif di ${suffix}; token pembayaran: ${nfts[0].paymentToken}.`);
}

main().catch((error) => {
  console.error("Setup harga/public mint NFT gagal:", error);
  process.exitCode = 1;
});
