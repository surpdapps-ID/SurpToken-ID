const hre = require("hardhat");
const { verifyDeployment } = require("./utils/verifyDeployment.cjs");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");

const NFT_NAMES = [
  "SRP_Common",
  "SRP_Rare",
  "SRP_Epic",
  "SRP_Flash",
  "SRP_Scattery",
  "SRP_BrushViolet",
];
const MIN_TWAP_INTERVAL = 1800;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} wajib diisi di config/networks/${suffix.toLowerCase()}.cjs.`);
  return value;
}

async function main() {
  const suffix = hre.network.config.chainId === 80002
    ? "AMOY"
    : hre.network.config.chainId === 137
      ? "POLYGON"
      : null;
  if (!suffix) throw new Error("Gunakan network polygonAmoy atau polygon.");
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== BigInt(hre.network.config.chainId)) {
    throw new Error(`RPC chain ID ${network.chainId} tidak cocok dengan konfigurasi Hardhat.`);
  }

  const tokenAddress = hre.ethers.getAddress(requiredEnv(`SRP_TOKEN_${suffix}`));
  const p2eAddress = hre.ethers.getAddress(requiredEnv(`P2E_MANAGER_${suffix}`));
  const investorAddress = hre.ethers.getAddress(requiredEnv(`INVESTOR_SALE_ADDRESS_${suffix}`));
  const shopAddress = hre.ethers.getAddress(requiredEnv(`SRP_SHOP_ADDRESS_${suffix}`));
  const salesTreasuryValue = process.env[`SALES_TREASURY_ADDRESS_${suffix}`]?.trim();
  const salesTreasury = salesTreasuryValue
    ? hre.ethers.getAddress(salesTreasuryValue)
    : undefined;
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("Deployer tidak tersedia; isi PRIVATE_KEY di .env.");

  for (const address of [tokenAddress, p2eAddress, investorAddress, shopAddress]) {
    if ((await hre.ethers.provider.getCode(address)) === "0x") {
      throw new Error(`Alamat ${address} bukan kontrak di jaringan ${suffix}.`);
    }
  }
  const investor = new hre.ethers.Contract(
    investorAddress,
    [
      "function owner() view returns (address)",
      "function investmentToken() view returns (address)",
      "function nftContracts(uint256) view returns (address)",
      "function setNFTContracts(address[6])",
      "function saleActive() view returns (bool)",
      "function setSaleActive(bool)",
    ],
    deployer,
  );
  const shop = new hre.ethers.Contract(
    shopAddress,
    [
      "function owner() view returns (address)",
      "function token() view returns (address)",
      "function setNFTWhitelist(address,bool)",
    ],
    deployer,
  );
  const [saleOwner, shopOwner, saleToken, shopToken] = await Promise.all([
    investor.owner(),
    shop.owner(),
    investor.investmentToken(),
    shop.token(),
  ]);
  if (
    saleOwner.toLowerCase() !== deployer.address.toLowerCase() ||
    shopOwner.toLowerCase() !== deployer.address.toLowerCase()
  ) {
    throw new Error("Sebelum Safe dibuat, deployer harus menjadi owner InvestorSale dan SRP_Shop untuk menyelesaikan integrasi.");
  }
  if (saleToken.toLowerCase() !== tokenAddress.toLowerCase() ||
      shopToken.toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new Error("InvestorSale/SRP_Shop tidak memakai SRP_TOKEN jaringan ini.");
  }
  const p2e = new hre.ethers.Contract(
    p2eAddress,
    [
      "function owner() view returns (address)",
      "function isMiningPool(address) view returns (bool)",
      "function setMiningPoolStatus(address,bool)",
    ],
    deployer,
  );
  if ((await p2e.owner()).toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error("Sebelum Safe dibuat, deployer harus menjadi owner P2EManager untuk mengotorisasi NFT sebagai mining pool.");
  }

  const poolValue = process.env[`SRP_WETH9_POOL_${suffix}`]?.trim();
  const wrappedNative = hre.ethers.getAddress(requiredEnv(`WETH9_${suffix}`));
  const poolInterval = poolValue ? MIN_TWAP_INTERVAL : undefined;
  if (poolValue) {
    const surpSwapFactoryAddress = hre.ethers.getAddress(
      requiredEnv(`SURPSWAP_V3_FACTORY_${suffix}`),
    );
    const pool = new hre.ethers.Contract(
      poolValue,
      ["function factory() view returns (address)"],
      hre.ethers.provider,
    );
    if ((await pool.factory()).toLowerCase() !== surpSwapFactoryAddress.toLowerCase()) {
      throw new Error(`SRP_WETH9_POOL_${suffix} bukan pool dari SurpSwap factory ${surpSwapFactoryAddress}.`);
    }
  }

  const deployed = [];
  for (let index = 0; index < NFT_NAMES.length; index++) {
    const name = NFT_NAMES[index];
    const collection = name.replace("SRP_", "").toUpperCase();
    const baseUri = requiredEnv(`NFT_BASE_URI_${collection}_${suffix}`);
    const savedAddress = process.env[`NFT_${collection}_ADDRESS_${suffix}`]?.trim();
    let nft;
    let address;
    if (
      savedAddress &&
      hre.ethers.isAddress(savedAddress) &&
      (await hre.ethers.provider.getCode(savedAddress)) !== "0x"
    ) {
      address = hre.ethers.getAddress(savedAddress);
      nft = await hre.ethers.getContractAt(name, address, deployer);
      const [nftOwner, paymentToken, symbol, configuredInvestor] = await Promise.all([
        nft.owner(),
        nft.customPaymentToken(),
        nft.symbol(),
        nft.investorContract(),
      ]);
      const expectedSymbols = {
        SRP_Common: "ZCN",
        SRP_Rare: "ZRE",
        SRP_Epic: "ZEC",
        SRP_Flash: "ZFH",
        SRP_Scattery: "ZSY",
        SRP_BrushViolet: "ZBV",
      };
      if (nftOwner.toLowerCase() !== deployer.address.toLowerCase()) {
        throw new Error(`${name} ${address} sudah ada tetapi owner bukan deployer; konfigurasi tidak dapat dilanjutkan.`);
      }
      if (paymentToken.toLowerCase() !== tokenAddress.toLowerCase()) {
        throw new Error(`${name} ${address} memakai payment token yang berbeda.`);
      }
      if (symbol !== expectedSymbols[name]) {
        throw new Error(`${name} ${address} memiliki symbol ${symbol}, seharusnya ${expectedSymbols[name]}.`);
      }
      if (
        configuredInvestor !== hre.ethers.ZeroAddress &&
        configuredInvestor.toLowerCase() !== investorAddress.toLowerCase()
      ) {
        throw new Error(`${name} ${address} sudah terhubung ke InvestorSale berbeda.`);
      }
      console.log(`${name}: memakai deployment yang sudah ada ${address}`);
    } else {
      const factory = await hre.ethers.getContractFactory(name);
      nft = await factory.deploy(tokenAddress);
      await nft.waitForDeployment();
      address = await nft.getAddress();
      persistNetworkEnv(hre, { [`NFT_${collection}_ADDRESS`]: address });
      console.log(`${name}: ${address}`);
    }

    const [currentShop, currentP2E, currentInvestor] = await Promise.all([
      nft.shopContract(),
      nft.p2eManager(),
      nft.investorContract(),
    ]);
    if (currentShop.toLowerCase() !== shopAddress.toLowerCase()) {
      await (await nft.setShopContract(shopAddress)).wait();
    }
    if (currentP2E.toLowerCase() !== p2eAddress.toLowerCase()) {
      await (await nft.setP2EConfig(p2eAddress)).wait();
    }
    if (currentInvestor === hre.ethers.ZeroAddress) {
      await (await nft.setInvestorContract(investorAddress)).wait();
    }
    if (salesTreasury && (await nft.salesTreasury()).toLowerCase() !== salesTreasury.toLowerCase()) {
      await (await nft.setSalesTreasury(salesTreasury)).wait();
    }
    await (await nft.setBaseURI(baseUri)).wait();
    if (poolValue) {
      await (await nft.setTokenPool(poolValue, wrappedNative, poolInterval)).wait();
    }
    deployed.push({ name, address });
  }

  for (const nft of deployed) {
    if (!(await p2e.isMiningPool(nft.address))) {
      await (await p2e.setMiningPoolStatus(nft.address, true)).wait();
    }
    await (await shop.setNFTWhitelist(nft.address, true)).wait();
  }
  const configuredNfts = await Promise.all(
    NFT_NAMES.map((_, index) => investor.nftContracts(index)),
  );
  if (configuredNfts.every((address) => address === hre.ethers.ZeroAddress)) {
    await (await investor.setNFTContracts(deployed.map(({ address }) => address))).wait();
  } else if (
    configuredNfts.some(
      (address, index) => address.toLowerCase() !== deployed[index].address.toLowerCase(),
    )
  ) {
    throw new Error(
      "InvestorSale sudah terhubung ke alamat NFT berbeda. Tidak ada koleksi baru yang akan didaftarkan.",
    );
  } else {
    console.log("InvestorSale sudah terhubung ke keenam NFT ini; lewati konfigurasi yang sudah selesai.");
  }
  for (const { address } of deployed) {
    const nft = new hre.ethers.Contract(
      address,
      [
        "function setMintPhases(bool,bool)",
        "function isInvestorMintActive() view returns (bool)",
        "function isPublicMintActive() view returns (bool)",
      ],
      deployer,
    );
    await (await nft.setMintPhases(true, false)).wait();
    if (!await nft.isInvestorMintActive() || await nft.isPublicMintActive()) {
      throw new Error(`Fase mint ${address} tidak sesuai: voucher harus aktif dan public mint nonaktif.`);
    }
  }
  if (!(await investor.saleActive())) {
    await (await investor.setSaleActive(true)).wait();
  }
  if (!await investor.saleActive()) {
    throw new Error("InvestorSale gagal diaktifkan setelah integrasi NFT.");
  }
  console.log("Keenam NFT terhubung ke InvestorSale, Shop, dan P2E; InvestorSale/voucher mint aktif, public mint tetap nonaktif.");

  const failures = [];
  for (const nft of deployed) {
    try {
      await verifyDeployment(hre, {
        name: nft.name,
        address: nft.address,
        constructorArguments: [tokenAddress],
        contract: `contracts/${nft.name}.sol:${nft.name}`,
      });
    } catch (error) {
      failures.push(`${nft.name} (${nft.address}): ${error.message}`);
    }
  }
  if (failures.length) {
    throw new Error(`NFT berhasil dideploy, tetapi sebagian verifikasi gagal:\n${failures.join("\n")}`);
  }
}

main().catch((error) => {
  console.error("Deployment NFT tertunda gagal:", error);
  process.exitCode = 1;
});
