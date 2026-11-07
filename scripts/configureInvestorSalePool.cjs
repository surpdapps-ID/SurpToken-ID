const hre = require("hardhat");
const {
  assertConfiguredNetwork,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");

const TWAP_INTERVAL = 1800;

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const addressFromConfig = (name) => {
    const value = requiredNetworkEnv(hre, name);
    if (!hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
      throw new Error(`${name}_${suffix} harus berupa alamat valid.`);
    }
    return hre.ethers.getAddress(value);
  };

  const tokenAddress = addressFromConfig("SRP_TOKEN");
  const wrappedNative = addressFromConfig("WETH9");
  const investorSaleAddress = addressFromConfig("INVESTOR_SALE_ADDRESS");
  const poolAddress = addressFromConfig("SRP_WETH9_POOL");
  const surpSwapFactoryAddress = addressFromConfig("SURPSWAP_V3_FACTORY");
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("Deployer tidak tersedia; isi PRIVATE_KEY di .env.");

  for (const [label, address] of [
    ["SRP", tokenAddress],
    ["WETH9", wrappedNative],
    ["InvestorSale", investorSaleAddress],
    ["Pool SRP/WETH9", poolAddress],
  ]) {
    if ((await hre.ethers.provider.getCode(address)) === "0x") {
      throw new Error(`${label} ${address} tidak memiliki bytecode di ${suffix}.`);
    }
  }

  const pool = new hre.ethers.Contract(
    poolAddress,
    [
      "function token0() view returns (address)",
      "function token1() view returns (address)",
      "function factory() view returns (address)",
      "function observe(uint32[]) view returns (int56[],uint160[])",
    ],
    hre.ethers.provider,
  );
  const [token0, token1, factory] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.factory(),
  ]);
  if (factory.toLowerCase() !== surpSwapFactoryAddress.toLowerCase()) {
    throw new Error(`SRP_WETH9_POOL_${suffix} bukan pool dari SurpSwap factory ${surpSwapFactoryAddress}.`);
  }
  const expectedToken0 = BigInt(tokenAddress) < BigInt(wrappedNative)
    ? tokenAddress
    : wrappedNative;
  const expectedToken1 = expectedToken0.toLowerCase() === tokenAddress.toLowerCase()
    ? wrappedNative
    : tokenAddress;
  if (
    token0.toLowerCase() !== expectedToken0.toLowerCase() ||
    token1.toLowerCase() !== expectedToken1.toLowerCase()
  ) {
    throw new Error(`SRP_WETH9_POOL_${suffix} bukan pool pasangan SRP/WETH9 yang diharapkan.`);
  }
  await pool.observe([TWAP_INTERVAL, 0]);

  const sale = new hre.ethers.Contract(
    investorSaleAddress,
    [
      "function owner() view returns (address)",
      "function saleActive() view returns (bool)",
      "function dexPricingEnabled() view returns (bool)",
      "function dexPool() view returns (address)",
      "function setSaleActive(bool) external",
      "function enableDEXPricing(address,uint32) external",
      "function updateDEXPool(address,uint32) external",
      "function currentPriceX18() view returns (uint256)",
    ],
    deployer,
  );
  const owner = await sale.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer bukan owner InvestorSale (${owner}); owner harus menjalankan konfigurasi pool.`);
  }
  const existingPool = await sale.dexPool();
  if (
    (await sale.dexPricingEnabled()) &&
    existingPool.toLowerCase() === poolAddress.toLowerCase()
  ) {
    console.log(`InvestorSale sudah memakai pool SRP/WETH9 ${poolAddress}.`);
    return;
  }

  const wasActive = await sale.saleActive();
  if (wasActive) {
    await (await sale.setSaleActive(false)).wait();
    console.log("InvestorSale dinonaktifkan sementara untuk mengganti sumber harga.");
  }

  try {
    if (await sale.dexPricingEnabled()) {
      await (await sale.updateDEXPool(poolAddress, TWAP_INTERVAL)).wait();
    } else {
      await (await sale.enableDEXPricing(poolAddress, TWAP_INTERVAL)).wait();
    }

    const price = await sale.currentPriceX18();
    if (price <= 0n) throw new Error("Harga TWAP SRP/WETH9 tidak valid.");

    if (wasActive) {
      await (await sale.setSaleActive(true)).wait();
    }
    console.log(`InvestorSale menggunakan pool SRP/WETH9 ${poolAddress} dengan TWAP ${TWAP_INTERVAL} detik.`);
    console.log(`Harga TWAP saat ini (18 desimal): ${price}`);
    console.log(wasActive
      ? "InvestorSale diaktifkan kembali."
      : "InvestorSale tetap nonaktif; aktifkan setelah pemeriksaan yang diperlukan.");
  } catch (error) {
    if (wasActive) {
      console.error("Konfigurasi DEX gagal; InvestorSale dibiarkan nonaktif demi keamanan.");
    }
    throw error;
  }
}

main().catch((error) => {
  console.error("Konfigurasi pool InvestorSale gagal:", error);
  process.exitCode = 1;
});
