const hre = require("hardhat");
const { ethers } = hre;
const {
  assertConfiguredNetwork,
  networkEnv,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const [deployer] = await ethers.getSigners();

  const WETH_ADDRESS = requiredNetworkEnv(hre, "WITHDRAW_WETH_ADDRESS");
  const gasPriceGwei = networkEnv(hre, "WITHDRAW_WETH_GAS_PRICE_GWEI");
  if (!ethers.isAddress(WETH_ADDRESS)) {
    throw new Error(`Isi WITHDRAW_WETH_ADDRESS_${suffix} di config/networks/${suffix.toLowerCase()}.cjs dengan alamat kontrak WETH.`);
  }
  if (!gasPriceGwei) {
    throw new Error(`Isi WITHDRAW_WETH_GAS_PRICE_GWEI_${suffix} di config/networks/${suffix.toLowerCase()}.cjs.`);
  }
  if (Number(gasPriceGwei) <= 0 || !Number.isFinite(Number(gasPriceGwei))) {
    throw new Error(`WITHDRAW_WETH_GAS_PRICE_GWEI_${suffix} harus lebih besar dari nol.`);
  }
  const WETH_ABI = [
    "function withdraw(uint256 wad) external",
    "function balanceOf(address account) view returns (uint256)", // Kita tambah ini untuk ngecek
  ];

  const weth = new ethers.Contract(WETH_ADDRESS, WETH_ABI, deployer);
  console.log(`Jaringan: ${suffix}`);
  if ((await ethers.provider.getCode(WETH_ADDRESS)) === "0x") {
    throw new Error(`WITHDRAW_WETH_ADDRESS_${suffix} bukan kontrak di jaringan ini.`);
  }

  // 1. Cek saldo WETH Anda yang asli di blockchain saat ini
  const saldoWETH = await weth.balanceOf(deployer.address);
  console.log(
    `Saldo WETH Anda saat ini: ${ethers.formatEther(saldoWETH)} WETH`,
  );

  if (saldoWETH == 0n) {
    console.log("❌ Saldo WETH Anda kosong. Tidak ada yang bisa ditarik!");
    return;
  }

  // 2. Tarik semua saldo yang tersisa (tidak dipaksa 12 lagi agar tidak eror)
  console.log(`Menarik ${ethers.formatEther(saldoWETH)} POL dari WETH...`);

  const tx = await weth.withdraw(saldoWETH, {
    gasPrice: ethers.parseUnits(gasPriceGwei, "gwei"),
  });

  console.log("-> Transaksi terkirim! Hash:", tx.hash);
  await tx.wait();
  console.log("✅ Berhasil menarik sisa sisa WETH ke POL native.");
}

main().catch((error) => {
  console.error("Withdraw WPOL gagal:", error);
  process.exitCode = 1;
});
