const hre = require("hardhat");
const { ethers } = hre;
const { assertConfiguredNetwork, requiredNetworkEnv } = require("./utils/networkEnv.cjs");

const INVESTOR_SALE_ABI = [
  "function owner() view returns (address)",
  "function saleActive() view returns (bool)",
  "function dexPricingEnabled() view returns (bool)",
  "function manualPriceX18() view returns (uint256)",
  "function setManualPrice(uint256)",
];

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const saleAddressValue = requiredNetworkEnv(hre, "INVESTOR_SALE_ADDRESS");
  if (!ethers.isAddress(saleAddressValue) || saleAddressValue === ethers.ZeroAddress) {
    throw new Error(`INVESTOR_SALE_ADDRESS_${suffix} harus berupa alamat valid.`);
  }
  const saleAddress = ethers.getAddress(saleAddressValue);

  const priceValue = requiredNetworkEnv(hre, "SRP_PRICE_POL");
  if (!/^\d+(?:\.\d+)?$/.test(priceValue)) {
    throw new Error(`SRP_PRICE_POL_${suffix} harus berupa angka POL per SRP yang valid.`);
  }
  const price = ethers.parseUnits(priceValue, 18);
  if (price <= 0n) {
    throw new Error(`SRP_PRICE_POL_${suffix} harus lebih besar dari nol.`);
  }

  if ((await ethers.provider.getCode(saleAddress)) === "0x") {
    throw new Error(`INVESTOR_SALE_ADDRESS_${suffix} bukan kontrak di jaringan ini.`);
  }
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("Signer tidak tersedia; isi PRIVATE_KEY di .env.");

  const sale = new ethers.Contract(saleAddress, INVESTOR_SALE_ABI, signer);
  const [owner, saleActive, dexPricingEnabled, currentPrice] = await Promise.all([
    sale.owner(),
    sale.saleActive(),
    sale.dexPricingEnabled(),
    sale.manualPriceX18(),
  ]);
  if (dexPricingEnabled) {
    throw new Error(
      "Harga manual terkunci karena DEX pricing sudah diaktifkan. InvestorSale tidak dapat kembali ke harga manual.",
    );
  }
  if (saleActive) {
    throw new Error("InvestorSale sedang aktif. Nonaktifkan sale terlebih dahulu sebagai owner, lalu jalankan ulang command.");
  }
  if (currentPrice === price) {
    console.log(`Harga manual InvestorSale sudah ${ethers.formatUnits(price, 18)} POL per SRP.`);
    return;
  }

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    const data = sale.interface.encodeFunctionData("setManualPrice", [price]);
    console.error(`Signer ${signer.address} bukan owner InvestorSale (owner: ${owner}).`);
    console.error("Pastikan sale nonaktif, lalu usulkan transaksi berikut melalui Safe:");
    console.error(JSON.stringify([{ to: saleAddress, data }], null, 2));
    throw new Error("Harga InvestorSale tidak diubah karena signer bukan owner.");
  }

  const tx = await sale.setManualPrice(price);
  await tx.wait();
  const updatedPrice = await sale.manualPriceX18();
  if (updatedPrice !== price) {
    throw new Error("Verifikasi harga manual InvestorSale gagal setelah transaksi.");
  }

  console.log(`Harga manual InvestorSale berhasil diperbarui di ${suffix} (tx: ${tx.hash}).`);
  console.log(`Harga: ${ethers.formatUnits(price, 18)} POL per SRP`);
}

main().catch((error) => {
  console.error("Gagal mengatur harga InvestorSale:", error);
  process.exitCode = 1;
});
