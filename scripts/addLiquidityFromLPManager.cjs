const hre = require("hardhat");
const { ethers } = hre;
const { assertConfiguredNetwork, networkEnv, requiredNetworkEnv } = require("./utils/networkEnv.cjs");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");

const TOKEN_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function deposit() payable",
];
const FACTORY_ABI = [
  "function getPool(address,address,uint24) view returns (address)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function tickSpacing() view returns (int24)",
];
const MANAGER_ABI = [
  "function owner() view returns (address)",
  "function token() view returns (address)",
  "function payPalRelayer() view returns (address)",
  "function liquidityPositionManager() view returns (address)",
  "function liquidityPairToken() view returns (address)",
];
const POSITION_MANAGER_ABI = [
  "function factory() view returns (address)",
  "function mint(tuple(address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256,uint128,uint256,uint256)",
];

function required(name) {
  return requiredNetworkEnv(hre, name);
}

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const relayerPrivateKey =
    process.env.LP_MANAGER_PAYPAL_RELAYER_PRIVATE_KEY?.trim() ||
    process.env.PRIVATE_KEY?.trim();
  if (!relayerPrivateKey) {
    throw new Error(
      "Private key relayer belum diisi. Isi LP_MANAGER_PAYPAL_RELAYER_PRIVATE_KEY atau PRIVATE_KEY di .env.",
    );
  }
  const relayer = new ethers.Wallet(relayerPrivateKey, ethers.provider);

  const profileName = networkEnv(hre, "ADD_LIQ_PROFILE") || "wpol03";
  const profileValues = {
    wpol03: ["ADD_LIQ_TOKEN_A_WPOL", "ADD_LIQ_TOKEN_B_WPOL", "ADD_LIQ_AMOUNT_A_WPOL_03", "ADD_LIQ_AMOUNT_B_WPOL_03", "ADD_LIQ_FEE_WPOL_03"],
    wpol1: ["ADD_LIQ_TOKEN_A_WPOL", "ADD_LIQ_TOKEN_B_WPOL", "ADD_LIQ_AMOUNT_A_WPOL_1", "ADD_LIQ_AMOUNT_B_WPOL_1", "ADD_LIQ_FEE_WPOL_1"],
  }[profileName];
  if (!profileValues) throw new Error(`ADD_LIQ_PROFILE tidak dikenal: ${profileName}`);

  const [tokenAName, tokenBName, amountAName, amountBName, feeName] = profileValues;
  const tokenAddress = ethers.getAddress(required(tokenAName));
  const pairTokenAddress = ethers.getAddress(required(tokenBName));
  const amountSRPValue = required(amountAName);
  const amountPairValue = required(amountBName);
  const fee = Number(required(feeName));
  if (![100, 500, 3000, 10000].includes(fee)) {
    throw new Error(`Fee SurpSwap V3 tidak didukung: ${fee}.`);
  }

  const managerAddress = ethers.getAddress(required("SURPSIDY_LP_MANAGER"));
  const positionManagerAddress = ethers.getAddress(required("ADD_LIQ_POSITION_MANAGER"));
  const managerCode = await ethers.provider.getCode(managerAddress);
  if (managerCode === "0x") throw new Error(`LPManager bukan kontrak: ${managerAddress}`);

  const manager = new ethers.Contract(managerAddress, MANAGER_ABI, relayer);
  const [owner, managerToken, configuredRelayer, configuredPM, configuredPair] =
    await Promise.all([
      manager.owner(),
      manager.token(),
      manager.payPalRelayer(),
      manager.liquidityPositionManager(),
      manager.liquidityPairToken(),
    ]);
  if (configuredRelayer.toLowerCase() !== relayer.address.toLowerCase()) {
    throw new Error(
      `Signer relayer ${relayer.address} bukan relayer LPManager (${configuredRelayer}). Isi LP_MANAGER_PAYPAL_RELAYER_PRIVATE_KEY dengan private key yang sesuai.`,
    );
  }
  if (managerToken.toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new Error(`Token A ${tokenAddress} bukan token SRP LPManager (${managerToken}).`);
  }
  if (configuredPair.toLowerCase() !== pairTokenAddress.toLowerCase()) {
    throw new Error(`Token pasangan ${pairTokenAddress} belum diatur pada LPManager (${configuredPair}).`);
  }
  if (configuredPM.toLowerCase() !== positionManagerAddress.toLowerCase()) {
    throw new Error(
      `Position Manager ${positionManagerAddress} belum diatur pada LPManager (${configuredPM}).`,
    );
  }

  const [token, pairToken] = await Promise.all([
    new ethers.Contract(tokenAddress, TOKEN_ABI, relayer),
    new ethers.Contract(pairTokenAddress, TOKEN_ABI, relayer),
  ]);
  const [srpDecimals, pairDecimals, relayerSRPBalance, relayerPairBalance] = await Promise.all([
    token.decimals(),
    pairToken.decimals(),
    token.balanceOf(relayer.address),
    pairToken.balanceOf(relayer.address),
  ]);
  const amountSRP = ethers.parseUnits(amountSRPValue, srpDecimals);
  const amountPair = ethers.parseUnits(amountPairValue, pairDecimals);
  if (amountSRP <= 0n || amountPair <= 0n) {
    throw new Error("Jumlah SRP dan token pasangan harus lebih besar dari nol.");
  }
  if (relayerSRPBalance < amountSRP) {
    throw new Error("Saldo SRP di wallet relayer tidak mencukupi.");
  }
  if (relayerPairBalance < amountPair) {
    const wrappedNativeAddress = ethers.getAddress(required("WETH9"));
    if (pairTokenAddress.toLowerCase() !== wrappedNativeAddress.toLowerCase()) {
      throw new Error("Saldo token pasangan di wallet relayer tidak mencukupi.");
    }

    const amountToWrap = amountPair - relayerPairBalance;
    const [nativeBalance, feeData] = await Promise.all([
      ethers.provider.getBalance(relayer.address),
      ethers.provider.getFeeData(),
    ]);
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (gasPrice === null) throw new Error("Tidak bisa membaca estimasi harga gas jaringan.");
    const gasReserve = gasPrice * 750_000n;
    if (nativeBalance < amountToWrap + gasReserve) {
      throw new Error(
        `Saldo POL relayer tidak cukup untuk membungkus ${ethers.formatUnits(amountToWrap, pairDecimals)} WSRP dan membayar gas.`,
      );
    }

    console.log(
      `WSRP relayer kurang ${ethers.formatUnits(amountToWrap, pairDecimals)}; membungkus POL relayer menjadi WSRP...`,
    );
    const wrapTx = await pairToken.deposit({ value: amountToWrap });
    const wrapReceipt = await wrapTx.wait();
    if (wrapReceipt.status !== 1) {
      throw new Error(`Gagal membungkus POL menjadi WSRP: ${wrapTx.hash}`);
    }
    if ((await pairToken.balanceOf(relayer.address)) < amountPair) {
      throw new Error("Saldo WSRP relayer tetap tidak cukup setelah wrap POL.");
    }
  }

  const positionManager = new ethers.Contract(
    positionManagerAddress,
    POSITION_MANAGER_ABI,
    relayer,
  );
  const surpSwapFactory = ethers.getAddress(required("SURPSWAP_V3_FACTORY"));
  if ((await ethers.provider.getCode(surpSwapFactory)) === "0x") {
    throw new Error(`SurpSwap factory bukan kontrak di ${suffix}: ${surpSwapFactory}`);
  }
  if ((await positionManager.factory()).toLowerCase() !== surpSwapFactory.toLowerCase()) {
    throw new Error(`Position Manager ${positionManagerAddress} tidak menggunakan SurpSwap factory ${surpSwapFactory}.`);
  }
  const srpAllowance = await token.allowance(relayer.address, positionManagerAddress);
  if (srpAllowance < amountSRP) {
    console.log("Allowance SRP relayer belum cukup; memberi approval terbatas ke Position Manager...");
    const approval = await token.approve(positionManagerAddress, amountSRP);
    await approval.wait();
    if ((await token.allowance(relayer.address, positionManagerAddress)) < amountSRP) {
      throw new Error("Approval SRP dari wallet relayer gagal.");
    }
  }

  const pairAllowance = await pairToken.allowance(relayer.address, positionManagerAddress);
  if (pairAllowance < amountPair) {
    console.log("Allowance token pasangan relayer belum cukup; memberi approval terbatas ke Position Manager...");
    const approval = await pairToken.approve(positionManagerAddress, amountPair);
    await approval.wait();
    if ((await pairToken.allowance(relayer.address, positionManagerAddress)) < amountPair) {
      throw new Error("Approval token pasangan dari wallet relayer gagal.");
    }
  }

  const factoryAddress = await positionManager.factory();
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, ethers.provider);
  const token0 = tokenAddress.toLowerCase() < pairTokenAddress.toLowerCase()
    ? tokenAddress
    : pairTokenAddress;
  const token1 = token0 === tokenAddress ? pairTokenAddress : tokenAddress;
  const poolAddress = await factory.getPool(token0, token1, fee);
  if (poolAddress === ethers.ZeroAddress || (await ethers.provider.getCode(poolAddress)) === "0x") {
    throw new Error("Pool SurpSwap V3 belum tersedia; buat pool sebelum add-LP relayer.");
  }
  const pool = new ethers.Contract(poolAddress, POOL_ABI, ethers.provider);
  const [slot0, tickSpacing] = await Promise.all([pool.slot0(), pool.tickSpacing()]);
  if (slot0[0] === 0n) throw new Error("Pool belum diinisialisasi.");
  const spacing = Number(tickSpacing);
  const tickLower = Math.ceil(-887220 / spacing) * spacing;
  const tickUpper = Math.floor(887220 / spacing) * spacing;
  const amount0Desired = token0 === tokenAddress ? amountSRP : amountPair;
  const amount1Desired = token1 === tokenAddress ? amountSRP : amountPair;

  const minAmount = (name, desired) => {
    const configured = required(name);
    if (configured.toUpperCase() !== "AUTO") return BigInt(configured);
    const slippageBps = Number(required("ADD_LIQ_SLIPPAGE_BPS"));
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10000) {
      throw new Error("ADD_LIQ_SLIPPAGE_BPS harus integer antara 0 dan 9999.");
    }
    return (desired * BigInt(10000 - slippageBps)) / 10000n;
  };
  const amount0Min = minAmount("ADD_LIQ_MIN_AMOUNT0", amount0Desired);
  const amount1Min = minAmount("ADD_LIQ_MIN_AMOUNT1", amount1Desired);
  if (
    amount0Min < 0n || amount1Min < 0n ||
    amount0Min > amount0Desired || amount1Min > amount1Desired
  ) {
    throw new Error("Minimum amount tidak valid untuk jumlah add-LP.");
  }
  const deadlineSeconds = Number(required("ADD_LIQ_DEADLINE_SECONDS"));
  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds <= 0) {
    throw new Error("ADD_LIQ_DEADLINE_SECONDS harus bilangan bulat positif.");
  }
  const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;

  console.log(`Sumber SRP dan token pasangan: relayer ${relayer.address}; LP NFT recipient: ${owner}`);
  console.log(`Pool: ${poolAddress}; SRP: ${amountSRPValue}; token pasangan: ${amountPairValue}`);
  const mintParams = {
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min,
    amount1Min,
    recipient: owner,
    deadline,
  };
  await positionManager.mint.staticCall(mintParams);
  const tx = await positionManager.mint(mintParams);
  console.log(`Transaksi add-LP relayer: ${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`Transaksi add-LP gagal: ${tx.hash}`);
  for (const tokenContract of [token, pairToken]) {
    if ((await tokenContract.allowance(relayer.address, positionManagerAddress)) > 0n) {
      const approval = await tokenContract.approve(positionManagerAddress, 0n);
      await approval.wait();
    }
  }
  const matchesPair = (configuredTokenA, configuredTokenB) => {
    if (
      !configuredTokenA || !configuredTokenB ||
      !ethers.isAddress(configuredTokenA) || !ethers.isAddress(configuredTokenB)
    ) {
      return false;
    }
    return (
      (configuredTokenA.toLowerCase() === tokenAddress.toLowerCase() &&
        configuredTokenB.toLowerCase() === pairTokenAddress.toLowerCase()) ||
      (configuredTokenA.toLowerCase() === pairTokenAddress.toLowerCase() &&
        configuredTokenB.toLowerCase() === tokenAddress.toLowerCase())
    );
  };

  let surpSidyPoolOutput;
  const fee03 = Number(networkEnv(hre, "SURPSWAP_FEE_03"));
  const fee1 = Number(networkEnv(hre, "SURPSWAP_FEE_1"));
  if (matchesPair(networkEnv(hre, "SURPSIDY_TOKEN_SRP"), networkEnv(hre, "SURPSIDY_TOKEN_WETH9"))) {
    if (fee === fee03) surpSidyPoolOutput = "SURPSIDY_POOL_WETH9_03";
    if (fee === fee1) surpSidyPoolOutput = "SURPSIDY_POOL_WETH9_1";
  } else if (matchesPair(networkEnv(hre, "SURPSIDY_TOKEN_SRP"), networkEnv(hre, "SURPSIDY_TOKEN_B"))) {
    if (fee === fee03) surpSidyPoolOutput = "SURPSIDY_TOKEN_B_POOL_03";
    if (fee === fee1) surpSidyPoolOutput = "SURPSIDY_TOKEN_B_POOL_1";
  }

  const outputValues = { ADD_LIQ_POOL_ADDRESS: poolAddress };
  if (matchesPair(networkEnv(hre, "SURPSIDY_TOKEN_SRP"), networkEnv(hre, "SURPSIDY_TOKEN_WETH9"))) {
    outputValues.SRP_WETH9_POOL = poolAddress;
  }
  if (surpSidyPoolOutput) outputValues[surpSidyPoolOutput] = poolAddress;
  persistNetworkEnv(hre, outputValues);
  console.log(`Add-LP berhasil; posisi NFT dikirim ke Owner/Safe ${owner}.`);
  console.log(`Pool ${poolAddress} tersimpan di ADD_LIQ_POOL_ADDRESS_${suffix}.`);
  if (surpSidyPoolOutput) {
    console.log(`Pool SurpSidy otomatis disimpan ke ${surpSidyPoolOutput}_${suffix}.`);
  } else {
    console.log("Pasangan token tidak cocok dengan konfigurasi pool SurpSidy; hanya ADD_LIQ_POOL_ADDRESS yang diperbarui.");
  }
}

main().catch((error) => {
  console.error("Add-LP relayer gagal:", error);
  process.exitCode = 1;
});
