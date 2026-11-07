const hre = require("hardhat");
const { ethers } = hre;

const { assertConfiguredNetwork, requiredNetworkEnv } = require("./utils/networkEnv.cjs");

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const managerAddress = ethers.getAddress(requiredNetworkEnv(hre, "P2E_MANAGER"));
  const values = [
    process.env[`P2E_MANAGER_PAYPAL_RELAYER_${suffix}`]?.trim(),
    process.env[`P2E_MANAGER_PAYPAL_MAX_PER_TX_${suffix}`]?.trim(),
    process.env[`P2E_MANAGER_PAYPAL_DAILY_LIMIT_${suffix}`]?.trim(),
  ];
  if (!values.every(Boolean)) {
    throw new Error(
      `Isi P2E_MANAGER_PAYPAL_RELAYER_${suffix}, P2E_MANAGER_PAYPAL_MAX_PER_TX_${suffix}, dan P2E_MANAGER_PAYPAL_DAILY_LIMIT_${suffix}. Gunakan zero address dan dua batas 0 untuk menonaktifkan.`,
    );
  }

  const [relayerValue, maxValue, dailyValue] = values;
  if (!ethers.isAddress(relayerValue) || !/^\d+$/.test(maxValue) || !/^\d+$/.test(dailyValue)) {
    throw new Error("Alamat relayer atau batas payout PayPal P2E tidak valid.");
  }
  const relayer = ethers.getAddress(relayerValue);
  const maxPerTransaction = BigInt(maxValue);
  const dailyLimit = BigInt(dailyValue);
  const disabling =
    relayer === ethers.ZeroAddress && maxPerTransaction === 0n && dailyLimit === 0n;
  if (
    !disabling &&
    (relayer === ethers.ZeroAddress ||
      maxPerTransaction === 0n ||
      dailyLimit < maxPerTransaction)
  ) {
    throw new Error(
      "Konfigurasi tidak valid: alamat relayer harus aktif dan batas harian >= batas per transaksi > 0, atau gunakan zero address dan kedua batas 0.",
    );
  }

  const code = await ethers.provider.getCode(managerAddress);
  if (code === "0x") {
    throw new Error(`P2E_MANAGER_${suffix} bukan kontrak di jaringan ${suffix}.`);
  }
  const signer = (await ethers.getSigners())[0];
  if (!signer) throw new Error("Signer tidak tersedia; isi PRIVATE_KEY di .env.");

  const manager = new ethers.Contract(
    managerAddress,
    [
      "function owner() view returns (address)",
      "function token() view returns (address)",
      "function payPalRelayer() view returns (address)",
      "function maxPayPalPayoutPerTransaction() view returns (uint256)",
      "function dailyPayPalPayoutLimit() view returns (uint256)",
      "function setPayPalPayoutConfig(address,uint256,uint256)",
    ],
    signer,
  );
  const tokenAddress = process.env[`SRP_TOKEN_${suffix}`]?.trim();
  if (
    tokenAddress &&
    ethers.getAddress(tokenAddress).toLowerCase() !== (await manager.token()).toLowerCase()
  ) {
    throw new Error(`P2E_MANAGER_${suffix} memakai token berbeda dari SRP_TOKEN_${suffix}.`);
  }

  const [currentRelayer, currentMax, currentDaily] = await Promise.all([
    manager.payPalRelayer(),
    manager.maxPayPalPayoutPerTransaction(),
    manager.dailyPayPalPayoutLimit(),
  ]);
  if (
    currentRelayer.toLowerCase() === relayer.toLowerCase() &&
    currentMax === maxPerTransaction &&
    currentDaily === dailyLimit
  ) {
    console.log("Konfigurasi payout PayPal P2E sudah sesuai.");
    return;
  }

  const owner = await manager.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    const data = manager.interface.encodeFunctionData("setPayPalPayoutConfig", [
      relayer,
      maxPerTransaction,
      dailyLimit,
    ]);
    console.error(`Signer ${signer.address} bukan owner P2EManager; owner saat ini ${owner}.`);
    console.error("Usulkan transaksi berikut melalui Safe:");
    console.error(JSON.stringify([{ to: managerAddress, data }], null, 2));
    throw new Error("Konfigurasi P2EManager tidak dijalankan karena signer bukan owner.");
  }

  const tx = await manager.setPayPalPayoutConfig(relayer, maxPerTransaction, dailyLimit);
  await tx.wait();
  if (
    (await manager.payPalRelayer()).toLowerCase() !== relayer.toLowerCase() ||
    (await manager.maxPayPalPayoutPerTransaction()) !== maxPerTransaction ||
    (await manager.dailyPayPalPayoutLimit()) !== dailyLimit
  ) {
    throw new Error("P2EManager gagal menerapkan konfigurasi payout PayPal.");
  }
  console.log(`setPayPalPayoutConfig berhasil: ${tx.hash}`);
}

main().catch((error) => {
  console.error("FATAL ERROR:", error);
  process.exit(1);
});
