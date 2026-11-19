const hre = require("hardhat");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");

const TOKEN_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function globalState() view returns (uint160 price,int24 tick,uint16 fee,uint16 timepointIndex,uint8 communityFeeToken0,uint8 communityFeeToken1,bool unlocked)",
];
const UNISWAP_FACTORY_ABI = [
  "function getPool(address,address,uint24) view returns (address)",
  "function feeAmountTickSpacing(uint24) view returns (int24)",
];
const QUICKSWAP_FACTORY_ABI = [
  "function poolByPair(address,address) view returns (address)",
];
const UNISWAP_POSITION_MANAGER_ABI = [
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)",
];
const QUICKSWAP_POSITION_MANAGER_ABI = [
  "function createAndInitializePoolIfNecessary(address,address,uint160) payable returns (address)",
];
const HELPER_ABI = [
  "function UNISWAP_V3_POSITION_MANAGER() view returns (address)",
  "function QUICKSWAP_V3_POSITION_MANAGER() view returns (address)",
  "function addUniswapV3Liquidity((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) returns (uint256,uint128,uint256,uint256)",
  "function addQuickSwapV3Liquidity((address token0,address token1,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) returns (uint256,uint128,uint256,uint256)",
];
const PRICE_SCALE = 10n ** 18n;
const Q192 = 1n << 192n;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} harus diisi di config/networks/polygon.cjs.`);
  return value;
}

function integerSqrt(value) {
  if (value < 2n) return value;
  let estimate = 1n << BigInt((value.toString(2).length + 1) >> 1);
  while (true) {
    const next = (estimate + value / estimate) >> 1n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

function getInitialSqrtPriceX96(decimals0, decimals1) {
  const price = requiredEnv("DUAL_LP_INITIAL_PRICE_TOKEN1_PER_TOKEN0").trim();
  const priceX18 = hre.ethers.parseUnits(price, 18);
  if (priceX18 === 0n) {
    throw new Error("DUAL_LP_INITIAL_PRICE_TOKEN1_PER_TOKEN0 harus lebih besar dari nol.");
  }

  const numerator = priceX18 * (10n ** BigInt(decimals1)) * Q192;
  const denominator = PRICE_SCALE * (10n ** BigInt(decimals0));
  const sqrtPriceX96 = integerSqrt(numerator / denominator);
  if (sqrtPriceX96 <= MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new Error("Harga awal menghasilkan sqrtPriceX96 di luar rentang pool V3.");
  }
  return sqrtPriceX96;
}

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (hre.network.config.chainId !== 137 || network.chainId !== 137n) {
    throw new Error(`Skrip hanya mendukung Polygon mainnet (137); RPC chain ${network.chainId}.`);
  }

  const dex = requiredEnv("DUAL_LP_DEX").toLowerCase();
  if (dex !== "uniswap" && dex !== "quickswap") {
    throw new Error("DUAL_LP_DEX harus bernilai uniswap atau quickswap.");
  }

  const helperAddress = hre.ethers.getAddress(requiredEnv("DUAL_LP_HELPER_ADDRESS"));
  if ((await hre.ethers.provider.getCode(helperAddress)) === "0x") {
    throw new Error(`DUAL_LP_HELPER_ADDRESS bukan kontrak di Polygon: ${helperAddress}`);
  }
  const [signer] = await hre.ethers.getSigners();
  const token0Address = hre.ethers.getAddress(requiredEnv("DUAL_LP_TOKEN0"));
  const token1Address = hre.ethers.getAddress(requiredEnv("DUAL_LP_TOKEN1"));
  if (BigInt(token0Address) >= BigInt(token1Address)) {
    throw new Error("DUAL_LP_TOKEN0 harus memiliki alamat numerik lebih kecil daripada DUAL_LP_TOKEN1.");
  }

  const token0 = new hre.ethers.Contract(token0Address, TOKEN_ABI, signer);
  const token1 = new hre.ethers.Contract(token1Address, TOKEN_ABI, signer);
  const [decimals0, decimals1] = await Promise.all([token0.decimals(), token1.decimals()]);
  const amount0 = hre.ethers.parseUnits(requiredEnv("DUAL_LP_AMOUNT0"), decimals0);
  const amount1 = hre.ethers.parseUnits(requiredEnv("DUAL_LP_AMOUNT1"), decimals1);
  const slippageBps = Number(requiredEnv("DUAL_LP_SLIPPAGE_BPS"));
  if (![10, 50, 100].includes(slippageBps)) {
    throw new Error("DUAL_LP_SLIPPAGE_BPS harus 10 (0.1%), 50 (0.5%), atau 100 (1%).");
  }
  const minimumAmount = (envName, desired, decimals, slippageBps) => {
    const value = process.env[envName]?.trim();
    if (!value || value.toUpperCase() === "AUTO") {
      return (desired * BigInt(10000 - slippageBps)) / 10000n;
    }
    return hre.ethers.parseUnits(value, decimals);
  };

  const tickLower = Number(requiredEnv("DUAL_LP_TICK_LOWER"));
  const tickUpper = Number(requiredEnv("DUAL_LP_TICK_UPPER"));
  if (
    !Number.isInteger(tickLower) ||
    !Number.isInteger(tickUpper) ||
    tickLower >= tickUpper ||
    tickLower < -887272 ||
    tickUpper > 887272
  ) {
    throw new Error("DUAL_LP_TICK_LOWER/UPPER harus integer valid, lower < upper, dalam rentang -887272..887272.");
  }

  let poolAddress;
  let fee;
  let factory;
  if (dex === "uniswap") {
    fee = Number(requiredEnv("DUAL_LP_UNISWAP_FEE"));
    if (![100, 500, 3000, 10000].includes(fee)) {
      throw new Error("DUAL_LP_UNISWAP_FEE harus 100, 500, 3000, atau 10000.");
    }
    const factoryAddress = hre.ethers.getAddress(requiredEnv("DUAL_LP_UNISWAP_FACTORY"));
    factory = new hre.ethers.Contract(factoryAddress, UNISWAP_FACTORY_ABI, signer);
    poolAddress = await factory.getPool(token0Address, token1Address, fee);
  } else {
    const factoryAddress = hre.ethers.getAddress(requiredEnv("DUAL_LP_QUICKSWAP_FACTORY"));
    factory = new hre.ethers.Contract(factoryAddress, QUICKSWAP_FACTORY_ABI, signer);
    poolAddress = await factory.poolByPair(token0Address, token1Address);
  }

  const [balance0, balance1] = await Promise.all([
    token0.balanceOf(signer.address),
    token1.balanceOf(signer.address),
  ]);
  if (
    balance0 < amount0 || balance1 < amount1
  ) {
    throw new Error("Saldo wallet kurang dari jumlah likuiditas yang diminta.");
  }

  const deadlineSeconds = Number(process.env.DUAL_LP_DEADLINE_SECONDS || 600);
  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds <= 0 || deadlineSeconds > 1800) {
    throw new Error("DUAL_LP_DEADLINE_SECONDS harus integer antara 1 dan 1800.");
  }
  const amount0Min = minimumAmount("DUAL_LP_MIN_AMOUNT0", amount0, decimals0, slippageBps);
  const amount1Min = minimumAmount("DUAL_LP_MIN_AMOUNT1", amount1, decimals1, slippageBps);
  if (
    amount0 <= 0n || amount1 <= 0n ||
    amount0Min <= 0n || amount1Min <= 0n ||
    amount0Min > amount0 || amount1Min > amount1
  ) {
    throw new Error("Desired dan minimum amounts harus > 0; minimum tidak boleh melebihi desired.");
  }

  const helper = new hre.ethers.Contract(helperAddress, HELPER_ABI, signer);
  const positionManagerAddress = dex === "uniswap"
    ? await helper.UNISWAP_V3_POSITION_MANAGER()
    : await helper.QUICKSWAP_V3_POSITION_MANAGER();
  if ((await hre.ethers.provider.getCode(positionManagerAddress)) === "0x") {
    throw new Error(`Position manager ${dex} tidak memiliki bytecode: ${positionManagerAddress}`);
  }
  const positionManager = new hre.ethers.Contract(
    positionManagerAddress,
    dex === "uniswap"
      ? UNISWAP_POSITION_MANAGER_ABI
      : QUICKSWAP_POSITION_MANAGER_ABI,
    signer,
  );
  const createAndInitializePool = (sqrtPriceX96) => dex === "uniswap"
    ? positionManager.createAndInitializePoolIfNecessary(
      token0Address,
      token1Address,
      fee,
      sqrtPriceX96,
    )
    : positionManager.createAndInitializePoolIfNecessary(
      token0Address,
      token1Address,
      sqrtPriceX96,
    );

  let initialSqrtPriceX96;
  if (poolAddress === hre.ethers.ZeroAddress) {
    initialSqrtPriceX96 = getInitialSqrtPriceX96(decimals0, decimals1);
    console.log(
      `Membuat pool ${dex} pada harga ${process.env.DUAL_LP_INITIAL_PRICE_TOKEN1_PER_TOKEN0} token1 per token0.`,
    );
    if (dex === "uniswap") {
      const tickSpacing = await factory.feeAmountTickSpacing(fee);
      if (tickSpacing === 0n) {
        throw new Error(`Uniswap fee tier ${fee} belum diaktifkan.`);
      }
    }
    const tx = await createAndInitializePool(initialSqrtPriceX96);
    const receipt = await tx.wait();
    if (receipt.status !== 1) {
      throw new Error(`Pembuatan dan inisialisasi pool ${dex} gagal: ${tx.hash}`);
    }
    poolAddress = dex === "uniswap"
      ? await factory.getPool(token0Address, token1Address, fee)
      : await factory.poolByPair(token0Address, token1Address);
  }

  if (poolAddress === hre.ethers.ZeroAddress) {
    throw new Error(`Pool ${dex} tidak ditemukan setelah proses pembuatan dan inisialisasi.`);
  }
  if ((await hre.ethers.provider.getCode(poolAddress)) === "0x") {
    throw new Error(`Alamat pool ${dex} tidak memiliki bytecode: ${poolAddress}`);
  }

  const pool = new hre.ethers.Contract(poolAddress, POOL_ABI, signer);
  const [poolToken0, poolToken1] = await Promise.all([
    pool.token0(),
    pool.token1(),
  ]);
  if (
    poolToken0.toLowerCase() !== token0Address.toLowerCase() ||
    poolToken1.toLowerCase() !== token1Address.toLowerCase()
  ) {
    throw new Error(`Pasangan token pool ${poolAddress} tidak cocok.`);
  }

  const poolSqrtPriceX96 = dex === "uniswap"
    ? (await pool.slot0()).sqrtPriceX96
    : (await pool.globalState()).price;
  if (poolSqrtPriceX96 === 0n) {
    initialSqrtPriceX96 ??= getInitialSqrtPriceX96(decimals0, decimals1);
    console.log(
      `Menginisialisasi pool ${dex} pada harga ${process.env.DUAL_LP_INITIAL_PRICE_TOKEN1_PER_TOKEN0} token1 per token0.`,
    );
    const tx = await createAndInitializePool(initialSqrtPriceX96);
    const receipt = await tx.wait();
    if (receipt.status !== 1) {
      throw new Error(`Inisialisasi harga awal pool ${dex} gagal: ${tx.hash}`);
    }
  }

  const initializedSqrtPriceX96 = dex === "uniswap"
    ? (await pool.slot0()).sqrtPriceX96
    : (await pool.globalState()).price;
  if (initializedSqrtPriceX96 === 0n) {
    throw new Error(`Pool ${dex} masih belum memiliki harga awal.`);
  }
  if (
    initialSqrtPriceX96 !== undefined &&
    initializedSqrtPriceX96 !== initialSqrtPriceX96
  ) {
    throw new Error(`Pool ${dex} ternyata sudah diinisialisasi pada harga yang berbeda.`);
  }

  console.log(`DEX: ${dex}; pool: ${poolAddress}; LP NFT recipient: ${signer.address}`);
  console.log(
    `Slippage: ${slippageBps / 100}%; jumlah ${hre.ethers.formatUnits(amount0, decimals0)} / ${hre.ethers.formatUnits(amount1, decimals1)}.`,
  );
  console.log(`Ticks: ${tickLower}..${tickUpper}; deadline: ${deadlineSeconds} detik`);

  let call;
  if (dex === "uniswap") {
    call = {
      simulate: (params) => helper.addUniswapV3Liquidity.staticCall(params),
      send: (params) => helper.addUniswapV3Liquidity(params),
    };
  } else {
    call = {
      simulate: (params) => helper.addQuickSwapV3Liquidity.staticCall(params),
      send: (params) => helper.addQuickSwapV3Liquidity(params),
    };
  }

  const baseParams = {
    token0: token0Address,
    token1: token1Address,
    ...(dex === "uniswap" ? { fee } : {}),
    tickLower,
    tickUpper,
    amount0Desired: amount0,
    amount1Desired: amount1,
    recipient: signer.address,
  };
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  const params = { ...baseParams, amount0Min, amount1Min, deadline };
  console.log(
    `Minimum amounts: ${hre.ethers.formatUnits(amount0Min, decimals0)} / ${hre.ethers.formatUnits(amount1Min, decimals1)} (slippage ${slippageBps} bps untuk nilai AUTO)`,
  );

  console.log("Memberi approval terbatas kepada helper...");
  await (await token0.approve(helperAddress, amount0)).wait();
  await (await token1.approve(helperAddress, amount1)).wait();

  console.log("Simulasi mint LP...");
  await call.simulate(params);
  console.log("Simulasi berhasil; mengirim transaksi LP...");
  const tx = await call.send(params);
  console.log(`Transaksi LP: ${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    throw new Error(`Transaksi add-LP gagal/revert: ${tx.hash}`);
  }

  const configuredPairMatches = (nameA, nameB) => {
    const configuredA = process.env[nameA];
    const configuredB = process.env[nameB];
    if (!configuredA || !configuredB ||
        !hre.ethers.isAddress(configuredA) || !hre.ethers.isAddress(configuredB)) {
      return false;
    }
    return (
      (configuredA.toLowerCase() === token0Address.toLowerCase() &&
        configuredB.toLowerCase() === token1Address.toLowerCase()) ||
      (configuredA.toLowerCase() === token1Address.toLowerCase() &&
        configuredB.toLowerCase() === token0Address.toLowerCase())
    );
  };

  const outputValues = { ADD_LIQ_POOL_ADDRESS: poolAddress };
  if (dex === "uniswap") {
    let poolOutput;
    if (
      configuredPairMatches("SURPSIDY_TOKEN_SRP_POLYGON", "SURPSIDY_TOKEN_WETH9_POLYGON")
    ) {
      if (fee === Number(process.env.UNISWAP_FEE_03_POLYGON)) {
        poolOutput = "SURPSIDY_POOL_WETH9_03";
      } else if (fee === Number(process.env.UNISWAP_FEE_1_POLYGON)) {
        poolOutput = "SURPSIDY_POOL_WETH9_1";
      }
    } else if (configuredPairMatches("SURPSIDY_TOKEN_SRP_POLYGON", "SURPSIDY_TOKEN_B_POLYGON")) {
      if (fee === Number(process.env.UNISWAP_FEE_03_POLYGON)) {
        poolOutput = "SURPSIDY_TOKEN_B_POOL_03";
      } else if (fee === Number(process.env.UNISWAP_FEE_1_POLYGON)) {
        poolOutput = "SURPSIDY_TOKEN_B_POOL_1";
      }
    }
    if (poolOutput) outputValues[poolOutput] = poolAddress;
  }

  persistNetworkEnv(hre, outputValues);
  console.log("Pool add-LP otomatis disimpan ke constants Polygon: ADD_LIQ_POOL_ADDRESS_POLYGON.");
  const surpSidyPoolKey = Object.keys(outputValues).find((key) => key.startsWith("SURPSIDY_POOL_") || key.startsWith("SURPSIDY_TOKEN_B_POOL_"));
  if (surpSidyPoolKey) {
    console.log(`Pool SurpSidy otomatis disimpan ke ${surpSidyPoolKey}_POLYGON.`);
  } else if (dex === "quickswap") {
    console.log("QuickSwap pool disimpan sebagai ADD_LIQ_POOL_ADDRESS_POLYGON; pool ini tidak otomatis dikonfigurasi untuk SurpSidy.");
  } else {
    console.log("Pasangan/fee bukan pool SurpSidy yang dikenal; hanya output umum ADD_LIQ_POOL_ADDRESS_POLYGON diperbarui.");
  }
  console.log(`Likuiditas berhasil ditambahkan. Blok: ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error("Tambah likuiditas gagal:", error);
  process.exitCode = 1;
});
