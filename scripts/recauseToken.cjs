const { randomBytes } = require("node:crypto");
const hre = require("hardhat");
const { ethers } = hre;
const {
  assertConfiguredNetwork,
  networkEnv,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");

const MANAGER_ABI = [
  "function token() view returns (address)",
  "function payPalRelayer() view returns (address)",
  "function maxPayPalPayoutPerTransaction() view returns (uint256)",
  "function dailyPayPalPayoutLimit() view returns (uint256)",
  "function dailyPayPalPayoutDay() view returns (uint256)",
  "function dailyPayPalPayoutUsed() view returns (uint256)",
  "function releaseForPayPal(bytes32 paymentId,address to,uint256 amount)",
];
const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

function payoutAmount(balance, maxPerTransaction, dailyLimit, dailyUsed) {
  const remainingDaily = dailyLimit > dailyUsed ? dailyLimit - dailyUsed : 0n;
  return [balance, maxPerTransaction, remainingDaily].reduce((minimum, value) =>
    value < minimum ? value : minimum,
  );
}

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const tokenAddress = ethers.getAddress(
    networkEnv(hre, "RESCUE_TOKEN_ADDRESS") || requiredNetworkEnv(hre, "SRP_TOKEN"),
  );
  const allManagerConfigs = [
    {
      label: "LPManager",
      envName: "CORE_SURPZERO_LP_MANAGER",
      relayerKeyEnv: "LP_MANAGER_PAYPAL_RELAYER_PRIVATE_KEY",
      amountEnvName: "RESCUE_LP_AMOUNT",
    },
    {
      label: "P2EManager",
      envName: "CORE_SURPZERO_P2E_MANAGER",
      relayerKeyEnv: "P2E_MANAGER_PAYPAL_RELAYER_PRIVATE_KEY",
      amountEnvName: "RESCUE_P2E_AMOUNT",
    },
  ];
  const selectedManager = process.env.RESCUE_MANAGER || "LPManager";
  const managerConfigs = allManagerConfigs.filter(({ label }) => label === selectedManager);
  if (managerConfigs.length !== 1) {
    throw new Error(`RESCUE_MANAGER tidak dikenal: ${selectedManager}. Pilih LPManager atau P2EManager.`);
  }

  if ((await ethers.provider.getCode(tokenAddress)) === "0x") {
    throw new Error(`Alamat token bukan kontrak di network ${suffix}: ${tokenAddress}`);
  }

  const candidates = [];
  for (const [name, privateKey] of [
    ["PRIVATE_KEY", process.env.PRIVATE_KEY?.trim()],
    ...managerConfigs.map(({ relayerKeyEnv }) => [
      relayerKeyEnv,
      process.env[relayerKeyEnv]?.trim(),
    ]),
  ]) {
    if (!privateKey) continue;
    const wallet = new ethers.Wallet(privateKey, ethers.provider);
    if (!candidates.some((candidate) => candidate.address.toLowerCase() === wallet.address.toLowerCase())) {
      candidates.push({ address: wallet.address, wallet, source: name });
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      `Private key relayer belum diisi. Isi ${managerConfigs[0].relayerKeyEnv}, atau PRIVATE_KEY jika cocok dengan relayer.`,
    );
  }

  const token = new ethers.Contract(tokenAddress, TOKEN_ABI, ethers.provider);
  const tokenDecimals = await token.decimals();
  const configuredAmount = managerConfigs[0].amountEnvName
    ? networkEnv(hre, managerConfigs[0].amountEnvName)
    : undefined;
  if (managerConfigs[0].amountEnvName && !configuredAmount) {
    throw new Error(
      `${managerConfigs[0].amountEnvName}_${suffix} belum diisi. Tentukan jumlah SRP yang ingin ditarik.`,
    );
  }
  const requestedAmount = configuredAmount
    ? ethers.parseUnits(configuredAmount, tokenDecimals)
    : undefined;
  if (requestedAmount !== undefined && requestedAmount <= 0n) {
    throw new Error(`${managerConfigs[0].amountEnvName} harus lebih besar dari nol.`);
  }
  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Gagal membaca block terbaru.");
  const currentDay = BigInt(Math.floor(latestBlock.timestamp / 86400));
  const payouts = [];

  for (const config of managerConfigs) {
    const managerAddress = ethers.getAddress(requiredNetworkEnv(hre, config.envName));
    if ((await ethers.provider.getCode(managerAddress)) === "0x") {
      throw new Error(`${config.label} bukan kontrak di jaringan ${suffix}: ${managerAddress}`);
    }

    const manager = new ethers.Contract(managerAddress, MANAGER_ABI, ethers.provider);
    const [
      managerToken,
      relayerAddress,
      maxPerTransaction,
      dailyLimit,
      lastPayoutDay,
      dailyUsed,
      balance,
    ] = await Promise.all([
      manager.token(),
      manager.payPalRelayer(),
      manager.maxPayPalPayoutPerTransaction(),
      manager.dailyPayPalPayoutLimit(),
      manager.dailyPayPalPayoutDay(),
      manager.dailyPayPalPayoutUsed(),
      token.balanceOf(managerAddress),
    ]);

    if (managerToken.toLowerCase() !== tokenAddress.toLowerCase()) {
      throw new Error(`${config.label} menyimpan token ${managerToken}, bukan RESCUE_TOKEN ${tokenAddress}.`);
    }
    if (relayerAddress === ethers.ZeroAddress) {
      throw new Error(`Relayer ${config.label} belum dikonfigurasi.`);
    }
    const signer = candidates.find(
      (candidate) => candidate.address.toLowerCase() === relayerAddress.toLowerCase(),
    );
    if (!signer) {
      throw new Error(
        `Private key untuk relayer ${config.label} (${relayerAddress}) tidak tersedia. Isi ${config.relayerKeyEnv}.`,
      );
    }
    if (maxPerTransaction === 0n || dailyLimit === 0n) {
      throw new Error(`Batas payout ${config.label} nol; payout relayer tidak aktif.`);
    }

    const usedToday = lastPayoutDay === currentDay ? dailyUsed : 0n;
    const availableAmount = payoutAmount(balance, maxPerTransaction, dailyLimit, usedToday);
    if (requestedAmount !== undefined && requestedAmount > availableAmount) {
      throw new Error(
        `Jumlah rescue ${requestedAmount} melebihi saldo atau sisa cap payout ${config.label} (${availableAmount}).`,
      );
    }
    const amount = requestedAmount ?? availableAmount;
    payouts.push({
      ...config,
      managerAddress,
      relayerAddress,
      signer,
      manager: manager.connect(signer.wallet),
      balance,
      amount,
      dailyLimit,
      dailyUsed: usedToday,
    });
  }

  console.log(`Jaringan: ${suffix}; token: ${tokenAddress}`);
  for (const payout of payouts) {
    console.log(
      `${payout.label}: saldo=${payout.balance}, relayer=${payout.relayerAddress}, payout=${payout.amount}, sisa cap harian=${payout.dailyLimit - payout.dailyUsed}`,
    );
    if (payout.amount === 0n) {
      console.log(`${payout.label}: tidak ada saldo/cap harian yang bisa ditarik.`);
      continue;
    }
    const paymentId = ethers.hexlify(randomBytes(32));
    console.log(`${payout.label}: memanggil releaseForPayPal dengan paymentId ${paymentId}`);
    const tx = await payout.manager.releaseForPayPal(
      paymentId,
      payout.relayerAddress,
      payout.amount,
    );
    console.log(`${payout.label}: transaksi ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status !== 1) {
      throw new Error(`Payout rescue ${payout.label} gagal: ${tx.hash}`);
    }
    console.log(`${payout.label}: berhasil dikirim ke relayer ${payout.relayerAddress}.`);
  }
}

main().catch((error) => {
  console.error("Rescue token gagal:", error);
  process.exitCode = 1;
});
