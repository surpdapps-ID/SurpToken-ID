const hre = require("hardhat");
const { ethers } = hre;
const { assertConfiguredNetwork, requiredNetworkEnv } = require("./utils/networkEnv.cjs");

const LOCKER_ABI = [
  "function owner() view returns (address)",
  "function lockDuration() view returns (uint64)",
  "function setLockDuration(uint64 newDuration)",
];

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const lockerAddressValue = requiredNetworkEnv(hre, "LP_NFT_LOCKER_ADDRESS");
  if (!ethers.isAddress(lockerAddressValue) || lockerAddressValue === ethers.ZeroAddress) {
    throw new Error(`LP_NFT_LOCKER_ADDRESS_${suffix} harus berupa alamat valid.`);
  }
  const lockerAddress = ethers.getAddress(lockerAddressValue);

  const durationValue = requiredNetworkEnv(hre, "LP_NFT_LOCK_DURATION_SECONDS");
  if (!/^\d+$/.test(durationValue)) {
    throw new Error(`LP_NFT_LOCK_DURATION_SECONDS_${suffix} harus berupa integer detik.`);
  }
  const duration = BigInt(durationValue);
  if (duration === 0n || duration > (1n << 64n) - 1n) {
    throw new Error(`LP_NFT_LOCK_DURATION_SECONDS_${suffix} harus lebih besar dari nol dan muat dalam uint64.`);
  }

  if ((await ethers.provider.getCode(lockerAddress)) === "0x") {
    throw new Error(`LP_NFT_LOCKER_ADDRESS_${suffix} bukan kontrak di jaringan ini.`);
  }
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("Signer tidak tersedia; isi PRIVATE_KEY di .env.");

  const locker = new ethers.Contract(lockerAddress, LOCKER_ABI, signer);
  const [owner, currentDuration] = await Promise.all([
    locker.owner(),
    locker.lockDuration(),
  ]);
  if (currentDuration === duration) {
    console.log(`Durasi lock LP NFT sudah ${duration} detik.`);
    return;
  }

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    const data = locker.interface.encodeFunctionData("setLockDuration", [duration]);
    console.log(`Signer ${signer.address} bukan owner locker (owner: ${owner}).`);
    console.log("Ajukan transaksi ini melalui owner/Safe:");
    console.log(JSON.stringify({ to: lockerAddress, value: "0", data }, null, 2));
    return;
  }

  const tx = await locker.setLockDuration(duration);
  console.log(`Transaksi set durasi lock: ${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    throw new Error(`Transaksi set durasi lock gagal: ${tx.hash}`);
  }
  const updatedDuration = await locker.lockDuration();
  if (updatedDuration !== duration) {
    throw new Error("Verifikasi durasi locker gagal setelah transaksi.");
  }
  console.log(`Durasi lock LP NFT berhasil diubah menjadi ${duration} detik di ${suffix}.`);
}

main().catch((error) => {
  console.error("Gagal mengatur durasi lock LP NFT:", error);
  process.exitCode = 1;
});
