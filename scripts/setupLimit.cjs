const hre = require("hardhat");
const { ethers } = hre;
const {
  assertConfiguredNetwork,
  networkEnv,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");

// PRIVATE_KEY is shared and loaded from the common .env by Hardhat config.
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Validasi awal agar tidak error pas dieksekusi
if (!PRIVATE_KEY) {
  console.error(
    "❌ Error: Isi PRIVATE_KEY di .env.",
  );
  process.exit(1);
}

// ABI Fungsi Admin untuk Ubah Limit
const abi = [
  "function setSubsidyLimits(uint256 _maxTx, uint256 _maxDaily) external",
  "event ConfigOperationScheduled(bytes32 indexed operationId, uint256 indexed nonce, uint256 readyAt, bytes data)",
];

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const MAX_TX_LIMIT = networkEnv(hre, "SUBSIDY_MAX_TX");
  const MAX_DAILY_LIMIT = networkEnv(hre, "SUBSIDY_MAX_DAILY");
  if (!MAX_TX_LIMIT || !MAX_DAILY_LIMIT) {
    throw new Error(`SUBSIDY_MAX_TX_${suffix} dan SUBSIDY_MAX_DAILY_${suffix} wajib diisi di config/networks/${suffix.toLowerCase()}.cjs.`);
  }
  const maxTxRaw = ethers.parseEther(MAX_TX_LIMIT);
  const maxDailyRaw = ethers.parseEther(MAX_DAILY_LIMIT);
  if (maxTxRaw <= 0n || maxDailyRaw <= 0n) {
    throw new Error("Batas subsidi per transaksi dan per hari harus lebih besar dari nol.");
  }
  const contractAddress = requiredNetworkEnv(hre, "CONTRACT_ADDRESS");
  if (!ethers.isAddress(contractAddress)) {
    throw new Error(`CONTRACT_ADDRESS_${suffix} di deployments/${suffix.toLowerCase()}.json harus berupa alamat kontrak yang valid.`);
  }
  if ((await ethers.provider.getCode(contractAddress)) === "0x") {
    throw new Error(`CONTRACT_ADDRESS_${suffix} tidak memiliki bytecode pada network ${suffix}.`);
  }
  const wallet = new ethers.Wallet(PRIVATE_KEY, hre.ethers.provider);
  const contract = new ethers.Contract(contractAddress, abi, wallet);

  console.log("--------------------------------------------------");
  console.log(`Jaringan: ${suffix}`);
  console.log(`Mengirim perintah ke Smart Contract: ${contractAddress}`);
  console.log("Menjadwalkan perubahan limit subsidi menjadi:");
  console.log(`- Max Per Tx   : ${MAX_TX_LIMIT} SRP`);
  console.log(`- Max Per Hari : ${MAX_DAILY_LIMIT} SRP`);
  console.log("--------------------------------------------------");

  try {
    // Set batas sesuai jumlah token yang dikonfigurasi di .env.
    const tx = await contract.setSubsidyLimits(maxTxRaw, maxDailyRaw);

    console.log(`✉️ Transaksi berhasil dikirim ke Polygon ${suffix}!`);
    console.log(`Hash Transaksi: ${tx.hash}`);
    console.log("Menunggu konfirmasi block... ⏳");

    const receipt = await tx.wait();

    if (receipt.status === 1) {
      const scheduled = receipt.logs
        .map((log) => {
          try {
            return contract.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((event) => event?.name === "ConfigOperationScheduled");
      if (!scheduled) {
        throw new Error("Transaksi berhasil tetapi event ConfigOperationScheduled tidak ditemukan.");
      }

      console.log("\n✅ Jadwal limit subsidi berhasil dibuat.");
      console.log("Perubahan baru berlaku setelah jeda 24 jam dan pemanggilan executeConfig.");
      console.log(`Nonce: ${scheduled.args.nonce}`);
      console.log(`Data eksekusi: ${scheduled.args.data}`);
    } else {
      throw new Error("Transaksi gagal dieksekusi di blockchain (reverted).");
    }
  } catch (error) {
    console.error("\n💥 Terjadi Error:");
    if (error.reason) {
      console.error(`Alasan Gagal: ${error.reason}`);
    } else {
      console.error(error.message);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error("\n❌ Proses Gagal:", error);
  process.exitCode = 1;
});
