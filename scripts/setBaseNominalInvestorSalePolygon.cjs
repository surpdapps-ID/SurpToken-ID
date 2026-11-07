const hre = require("hardhat");
const { ethers } = hre;
const { requiredNetworkEnv } = require("./utils/networkEnv.cjs");

const INVESTOR_SALE_ABI = [
  "function owner() view returns (address)",
  "function saleActive() view returns (bool)",
  "function investmentAmounts(uint256) view returns (uint256)",
  "function setInvestmentAmounts(uint256[5])",
];

async function main() {
  const expectedChainId = 137n;
  if (hre.network.config.chainId !== Number(expectedChainId)) {
    throw new Error("Script ini hanya untuk Polygon mainnet.");
  }
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== expectedChainId) {
    throw new Error(`RPC chain ID ${network.chainId} bukan Polygon mainnet (137).`);
  }

  const saleAddressValue = requiredNetworkEnv(hre, "INVESTOR_SALE_ADDRESS");
  if (!ethers.isAddress(saleAddressValue) || saleAddressValue === ethers.ZeroAddress) {
    throw new Error("INVESTOR_SALE_ADDRESS_POLYGON harus berupa alamat valid.");
  }
  const saleAddress = ethers.getAddress(saleAddressValue);
  const investmentAmounts = Array.from({ length: 5 }, (_, index) => {
    const level = index + 1;
    const envName = `INVESTMENT_LEVEL_${level}_POL`;
    const value = requiredNetworkEnv(hre, envName);
    if (!/^\d+(?:\.\d+)?$/.test(value)) {
      throw new Error(`${envName}_POLYGON harus berupa jumlah POL yang valid.`);
    }
    const amount = ethers.parseEther(value);
    if (amount <= 0n) {
      throw new Error(`${envName}_POLYGON harus lebih besar dari nol.`);
    }
    return amount;
  });

  if ((await ethers.provider.getCode(saleAddress)) === "0x") {
    throw new Error(`INVESTOR_SALE_ADDRESS_POLYGON bukan kontrak di Polygon.`);
  }
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("Signer tidak tersedia; isi PRIVATE_KEY di .env.");

  const sale = new ethers.Contract(saleAddress, INVESTOR_SALE_ABI, signer);
  const [owner, saleActive, currentAmounts] = await Promise.all([
    sale.owner(),
    sale.saleActive(),
    Promise.all(Array.from({ length: 5 }, (_, index) => sale.investmentAmounts(index))),
  ]);
  if (saleActive) {
    throw new Error("InvestorSale masih aktif. Nonaktifkan sale terlebih dahulu sebagai owner, lalu jalankan ulang script.");
  }
  if (currentAmounts.every((amount, index) => amount === investmentAmounts[index])) {
    console.log("Nominal semua level InvestorSale sudah sesuai konfigurasi.");
    return;
  }

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    const data = sale.interface.encodeFunctionData("setInvestmentAmounts", [investmentAmounts]);
    console.error(`Signer ${signer.address} bukan owner InvestorSale (owner: ${owner}).`);
    console.error("Pastikan sale nonaktif, lalu usulkan transaksi berikut melalui Safe:");
    console.error(JSON.stringify([{ to: saleAddress, data }], null, 2));
    throw new Error("Nominal InvestorSale tidak diubah karena signer bukan owner.");
  }

  const tx = await sale.setInvestmentAmounts(investmentAmounts);
  await tx.wait();
  const updatedAmounts = await Promise.all(
    Array.from({ length: 5 }, (_, index) => sale.investmentAmounts(index)),
  );
  if (!updatedAmounts.every((amount, index) => amount === investmentAmounts[index])) {
    throw new Error("Verifikasi nominal InvestorSale gagal setelah transaksi.");
  }

  console.log(`Nominal InvestorSale berhasil diperbarui di Polygon (tx: ${tx.hash}).`);
  investmentAmounts.forEach((amount, index) => {
    console.log(`Level ${index + 1}: ${ethers.formatEther(amount)} POL`);
  });
}

main().catch((error) => {
  console.error("Gagal mengatur nominal InvestorSale Polygon:", error);
  process.exitCode = 1;
});
