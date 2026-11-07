const hre = require("hardhat");
const {
  assertConfiguredNetwork,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");

const TWAP_INTERVAL = 1800;
const NFT_COLLECTIONS = [
  "COMMON",
  "RARE",
  "EPIC",
  "FLASH",
  "SCATTERY",
  "BRUSHVIOLET",
];

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
  const poolAddress = addressFromConfig("SRP_WETH9_POOL");
  const surpSwapFactoryAddress = addressFromConfig("SURPSWAP_V3_FACTORY");
  const nftAddresses = NFT_COLLECTIONS.map((collection) => ({
    collection,
    address: addressFromConfig(`NFT_${collection}_ADDRESS`),
  }));
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("Deployer tidak tersedia; isi PRIVATE_KEY di .env.");

  for (const [label, address] of [
    ["SRP", tokenAddress],
    ["WETH9", wrappedNative],
    ["Pool SRP/WETH9", poolAddress],
    ...nftAddresses.map(({ collection, address }) => [`NFT ${collection}`, address]),
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

  const nftAbi = [
    "function owner() view returns (address)",
    "function tokenPoolAddress() view returns (address)",
    "function quoteToken() view returns (address)",
    "function twapInterval() view returns (uint32)",
    "function setTokenPool(address,address,uint32) external",
    "function getTokenPrice() view returns (uint256)",
  ];
  const nfts = await Promise.all(nftAddresses.map(async ({ collection, address }) => {
    const contract = new hre.ethers.Contract(address, nftAbi, deployer);
    const [owner, currentPool, currentQuoteToken, currentInterval] = await Promise.all([
      contract.owner(),
      contract.tokenPoolAddress(),
      contract.quoteToken(),
      contract.twapInterval(),
    ]);
    if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(
        `Deployer bukan owner NFT ${collection} (${owner}); owner harus menjalankan konfigurasi pool.`,
      );
    }
    return {
      collection,
      address,
      contract,
      configured: currentPool.toLowerCase() === poolAddress.toLowerCase()
        && currentQuoteToken.toLowerCase() === wrappedNative.toLowerCase()
        && Number(currentInterval) === TWAP_INTERVAL,
    };
  }));

  for (const nft of nfts) {
    if (nft.configured) {
      console.log(`NFT ${nft.collection} sudah memakai pool SRP/WETH9.`);
      continue;
    }
    const tx = await nft.contract.setTokenPool(poolAddress, wrappedNative, TWAP_INTERVAL);
    await tx.wait();
    console.log(`NFT ${nft.collection} terhubung ke pool SRP/WETH9 (tx: ${tx.hash}).`);
  }

  for (const nft of nfts) {
    const [configuredPool, configuredQuoteToken, configuredInterval, price] = await Promise.all([
      nft.contract.tokenPoolAddress(),
      nft.contract.quoteToken(),
      nft.contract.twapInterval(),
      nft.contract.getTokenPrice(),
    ]);
    if (
      configuredPool.toLowerCase() !== poolAddress.toLowerCase() ||
      configuredQuoteToken.toLowerCase() !== wrappedNative.toLowerCase() ||
      Number(configuredInterval) !== TWAP_INTERVAL ||
      price <= 0n
    ) {
      throw new Error(`Verifikasi konfigurasi pool NFT ${nft.collection} gagal.`);
    }
  }
  console.log(`Semua enam NFT memakai pool SRP/WETH9 ${poolAddress}, quoteToken ${wrappedNative}, TWAP ${TWAP_INTERVAL} detik.`);
}

main().catch((error) => {
  console.error("Konfigurasi pool NFT investor gagal:", error);
  process.exitCode = 1;
});
