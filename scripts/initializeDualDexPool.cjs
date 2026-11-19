const hre = require("hardhat");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");

const HELPER_ABI = [
  "function UNISWAP_V3_POSITION_MANAGER() view returns (address)",
  "function QUICKSWAP_V3_POSITION_MANAGER() view returns (address)",
];
const TOKEN_ABI = ["function decimals() view returns (uint8)"];
const UNISWAP_FACTORY_ABI = [
  "function getPool(address,address,uint24) view returns (address)",
  "function feeAmountTickSpacing(uint24) view returns (int24)",
];
const QUICKSWAP_FACTORY_ABI = [
  "function poolByPair(address,address) view returns (address)",
];
const UNISWAP_POSITION_MANAGER_ABI = [
  "function factory() view returns (address)",
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)",
];
const QUICKSWAP_POSITION_MANAGER_ABI = [
  "function factory() view returns (address)",
  "function createAndInitializePoolIfNecessary(address,address,uint160) payable returns (address)",
];
const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function globalState() view returns (uint160 price,int24 tick,uint16 fee,uint16 timepointIndex,uint8 communityFeeToken0,uint8 communityFeeToken1,bool unlocked)",
];
const PRICE_SCALE = 10n ** 18n;
const Q192 = 1n << 192n;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`${name} harus diisi di config/networks/polygon.cjs.`);
  }
  return value.trim();
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

function getInitialSqrtPriceX96(price, decimals0, decimals1) {
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

  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("Wallet tidak tersedia; konfigurasi signer lokal diperlukan.");

  const helperAddress = hre.ethers.getAddress(requiredEnv("DUAL_LP_HELPER_ADDRESS"));
  if ((await hre.ethers.provider.getCode(helperAddress)) === "0x") {
    throw new Error(`DUAL_LP_HELPER_ADDRESS bukan kontrak di Polygon: ${helperAddress}`);
  }
  const token0Address = hre.ethers.getAddress(requiredEnv("DUAL_LP_TOKEN0"));
  const token1Address = hre.ethers.getAddress(requiredEnv("DUAL_LP_TOKEN1"));
  if (BigInt(token0Address) >= BigInt(token1Address)) {
    throw new Error("DUAL_LP_TOKEN0 harus memiliki alamat numerik lebih kecil daripada DUAL_LP_TOKEN1.");
  }

  const [decimals0, decimals1] = await Promise.all([
    new hre.ethers.Contract(token0Address, TOKEN_ABI, hre.ethers.provider).decimals(),
    new hre.ethers.Contract(token1Address, TOKEN_ABI, hre.ethers.provider).decimals(),
  ]);
  const helper = new hre.ethers.Contract(helperAddress, HELPER_ABI, hre.ethers.provider);
  const positionManagerAddress = hre.ethers.getAddress(
    dex === "uniswap"
      ? await helper.UNISWAP_V3_POSITION_MANAGER()
      : await helper.QUICKSWAP_V3_POSITION_MANAGER(),
  );
  if ((await hre.ethers.provider.getCode(positionManagerAddress)) === "0x") {
    throw new Error(`Position manager ${dex} tidak memiliki bytecode: ${positionManagerAddress}`);
  }

  let fee;
  let factory;
  let poolAddress;
  let manager;
  if (dex === "uniswap") {
    fee = Number(requiredEnv("DUAL_LP_UNISWAP_FEE"));
    if (![100, 500, 3000, 10000].includes(fee)) {
      throw new Error("DUAL_LP_UNISWAP_FEE harus 100, 500, 3000, atau 10000.");
    }
    factory = new hre.ethers.Contract(
      hre.ethers.getAddress(requiredEnv("DUAL_LP_UNISWAP_FACTORY")),
      UNISWAP_FACTORY_ABI,
      signer,
    );
    manager = new hre.ethers.Contract(
      positionManagerAddress,
      UNISWAP_POSITION_MANAGER_ABI,
      signer,
    );
    if ((await manager.factory()).toLowerCase() !== (await factory.getAddress()).toLowerCase()) {
      throw new Error("Factory Uniswap tidak cocok dengan Position Manager helper.");
    }
    const tickSpacing = await factory.feeAmountTickSpacing(fee);
    if (tickSpacing === 0n) throw new Error(`Uniswap fee tier ${fee} belum diaktifkan.`);
    poolAddress = await factory.getPool(token0Address, token1Address, fee);
  } else {
    factory = new hre.ethers.Contract(
      hre.ethers.getAddress(requiredEnv("DUAL_LP_QUICKSWAP_FACTORY")),
      QUICKSWAP_FACTORY_ABI,
      signer,
    );
    manager = new hre.ethers.Contract(
      positionManagerAddress,
      QUICKSWAP_POSITION_MANAGER_ABI,
      signer,
    );
    if ((await manager.factory()).toLowerCase() !== (await factory.getAddress()).toLowerCase()) {
      throw new Error("Factory QuickSwap tidak cocok dengan Position Manager helper.");
    }
    poolAddress = await factory.poolByPair(token0Address, token1Address);
  }

  let pool;
  let currentSqrtPriceX96 = 0n;
  if (poolAddress !== hre.ethers.ZeroAddress) {
    if ((await hre.ethers.provider.getCode(poolAddress)) === "0x") {
      throw new Error(`Alamat pool ${dex} tidak memiliki bytecode: ${poolAddress}`);
    }
    pool = new hre.ethers.Contract(poolAddress, POOL_ABI, hre.ethers.provider);
    const [poolToken0, poolToken1] = await Promise.all([pool.token0(), pool.token1()]);
    if (
      poolToken0.toLowerCase() !== token0Address.toLowerCase() ||
      poolToken1.toLowerCase() !== token1Address.toLowerCase()
    ) {
      throw new Error(`Pasangan token pool ${poolAddress} tidak cocok.`);
    }
    currentSqrtPriceX96 = dex === "uniswap"
      ? (await pool.slot0()).sqrtPriceX96
      : (await pool.globalState()).price;
    if (currentSqrtPriceX96 !== 0n) {
      persistNetworkEnv(hre, { ADD_LIQ_POOL_ADDRESS: poolAddress });
      console.log(`Pool ${dex} sudah diinisialisasi: ${poolAddress}. Tidak ada transaksi dikirim.`);
      return;
    }
  }

  const initialPrice = requiredEnv("DUAL_LP_INITIAL_PRICE_TOKEN1_PER_TOKEN0");
  const initialSqrtPriceX96 = getInitialSqrtPriceX96(initialPrice, decimals0, decimals1);
  console.log(`Inisialisasi ${dex} pada harga ${initialPrice} token1 per token0.`);

  const tx = dex === "uniswap"
    ? await manager.createAndInitializePoolIfNecessary(
      token0Address,
      token1Address,
      fee,
      initialSqrtPriceX96,
    )
    : await manager.createAndInitializePoolIfNecessary(
      token0Address,
      token1Address,
      initialSqrtPriceX96,
    );
  console.log(`Transaksi init: ${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`Inisialisasi pool ${dex} gagal: ${tx.hash}`);

  poolAddress = dex === "uniswap"
    ? await factory.getPool(token0Address, token1Address, fee)
    : await factory.poolByPair(token0Address, token1Address);
  if (poolAddress === hre.ethers.ZeroAddress) {
    throw new Error(`Pool ${dex} tidak ditemukan setelah inisialisasi.`);
  }
  pool = new hre.ethers.Contract(poolAddress, POOL_ABI, hre.ethers.provider);
  currentSqrtPriceX96 = dex === "uniswap"
    ? (await pool.slot0()).sqrtPriceX96
    : (await pool.globalState()).price;
  if (currentSqrtPriceX96 === 0n) {
    throw new Error(`Pool ${dex} masih belum memiliki harga awal.`);
  }
  if (currentSqrtPriceX96 !== initialSqrtPriceX96) {
    throw new Error(`Pool ${dex} ternyata diinisialisasi pada harga berbeda.`);
  }

  persistNetworkEnv(hre, { ADD_LIQ_POOL_ADDRESS: poolAddress });
  console.log(`Pool ${dex} berhasil diinisialisasi: ${poolAddress}. Tidak ada LP yang ditambahkan.`);
}

main().catch((error) => {
  console.error("Inisialisasi pool gagal:", error);
  process.exitCode = 1;
});
