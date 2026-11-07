const hre = require("hardhat");
const { ethers } = hre;

const { assertConfiguredNetwork, requiredNetworkEnv } = require("./utils/networkEnv.cjs");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const lpManagerAddress = ethers.getAddress(requiredNetworkEnv(hre, "SURPSIDY_LP_MANAGER"));
  const payPalConfigValues = [
    process.env[`LP_MANAGER_PAYPAL_RELAYER_${suffix}`]?.trim(),
    process.env[`LP_MANAGER_PAYPAL_MAX_PER_TX_${suffix}`]?.trim(),
    process.env[`LP_MANAGER_PAYPAL_DAILY_LIMIT_${suffix}`]?.trim(),
  ];
  const liquidityConfigValues = [
    process.env[`LP_MANAGER_ADD_LIQ_POSITION_MANAGER_${suffix}`]?.trim(),
    process.env[`LP_MANAGER_ADD_LIQ_PAIR_TOKEN_${suffix}`]?.trim(),
  ];
  let payPalConfig;
  if (payPalConfigValues.every(Boolean)) {
    const [relayerValue, maxValue, dailyValue] = payPalConfigValues;
    if (!ethers.isAddress(relayerValue)) {
      throw new Error(`LP_MANAGER_PAYPAL_RELAYER_${suffix} harus berupa alamat valid.`);
    }
    if (!/^\d+$/.test(maxValue) || !/^\d+$/.test(dailyValue)) {
      throw new Error(`Batas payout PayPal ${suffix} harus bilangan bulat dalam unit terkecil SRP.`);
    }
    const relayer = ethers.getAddress(relayerValue);
    const maxPerTransaction = BigInt(maxValue);
    const dailyLimit = BigInt(dailyValue);
    const disabling = relayer === ethers.ZeroAddress && maxPerTransaction === 0n && dailyLimit === 0n;
    if (
      !disabling &&
      (relayer === ethers.ZeroAddress || maxPerTransaction === 0n || dailyLimit < maxPerTransaction)
    ) {
      throw new Error(
        `Konfigurasi PayPal ${suffix} tidak valid: alamat relayer harus aktif dan batas harian >= batas per transaksi > 0, atau gunakan alamat nol dan kedua batas nol untuk menonaktifkan.`,
      );
    }
    payPalConfig = { relayer, maxPerTransaction, dailyLimit };
  } else if (payPalConfigValues.some(Boolean)) {
    throw new Error(
      `Isi LP_MANAGER_PAYPAL_RELAYER_${suffix}, LP_MANAGER_PAYPAL_MAX_PER_TX_${suffix}, dan LP_MANAGER_PAYPAL_DAILY_LIMIT_${suffix}, atau kosongkan semuanya.`,
    );
  }

  const targets = [
    {
      envName: "CONTRACT_ADDRESS",
      roleName: "subsidizer",
      method: "setSubsidizer",
    },
    {
      envName: "INVESTOR_SALE_ADDRESS",
      roleName: "investorSale",
      method: "setInvestorSale",
    },
  ];
  const signer = (await ethers.getSigners())[0];
  if (!signer) throw new Error("Signer tidak tersedia; isi PRIVATE_KEY di .env.");

  const lpManagerCode = await ethers.provider.getCode(lpManagerAddress);
  if (lpManagerCode === "0x") {
    throw new Error(`SURPSIDY_LP_MANAGER_${suffix} bukan kontrak di jaringan ${suffix}.`);
  }

  const lpManager = new ethers.Contract(
    lpManagerAddress,
    [
      "function owner() view returns (address)",
      "function token() view returns (address)",
      "function subsidizer() view returns (address)",
      "function investorSale() view returns (address)",
      "function payPalRelayer() view returns (address)",
      "function maxPayPalPayoutPerTransaction() view returns (uint256)",
      "function dailyPayPalPayoutLimit() view returns (uint256)",
      "function liquidityPositionManager() view returns (address)",
      "function liquidityPairToken() view returns (address)",
      "function setSubsidizer(address)",
      "function setInvestorSale(address)",
      "function setPayPalPayoutConfig(address,uint256,uint256)",
      "function setLiquidityConfig(address,address)",
    ],
    signer,
  );
  const configured = {};
  const lpManagerToken = await lpManager.token();
  const srpAddress = process.env[`SRP_TOKEN_${suffix}`]?.trim();
  if (srpAddress && ethers.getAddress(srpAddress).toLowerCase() !== lpManagerToken.toLowerCase()) {
    throw new Error(`SURPSIDY_LP_MANAGER_${suffix} memakai token berbeda dari SRP_TOKEN_${suffix}.`);
  }

  const pendingOperations = [];
  for (const target of targets) {
    const targetAddressValue = process.env[`${target.envName}_${suffix}`]?.trim();
    if (!targetAddressValue) {
      configured[target.roleName] = await lpManager[target.roleName]();
      console.log(`Lewati ${target.roleName}: ${target.envName}_${suffix} belum diisi.`);
      continue;
    }

    const targetAddress = ethers.getAddress(targetAddressValue);
    if (targetAddress === ethers.ZeroAddress) {
      throw new Error(`${target.envName}_${suffix} tidak boleh zero address.`);
    }
    if ((await ethers.provider.getCode(targetAddress)) === "0x") {
      throw new Error(`${target.envName}_${suffix} bukan kontrak di jaringan ${suffix}.`);
    }
    const targetContract = new ethers.Contract(
      targetAddress,
      ["function lpManager() view returns (address)"],
      ethers.provider,
    );
    const linkedLPManager = await targetContract.lpManager();
    if (linkedLPManager.toLowerCase() !== lpManagerAddress.toLowerCase()) {
      throw new Error(
        `${target.envName}_${suffix} memakai LPManager ${linkedLPManager}, bukan ${lpManagerAddress}.`,
      );
    }

    const currentAddress = await lpManager[target.roleName]();
    if (currentAddress.toLowerCase() !== targetAddress.toLowerCase()) {
      pendingOperations.push({
        ...target,
        targetAddress,
        args: [targetAddress],
        confirm: async () =>
          (await lpManager[target.roleName]()).toLowerCase() === targetAddress.toLowerCase(),
      });
    } else {
      console.log(`${target.roleName} sudah benar: ${targetAddress}`);
    }
    configured[target.roleName] = targetAddress;
  }

  if (payPalConfig) {
    const [currentRelayer, currentMax, currentDaily] = await Promise.all([
      lpManager.payPalRelayer(),
      lpManager.maxPayPalPayoutPerTransaction(),
      lpManager.dailyPayPalPayoutLimit(),
    ]);
    if (
      currentRelayer.toLowerCase() !== payPalConfig.relayer.toLowerCase() ||
      currentMax !== payPalConfig.maxPerTransaction ||
      currentDaily !== payPalConfig.dailyLimit
    ) {
      pendingOperations.push({
        roleName: "PayPal payout config",
        method: "setPayPalPayoutConfig",
        args: [
          payPalConfig.relayer,
          payPalConfig.maxPerTransaction,
          payPalConfig.dailyLimit,
        ],
        confirm: async () =>
          (await lpManager.payPalRelayer()).toLowerCase() === payPalConfig.relayer.toLowerCase() &&
          (await lpManager.maxPayPalPayoutPerTransaction()) === payPalConfig.maxPerTransaction &&
          (await lpManager.dailyPayPalPayoutLimit()) === payPalConfig.dailyLimit,
      });
    } else {
      console.log("Konfigurasi payout PayPal sudah sesuai.");
    }
  } else {
    console.log("Lewati konfigurasi payout PayPal: variabelnya belum diisi.");
  }
  if (liquidityConfigValues.every(Boolean)) {
    const [positionManagerValue, pairTokenValue] = liquidityConfigValues;
    if (!ethers.isAddress(positionManagerValue) || !ethers.isAddress(pairTokenValue)) {
      throw new Error("Alamat Position Manager atau token pasangan untuk add-LP tidak valid.");
    }
    const positionManager = ethers.getAddress(positionManagerValue);
    const pairToken = ethers.getAddress(pairTokenValue);
    if (positionManager === ethers.ZeroAddress || pairToken === ethers.ZeroAddress) {
      throw new Error("Position Manager dan token pasangan add-LP tidak boleh zero address.");
    }
    if (
      (await ethers.provider.getCode(positionManager)) === "0x" ||
      (await ethers.provider.getCode(pairToken)) === "0x"
    ) {
      throw new Error("Position Manager dan token pasangan add-LP harus berupa kontrak di jaringan ini.");
    }
    const surpSwapFactory = ethers.getAddress(
      requiredNetworkEnv(hre, "SURPSWAP_V3_FACTORY"),
    );
    if ((await ethers.provider.getCode(surpSwapFactory)) === "0x") {
      throw new Error(`SurpSwap factory bukan kontrak di ${suffix}: ${surpSwapFactory}`);
    }
    const positionManagerContract = new ethers.Contract(
      positionManager,
      ["function factory() view returns (address)"],
      ethers.provider,
    );
    if ((await positionManagerContract.factory()).toLowerCase() !== surpSwapFactory.toLowerCase()) {
      throw new Error(`Position Manager ${positionManager} tidak menggunakan SurpSwap factory ${surpSwapFactory}.`);
    }
    if (pairToken.toLowerCase() === lpManagerToken.toLowerCase()) {
      throw new Error("Token pasangan add-LP tidak boleh sama dengan token SRP LPManager.");
    }

    const [currentPositionManager, currentPairToken] = await Promise.all([
      lpManager.liquidityPositionManager(),
      lpManager.liquidityPairToken(),
    ]);
    if (
      currentPositionManager.toLowerCase() !== positionManager.toLowerCase() ||
      currentPairToken.toLowerCase() !== pairToken.toLowerCase()
    ) {
      pendingOperations.push({
        roleName: "add-LP config",
        method: "setLiquidityConfig",
        args: [positionManager, pairToken],
        confirm: async () =>
          (await lpManager.liquidityPositionManager()).toLowerCase() === positionManager.toLowerCase() &&
          (await lpManager.liquidityPairToken()).toLowerCase() === pairToken.toLowerCase(),
      });
    } else {
      console.log("Konfigurasi add-LP sudah sesuai.");
    }
  } else if (liquidityConfigValues.some(Boolean)) {
    throw new Error(
      `Isi LP_MANAGER_ADD_LIQ_POSITION_MANAGER_${suffix} dan LP_MANAGER_ADD_LIQ_PAIR_TOKEN_${suffix}, atau kosongkan keduanya.`,
    );
  } else {
    console.log("Lewati konfigurasi add-LP: variabelnya belum diisi.");
  }

  if (
    !targets.some((target) => process.env[`${target.envName}_${suffix}`]?.trim()) &&
    !payPalConfig &&
    !liquidityConfigValues.some(Boolean)
  ) {
    throw new Error(
      `Isi alamat hasil deploy di deployments/${suffix.toLowerCase()}.json atau konfigurasi payout PayPal sebelum konfigurasi LPManager.`,
    );
  }
  if (pendingOperations.length > 0) {
    const owner = await lpManager.owner();
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      const calldata = pendingOperations.map((target) => ({
        role: target.roleName,
        to: lpManagerAddress,
        data: lpManager.interface.encodeFunctionData(target.method, target.args),
      }));
      console.error(`Signer ${signer.address} bukan owner LPManager; owner saat ini ${owner}.`);
      console.error("Minta owner menjalankan transaksi berikut melalui Safe:");
      console.error(JSON.stringify(calldata, null, 2));
      throw new Error("Konfigurasi LPManager tidak dijalankan karena signer bukan owner.");
    }

    for (const target of pendingOperations) {
      const tx = await lpManager[target.method](...target.args);
      await tx.wait();
      if (!(await target.confirm())) {
        throw new Error(`LPManager gagal mengatur ${target.roleName}.`);
      }
      if (target.targetAddress) configured[target.roleName] = target.targetAddress;
      persistNetworkEnv(hre, {
        LP_MANAGER_SUBSIDIZER: await lpManager.subsidizer(),
        LP_MANAGER_INVESTOR_SALE: await lpManager.investorSale(),
      });
      console.log(`${target.method}(${target.targetAddress}) berhasil: ${tx.hash}`);
    }
  }

  persistNetworkEnv(hre, {
    LP_MANAGER_SUBSIDIZER: configured.subsidizer,
    LP_MANAGER_INVESTOR_SALE: configured.investorSale,
  });
  console.log(
    pendingOperations.length > 0
      ? "Konfigurasi LPManager selesai."
      : "LPManager sudah sesuai; tidak ada transaksi baru.",
  );
}

main().catch((error) => {
  console.error("GAGAL konfigurasi LPManager:", error);
  process.exitCode = 1;
});
