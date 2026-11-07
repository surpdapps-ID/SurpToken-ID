const hre = require("hardhat");
const { ethers } = hre;
const { assertConfiguredNetwork, requiredNetworkEnv } = require("./utils/networkEnv.cjs");

const SHOP_ABI = [
  "function owner() view returns (address)",
  "function token() view returns (address)",
  "function staminaPrice() view returns (uint256)",
  "function durabilityPrice() view returns (uint256)",
  "function bankPrice() view returns (uint256)",
  "function setPrices(uint256,uint256,uint256)",
];

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const shopAddressValue = requiredNetworkEnv(hre, "SRP_SHOP_ADDRESS");
  const tokenAddress = ethers.getAddress(requiredNetworkEnv(hre, "SRP_TOKEN"));
  if (!ethers.isAddress(shopAddressValue) || shopAddressValue === ethers.ZeroAddress) {
    throw new Error(`SRP_SHOP_ADDRESS_${suffix} harus berupa alamat valid.`);
  }
  const shopAddress = ethers.getAddress(shopAddressValue);

  const priceNames = ["STAMINA", "DURABILITY", "BANK"];
  const priceValues = priceNames.map((name) =>
    requiredNetworkEnv(hre, `SRP_SHOP_${name}_PRICE`),
  );
  if (priceValues.some((value) => !/^\d+(?:\.\d+)?$/.test(value))) {
    throw new Error(`Harga SRP Shop harus berupa angka SRP yang valid pada jaringan ${suffix}.`);
  }
  const [staminaPrice, durabilityPrice, bankPrice] = priceValues.map((value) =>
    ethers.parseUnits(value, 18),
  );

  if ((await ethers.provider.getCode(shopAddress)) === "0x") {
    throw new Error(`SRP_SHOP_ADDRESS_${suffix} bukan kontrak di jaringan ini.`);
  }
  if ((await ethers.provider.getCode(tokenAddress)) === "0x") {
    throw new Error(`SRP_TOKEN_${suffix} bukan kontrak di jaringan ini.`);
  }

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("Signer tidak tersedia; isi PRIVATE_KEY di .env.");

  const shop = new ethers.Contract(shopAddress, SHOP_ABI, signer);
  const [owner, shopToken, currentStaminaPrice, currentDurabilityPrice, currentBankPrice] =
    await Promise.all([
      shop.owner(),
      shop.token(),
      shop.staminaPrice(),
      shop.durabilityPrice(),
      shop.bankPrice(),
    ]);
  if (shopToken.toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new Error(`SRP_SHOP_ADDRESS_${suffix} menggunakan token berbeda dari SRP_TOKEN_${suffix}.`);
  }
  if (
    currentStaminaPrice === staminaPrice &&
    currentDurabilityPrice === durabilityPrice &&
    currentBankPrice === bankPrice
  ) {
    console.log("Harga SRP Shop sudah sesuai konfigurasi.");
    return;
  }

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    const data = shop.interface.encodeFunctionData("setPrices", [
      staminaPrice,
      durabilityPrice,
      bankPrice,
    ]);
    console.error(`Signer ${signer.address} bukan owner SRP_Shop (owner: ${owner}).`);
    console.error("Usulkan transaksi berikut melalui Safe:");
    console.error(JSON.stringify([{ to: shopAddress, data }], null, 2));
    throw new Error("Harga SRP Shop tidak diubah karena signer bukan owner.");
  }

  const tx = await shop.setPrices(staminaPrice, durabilityPrice, bankPrice);
  await tx.wait();
  const [updatedStaminaPrice, updatedDurabilityPrice, updatedBankPrice] = await Promise.all([
    shop.staminaPrice(),
    shop.durabilityPrice(),
    shop.bankPrice(),
  ]);
  if (
    updatedStaminaPrice !== staminaPrice ||
    updatedDurabilityPrice !== durabilityPrice ||
    updatedBankPrice !== bankPrice
  ) {
    throw new Error("Verifikasi harga SRP Shop gagal setelah transaksi.");
  }

  console.log(`Harga SRP Shop berhasil diperbarui di ${suffix} (tx: ${tx.hash}).`);
  console.log(`Stamina: ${ethers.formatUnits(staminaPrice, 18)} SRP`);
  console.log(`Durability: ${ethers.formatUnits(durabilityPrice, 18)} SRP`);
  console.log(`Bank: ${ethers.formatUnits(bankPrice, 18)} SRP`);
}

main().catch((error) => {
  console.error("Gagal mengatur harga SRP Shop:", error);
  process.exitCode = 1;
});
