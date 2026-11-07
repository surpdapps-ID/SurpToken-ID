const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { assertConfiguredNetwork, requiredNetworkEnv } = require("./utils/networkEnv.cjs");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const filePath = path.join(ROOT, "deployments", `pending-surpsidy-${suffix.toLowerCase()}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Tidak ada jadwal tersimpan: deployments/pending-surpsidy-${suffix.toLowerCase()}.json.`);
  }

  const pending = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(pending)) {
    throw new Error(`File deployments/pending-surpsidy-${suffix.toLowerCase()}.json harus berisi array.`);
  }
  if (pending.length === 0) {
    console.log("Tidak ada konfigurasi SurpSidy yang menunggu eksekusi.");
    return;
  }

  const subsidizerAddress = requiredNetworkEnv(hre, "CONTRACT_ADDRESS");
  if (!hre.ethers.isAddress(subsidizerAddress) || subsidizerAddress === hre.ethers.ZeroAddress) {
    throw new Error(`CONTRACT_ADDRESS_${suffix} harus berupa alamat SurpSidy yang valid.`);
  }
  if ((await hre.ethers.provider.getCode(subsidizerAddress)) === "0x") {
    throw new Error(`SurpSidy ${subsidizerAddress} tidak memiliki bytecode di ${suffix}.`);
  }

  const currentBlock = await hre.ethers.provider.getBlock("latest");
  if (!currentBlock) throw new Error("Tidak dapat membaca timestamp block terbaru.");
  const now = BigInt(currentBlock.timestamp);
  const ready = [];
  const waiting = [];
  for (const item of pending) {
    if (
      !item ||
      !/^\d+$/.test(String(item.nonce)) ||
      !Number.isSafeInteger(Number(item.readyAt)) ||
      typeof item.data !== "string" ||
      !hre.ethers.isHexString(item.data)
    ) {
      throw new Error("Ada jadwal SurpSidy tersimpan dengan format tidak valid.");
    }
    if (now >= BigInt(item.readyAt)) ready.push(item);
    else waiting.push(item);
  }

  if (ready.length === 0) {
    const nextReadyAt = Math.min(...waiting.map((item) => Number(item.readyAt)));
    console.log(`Belum ada jadwal yang siap. Jadwal berikutnya siap pada ${new Date(nextReadyAt * 1000).toISOString()}.`);
    return;
  }

  const [signer] = await hre.ethers.getSigners();
  if (!signer) {
    throw new Error("Signer tidak tersedia; isi PRIVATE_KEY di .env.");
  }
  const subsidizer = new hre.ethers.Contract(
    subsidizerAddress,
    ["function executeConfig(uint256 nonce,bytes data) external"],
    signer,
  );

  const completedNonces = new Set();
  for (const item of ready) {
    console.log(`Mengeksekusi ${item.label} (nonce ${item.nonce})...`);
    const tx = await subsidizer.executeConfig(item.nonce, item.data);
    const receipt = await tx.wait();
    if (receipt.status !== 1) {
      throw new Error(`Eksekusi nonce ${item.nonce} gagal: ${tx.hash}`);
    }
    completedNonces.add(String(item.nonce));
    console.log(`Berhasil: ${tx.hash}`);
  }

  const remaining = pending.filter((item) => !completedNonces.has(String(item.nonce)));
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(remaining, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw new Error(`Transaksi berhasil tetapi gagal memperbarui daftar jadwal: ${error.message}`, { cause: error });
  }
}

main().catch((error) => {
  console.error("Eksekusi konfigurasi SurpSidy gagal:", error);
  process.exitCode = 1;
});
