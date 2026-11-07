const hre = require("hardhat");
const { ethers } = hre;

const { verifyDeployment } = require("./utils/verifyDeployment.cjs");
const { assertConfiguredNetwork } = require("./utils/networkEnv.cjs");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");

const CONTRACTS = {
  SurpZeroToken: "contracts/SurpZeroToken.sol:SurpZeroToken",
  LPManager: "contracts/LPManager.sol:LPManager",
  P2EManager: "contracts/P2EManager.sol:P2EManager",
  WETH9: "contracts/WETH9.sol:WETH9",
};

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const payPalConfigValues = [
    process.env[`LP_MANAGER_PAYPAL_RELAYER_${suffix}`]?.trim(),
    process.env[`LP_MANAGER_PAYPAL_MAX_PER_TX_${suffix}`]?.trim(),
    process.env[`LP_MANAGER_PAYPAL_DAILY_LIMIT_${suffix}`]?.trim(),
  ];
  let payPalConfig;
  if (payPalConfigValues.every(Boolean)) {
    const [relayerValue, maxPerTransactionValue, dailyLimitValue] = payPalConfigValues;
    if (!ethers.isAddress(relayerValue) || ethers.getAddress(relayerValue) === ethers.ZeroAddress) {
      throw new Error(`LP_MANAGER_PAYPAL_RELAYER_${suffix} harus berupa alamat wallet valid.`);
    }
    if (!/^\d+$/.test(maxPerTransactionValue) || !/^\d+$/.test(dailyLimitValue)) {
      throw new Error(`Batas payout PayPal ${suffix} harus bilangan bulat dalam unit terkecil SRP.`);
    }
    const maxPerTransaction = BigInt(maxPerTransactionValue);
    const dailyLimit = BigInt(dailyLimitValue);
    if (maxPerTransaction === 0n || dailyLimit < maxPerTransaction) {
      throw new Error(`Batas harian payout PayPal ${suffix} harus >= batas per transaksi dan keduanya > 0.`);
    }
    payPalConfig = {
      relayer: ethers.getAddress(relayerValue),
      maxPerTransaction,
      dailyLimit,
    };
  } else if (payPalConfigValues.some(Boolean)) {
    throw new Error(
      `Isi LP_MANAGER_PAYPAL_RELAYER_${suffix}, LP_MANAGER_PAYPAL_MAX_PER_TX_${suffix}, dan LP_MANAGER_PAYPAL_DAILY_LIMIT_${suffix}, atau kosongkan semuanya.`,
    );
  }
  const p2ePayPalConfigValues = [
    process.env[`P2E_MANAGER_PAYPAL_RELAYER_${suffix}`]?.trim(),
    process.env[`P2E_MANAGER_PAYPAL_MAX_PER_TX_${suffix}`]?.trim(),
    process.env[`P2E_MANAGER_PAYPAL_DAILY_LIMIT_${suffix}`]?.trim(),
  ];
  let p2ePayPalConfig;
  if (p2ePayPalConfigValues.every(Boolean)) {
    const [relayerValue, maxPerTransactionValue, dailyLimitValue] = p2ePayPalConfigValues;
    if (!ethers.isAddress(relayerValue) || ethers.getAddress(relayerValue) === ethers.ZeroAddress) {
      throw new Error(`P2E_MANAGER_PAYPAL_RELAYER_${suffix} harus berupa alamat wallet valid.`);
    }
    if (!/^\d+$/.test(maxPerTransactionValue) || !/^\d+$/.test(dailyLimitValue)) {
      throw new Error(`Batas payout PayPal P2E ${suffix} harus bilangan bulat dalam unit terkecil SRP.`);
    }
    const maxPerTransaction = BigInt(maxPerTransactionValue);
    const dailyLimit = BigInt(dailyLimitValue);
    if (maxPerTransaction === 0n || dailyLimit < maxPerTransaction) {
      throw new Error(`Batas harian payout PayPal P2E ${suffix} harus >= batas per transaksi dan keduanya > 0.`);
    }
    p2ePayPalConfig = {
      relayer: ethers.getAddress(relayerValue),
      maxPerTransaction,
      dailyLimit,
    };
  } else if (p2ePayPalConfigValues.some(Boolean)) {
    throw new Error(
      `Isi P2E_MANAGER_PAYPAL_RELAYER_${suffix}, P2E_MANAGER_PAYPAL_MAX_PER_TX_${suffix}, dan P2E_MANAGER_PAYPAL_DAILY_LIMIT_${suffix}, atau kosongkan semuanya.`,
    );
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("Signer tidak tersedia; isi PRIVATE_KEY di .env.");
  }
  console.log("==================================");
  console.log(`DEPLOY CORE - POLYGON ${suffix}`);
  console.log("Deployer:", deployer.address);
  console.log("==================================");

  // ===============================
  // DEPLOY HELPER
  // ===============================
  const deploy = async (name, args = []) => {
    const Contract = await ethers.getContractFactory(name);
    const contract = await Contract.deploy(...args);
    await contract.waitForDeployment();

    const address = await contract.getAddress();
    const addressUpdates = {
      SurpZeroToken: {
        CORE_SRP_TOKEN: address,
        SRP_TOKEN: address,
        SURPSIDY_TOKEN_SRP: address,
        ADD_LIQ_TOKEN_A_WPOL: address,
        WITHDRAW_SRP_TOKEN: address,
        CORE_SURPZERO_LP_MANAGER: "",
        CORE_SURPZERO_P2E_MANAGER: "",
        CORE_WETH9: "",
        WETH9: "",
        SURPSIDY_TOKEN_WETH9: "",
        SURPSIDY_LP_MANAGER: "",
        P2E_MANAGER: "",
        ADD_LIQ_LP_MANAGER: "",
        ADD_LIQ_LP_MANAGER_WPOL: "",
        WITHDRAW_SRP_LP_MANAGER: "",
        ADD_LIQ_POOL_ADDRESS: "",
        SRP_WETH9_POOL: "",
        SURPSIDY_POOL_WETH9_03: "",
        SURPSIDY_POOL_WETH9_1: "",
        SURPSIDY_TOKEN_B_POOL_03: "",
        SURPSIDY_TOKEN_B_POOL_1: "",
        CONTRACT_ADDRESS: "",
        INVESTOR_SALE_ADDRESS: "",
        LP_MANAGER_SUBSIDIZER: "",
        LP_MANAGER_INVESTOR_SALE: "",
        PUBLIC_STAKING_ADDRESS: "",
        INVESTOR_DIVIDEND_ADDRESS: "",
        SRP_SHOP_ADDRESS: "",
        NFT_COMMON_ADDRESS: "",
        NFT_RARE_ADDRESS: "",
        NFT_EPIC_ADDRESS: "",
        NFT_FLASH_ADDRESS: "",
        NFT_SCATTERY_ADDRESS: "",
        NFT_BRUSHVIOLET_ADDRESS: "",
      },
      WETH9: {
        CORE_WETH9: address,
        WETH9: address,
        SURPSIDY_TOKEN_WETH9: address,
        ADD_LIQ_TOKEN_B_WPOL: address,
        WITHDRAW_WETH_ADDRESS: address,
        ADD_LIQ_POOL_ADDRESS: "",
        SRP_WETH9_POOL: "",
        SURPSIDY_POOL_WETH9_03: "",
        SURPSIDY_POOL_WETH9_1: "",
      },
      LPManager: {
        CORE_SURPZERO_LP_MANAGER: address,
        SURPSIDY_LP_MANAGER: address,
        ADD_LIQ_LP_MANAGER: address,
        ADD_LIQ_LP_MANAGER_WPOL: address,
        WITHDRAW_SRP_LP_MANAGER: address,
      },
      P2EManager: {
        CORE_SURPZERO_P2E_MANAGER: address,
        P2E_MANAGER: address,
      },
    };
    const updates = addressUpdates[name];
    if (updates) persistNetworkEnv(hre, updates);
    console.log(`${name}: ${address}`);
    await verifyDeployment(hre, {
      address,
      constructorArguments: args,
      contract: CONTRACTS[name],
    });
    return contract;
  };

  // ===============================
  // TOKEN
  // ===============================
  const token = await deploy("SurpZeroToken");
  const tokenAddr = await token.getAddress();

  // ===============================
  // WETH
  // ===============================
  const weth = await deploy("WETH9");
  const wethAddr = await weth.getAddress();

  console.log("WETH:", wethAddr);

  // ===============================
  // MANAGER
  // ===============================
  const lpManager = await deploy("LPManager", [tokenAddr, wethAddr]);
  const p2eManager = await deploy("P2EManager", [tokenAddr]);
  const lpAddr = await lpManager.getAddress();
  const p2eAddr = await p2eManager.getAddress();

  if (payPalConfig) {
    await (
      await lpManager.setPayPalPayoutConfig(
        payPalConfig.relayer,
        payPalConfig.maxPerTransaction,
        payPalConfig.dailyLimit,
      )
    ).wait();
    console.log("Konfigurasi payout PayPal diterapkan saat deploy LPManager.");
  } else {
    console.log("Payout PayPal tidak diaktifkan; isi konfigurasi jaringan dan jalankan configure:lp-manager setelah deploy.");
  }
  if (p2ePayPalConfig) {
    await (
      await p2eManager.setPayPalPayoutConfig(
        p2ePayPalConfig.relayer,
        p2ePayPalConfig.maxPerTransaction,
        p2ePayPalConfig.dailyLimit,
      )
    ).wait();
    console.log("Konfigurasi payout PayPal diterapkan saat deploy P2EManager.");
  } else {
    console.log("Payout PayPal P2E tidak diaktifkan; isi konfigurasi jaringan dan jalankan configure:p2e-manager setelah deploy.");
  }

  console.log("Setting vaults...");

  await (await token.setVaults(lpAddr, p2eAddr)).wait();
  await (await token.distribute()).wait();

  console.log("✔ Token ready");

  console.log("==================================");
  console.log("DEPLOY COMPLETE 🚀");
  console.log("==================================");

  console.log("Standard Units Rupol (SRP):", tokenAddr);
  console.log("SurpZero LPManager:", lpAddr);
  console.log("SurpZero P2EManager:", p2eAddr);
  console.log("WETH:", wethAddr);

  console.log(`Setiap alamat core sudah diperbarui ke .env.${suffix.toLowerCase()} setelah kontrak masing-masing deploy.`);
  console.log(`SRP_TOKEN_${suffix}, P2E_MANAGER_${suffix}, dan konfigurasi token/manager SurpSidy diperbarui.`);
  console.log(`WETH9 / wrapped POL buatan project diperbarui di WETH9_${suffix} dan SURPSIDY_TOKEN_WETH9_${suffix}.`);
  console.log("WPOL resmi Polygon untuk dual LP dan swap tidak diubah.");
  console.log("Pool SurpSidy dan SRP/WETH9 lama dikosongkan karena tidak cocok dengan token baru; buat pool baru sebelum deploy SurpSidy.");
  console.log("Referensi pool, SurpSidy, InvestorSale, Shop, dan NFT lama dikosongkan karena terkait token lama.");
}

main().catch((e) => {
  console.error("FATAL ERROR:", e);
  process.exit(1);
});
