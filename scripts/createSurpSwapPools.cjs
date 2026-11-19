const hre = require("hardhat");
const { ethers } = hre;
const {
  assertConfiguredNetwork,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");

const POSITION_MANAGER_ABI = [
  "function factory() view returns (address)",
  "function createAndInitializePoolIfNecessary(address token0,address token1,uint24 fee,uint160 sqrtPriceX96) payable returns (address pool)",
];
const FACTORY_ABI = [
  "function feeAmountTickSpacing(uint24 fee) view returns (int24)",
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
];
const POOL_OUTPUTS = [
  { feeKey: "SURPSWAP_FEE_03", poolKey: "SURPSIDY_POOL_WETH9_03" },
  { feeKey: "SURPSWAP_FEE_1", poolKey: "SURPSIDY_POOL_WETH9_1" },
];
const PRICE_SCALE = 10n ** 18n;
const Q192 = 1n << 192n;
const CONFIRMATION_VARIABLE = "CONFIRM_CREATE_SURPSWAP_POOLS";

function integerSqrt(value) {
  if (value < 0n) throw new Error("Cannot calculate square root of a negative value.");
  if (value < 2n) return value;

  let estimate = 1n << BigInt((value.toString(2).length + 1) >> 1);
  while (true) {
    const next = (estimate + value / estimate) >> 1n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

function calculateSqrtPriceX96(priceX18, token0IsSrp, decimals0, decimals1) {
  const scale0 = 10n ** decimals0;
  const scale1 = 10n ** decimals1;
  const numerator = token0IsSrp ? priceX18 * scale0 : PRICE_SCALE * scale0;
  const denominator = token0IsSrp ? PRICE_SCALE * scale1 : priceX18 * scale1;
  const sqrtPriceX96 = integerSqrt((numerator * Q192) / denominator);
  if (sqrtPriceX96 === 0n || sqrtPriceX96 >= 1n << 160n) {
    throw new Error("Harga awal menghasilkan sqrtPriceX96 di luar rentang uint160.");
  }
  return sqrtPriceX96;
}

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  if (suffix !== "POLYGON") {
    throw new Error("Skrip ini hanya untuk Polygon mainnet.");
  }

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("Wallet tidak tersedia; konfigurasi signer lokal diperlukan.");

  const tokenSrp = ethers.getAddress(requiredNetworkEnv(hre, "SRP_TOKEN"));
  const tokenWeth = ethers.getAddress(requiredNetworkEnv(hre, "WETH9"));
  const factoryAddress = ethers.getAddress(requiredNetworkEnv(hre, "SURPSWAP_V3_FACTORY"));
  const positionManagerAddress = ethers.getAddress(requiredNetworkEnv(hre, "ADD_LIQ_POSITION_MANAGER"));
  const initialPrice = requiredNetworkEnv(hre, "SURPSWAP_INITIAL_PRICE_POL_PER_SRP");
  const priceX18 = ethers.parseUnits(initialPrice, 18);
  if (priceX18 === 0n) throw new Error("Harga awal harus lebih besar dari nol.");
  if (tokenSrp === tokenWeth) throw new Error("Alamat SRP dan WETH9 tidak boleh sama.");

  for (const [label, address] of [
    ["SRP", tokenSrp],
    ["WETH9 proyek", tokenWeth],
    ["SurpSwap Factory", factoryAddress],
    ["Position Manager", positionManagerAddress],
  ]) {
    if ((await ethers.provider.getCode(address)) === "0x") {
      throw new Error(`${label} tidak memiliki contract code di Polygon: ${address}`);
    }
  }

  const positionManager = new ethers.Contract(positionManagerAddress, POSITION_MANAGER_ABI, signer);
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, ethers.provider);
  if ((await positionManager.factory()).toLowerCase() !== factoryAddress.toLowerCase()) {
    throw new Error("Position Manager tidak menggunakan SurpSwap Factory yang dikonfigurasi.");
  }

  const token0IsSrp = BigInt(tokenSrp) < BigInt(tokenWeth);
  const token0 = token0IsSrp ? tokenSrp : tokenWeth;
  const token1 = token0IsSrp ? tokenWeth : tokenSrp;
  const token0Contract = new ethers.Contract(token0, ["function decimals() view returns (uint8)"], ethers.provider);
  const token1Contract = new ethers.Contract(token1, ["function decimals() view returns (uint8)"], ethers.provider);
  const [decimals0, decimals1] = await Promise.all([
    token0Contract.decimals(),
    token1Contract.decimals(),
  ]);
  const sqrtPriceX96 = calculateSqrtPriceX96(priceX18, token0IsSrp, decimals0, decimals1);
  const poolPlans = [];

  console.log(`Signer: ${signer.address}`);
  console.log(`Pasangan terurut: token0=${token0}, token1=${token1}`);
  console.log(`Harga awal: ${initialPrice} WETH9 per SRP`);
  console.log(`sqrtPriceX96: ${sqrtPriceX96}`);

  for (const { feeKey, poolKey } of POOL_OUTPUTS) {
    const fee = Number(requiredNetworkEnv(hre, feeKey));
    if (!Number.isSafeInteger(fee) || fee <= 0) {
      throw new Error(`${feeKey}_POLYGON harus berupa integer positif.`);
    }
    const tickSpacing = await factory.feeAmountTickSpacing(fee);
    if (tickSpacing === 0n) {
      throw new Error(`Fee tier ${fee} belum diaktifkan di SurpSwap Factory.`);
    }

    const existingPool = await factory.getPool(token0, token1, fee);
    if (existingPool !== ethers.ZeroAddress) {
      if ((await ethers.provider.getCode(existingPool)) === "0x") {
        throw new Error(`Factory mengembalikan pool tanpa contract code: ${existingPool}`);
      }
      const pool = new ethers.Contract(existingPool, POOL_ABI, ethers.provider);
      const { sqrtPriceX96: currentPrice } = await pool.slot0();
      if (currentPrice !== 0n && currentPrice !== sqrtPriceX96) {
        throw new Error(
          `Pool fee ${fee} sudah diinisialisasi pada harga berbeda (sqrtPriceX96 ${currentPrice}); harga pool tidak dapat diganti.`,
        );
      }
      if (currentPrice === sqrtPriceX96) {
        console.log(`Fee ${fee}: pool sudah siap di ${existingPool}; tidak perlu transaksi.`);
        poolPlans.push({ fee, poolKey, poolAddress: existingPool, needsInitialization: false });
        continue;
      }
    }

    const gasEstimate = await positionManager.createAndInitializePoolIfNecessary.estimateGas(
      token0,
      token1,
      fee,
      sqrtPriceX96,
    );
    const poolAddress = existingPool === ethers.ZeroAddress ? undefined : existingPool;
    console.log(
      `Fee ${fee}: ${poolAddress ? `inisialisasi pool ${poolAddress}` : "buat + inisialisasi pool"}; estimasi ${gasEstimate} gas.`,
    );
    poolPlans.push({ fee, poolKey, poolAddress, needsInitialization: true, gasEstimate });
  }

  const transactionsNeeded = poolPlans.filter(({ needsInitialization }) => needsInitialization).length;
  if (transactionsNeeded === 0) {
    console.log("Kedua pool sudah tersedia dan memakai harga awal yang diminta.");
  } else if (process.env[CONFIRMATION_VARIABLE] !== "YES") {
    console.log(`Belum ada transaksi dikirim. Untuk membuat/menginisialisasi ${transactionsNeeded} pool:`);
    console.log(`${CONFIRMATION_VARIABLE}=YES npm run create:surpswap-pools:polygon`);
    return;
  }

  for (const plan of poolPlans) {
    let poolAddress = plan.poolAddress;
    if (plan.needsInitialization) {
      const tx = await positionManager.createAndInitializePoolIfNecessary(
        token0,
        token1,
        plan.fee,
        sqrtPriceX96,
        { gasLimit: (plan.gasEstimate * 120n) / 100n },
      );
      console.log(`Fee ${plan.fee}: transaksi dikirim ${tx.hash}`);
      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error(`Transaksi pool fee ${plan.fee} gagal: ${tx.hash}`);
      poolAddress = await factory.getPool(token0, token1, plan.fee);
    }

    if (!poolAddress || poolAddress === ethers.ZeroAddress) {
      throw new Error(`Pool fee ${plan.fee} tidak ditemukan setelah transaksi.`);
    }
    const pool = new ethers.Contract(poolAddress, POOL_ABI, ethers.provider);
    const { sqrtPriceX96: actualPrice } = await pool.slot0();
    persistNetworkEnv(hre, { [plan.poolKey]: poolAddress });
    if (actualPrice !== sqrtPriceX96) {
      throw new Error(
        `Pool fee ${plan.fee} tersimpan di ${poolAddress}, tetapi harga aktual berbeda dari harga yang diminta.`,
      );
    }
    console.log(`Fee ${plan.fee}: pool siap di ${poolAddress}.`);
  }

  console.log("Pool fee 3000 dan 10000 sudah dibuat/diinisialisasi; likuiditas belum ditambahkan.");
}

main().catch((error) => {
  console.error("Pembuatan pool SurpSwap gagal:", error);
  process.exitCode = 1;
});
