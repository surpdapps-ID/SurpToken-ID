const hre = require("hardhat");
const { verifyDeployment } = require("./utils/verifyDeployment.cjs");
const {
  assertConfiguredNetwork,
  networkEnv,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const requiredAddress = (name) => {
    const value = requiredNetworkEnv(hre, name);
    if (!hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
      throw new Error(`${name}_${suffix} harus berupa alamat valid.`);
    }
    return hre.ethers.getAddress(value);
  };

  const tokenAddress = requiredAddress("SRP_TOKEN");
  const quoteTokenAddress = requiredAddress("WETH9");
  const pricePoolAddress = requiredAddress("SRP_WETH9_POOL");
  const surpSwapFactoryAddress = requiredAddress("SURPSWAP_V3_FACTORY");
  const p2eAddress = requiredAddress("P2E_MANAGER");
  const investorSaleAddress = requiredAddress("INVESTOR_SALE_ADDRESS");
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("Deployer tidak tersedia; isi PRIVATE_KEY di .env.");

  for (const [name, address] of [
    ["Standard Units Rupol (SRP)", tokenAddress],
    ["WETH9 quote token", quoteTokenAddress],
    ["SRP/WETH9 TWAP pool", pricePoolAddress],
    ["P2EManager", p2eAddress],
    ["InvestorSale", investorSaleAddress],
  ]) {
    if ((await hre.ethers.provider.getCode(address)) === "0x") {
      throw new Error(`${name} ${address} tidak memiliki bytecode di ${suffix}.`);
    }
  }

  const p2e = new hre.ethers.Contract(
    p2eAddress,
    [
      "function owner() view returns (address)",
      "function token() view returns (address)",
      "function isMiningPool(address) view returns (bool)",
      "function setMiningPoolStatus(address,bool)",
    ],
    deployer,
  );
  const sale = new hre.ethers.Contract(
    investorSaleAddress,
    ["function investmentToken() view returns (address)"],
    hre.ethers.provider,
  );
  const token = new hre.ethers.Contract(
    tokenAddress,
    ["function name() view returns (string)", "function symbol() view returns (string)"],
    hre.ethers.provider,
  );
  const [p2eOwner, p2eToken, saleToken] = await Promise.all([
    p2e.owner(),
    p2e.token(),
    sale.investmentToken(),
  ]);
  const [tokenName, tokenSymbol] = await Promise.all([token.name(), token.symbol()]);
  if (tokenName !== "Standard Units Rupol" || tokenSymbol !== "SRP") {
    throw new Error(`SRP_TOKEN_${suffix} harus menunjuk Standard Units Rupol (SRP).`);
  }
  if (p2eToken.toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new Error(`P2E_MANAGER_${suffix} tidak memakai SRP_TOKEN_${suffix}.`);
  }
  if (saleToken.toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new Error(`INVESTOR_SALE_ADDRESS_${suffix} tidak memakai SRP_TOKEN_${suffix}.`);
  }
  if (p2eOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error("Sebelum Safe dibuat, deployer harus menjadi owner P2EManager untuk mengotorisasi reward pools.");
  }

  const twapInterval = Number(
    requiredNetworkEnv(hre, "PUBLIC_STAKING_TWAP_INTERVAL"),
  );
  if (!Number.isSafeInteger(twapInterval) || twapInterval <= 0) {
    throw new Error(`PUBLIC_STAKING_TWAP_INTERVAL_${suffix} harus bilangan bulat positif.`);
  }
  const pricePool = new hre.ethers.Contract(
    pricePoolAddress,
    [
      "function factory() view returns (address)",
      "function observe(uint32[]) view returns (int56[],uint160[])",
    ],
    hre.ethers.provider,
  );
  if ((await pricePool.factory()).toLowerCase() !== surpSwapFactoryAddress.toLowerCase()) {
    throw new Error(`SRP_WETH9_POOL_${suffix} bukan pool dari SurpSwap factory ${surpSwapFactoryAddress}.`);
  }
  try {
    await pricePool.observe([twapInterval, 0]);
  } catch (error) {
    throw new Error(
      `Pool SRP/WETH9 belum menyediakan observasi TWAP ${twapInterval} detik; tidak ada kontrak reward baru yang dideploy.`,
      { cause: error },
    );
  }

  const stakingFactory = await hre.ethers.getContractFactory("PublicStaking", deployer);
  const configuredStakingAddress = networkEnv(hre, "PUBLIC_STAKING_ADDRESS");
  let staking;
  let stakingAddress;
  if (configuredStakingAddress) {
    stakingAddress = hre.ethers.getAddress(configuredStakingAddress);
    if ((await hre.ethers.provider.getCode(stakingAddress)) === "0x") {
      throw new Error(`PUBLIC_STAKING_ADDRESS_${suffix} bukan kontrak: ${stakingAddress}`);
    }
    staking = stakingFactory.attach(stakingAddress);
    const [existingOwner, existingToken, existingP2E, existingPool, existingQuote, existingInterval] =
      await Promise.all([
        staking.owner(),
        staking.token(),
        staking.p2eManager(),
        staking.pricePool(),
        staking.quoteToken(),
        staking.twapInterval(),
      ]);
    if (
      existingToken.toLowerCase() !== tokenAddress.toLowerCase() ||
      existingP2E.toLowerCase() !== p2eAddress.toLowerCase() ||
      existingPool.toLowerCase() !== pricePoolAddress.toLowerCase() ||
      existingQuote.toLowerCase() !== quoteTokenAddress.toLowerCase() ||
      Number(existingInterval) !== twapInterval
    ) {
      throw new Error(`PUBLIC_STAKING_ADDRESS_${suffix} tidak cocok dengan konfigurasi jaringan saat ini.`);
    }
    if (existingOwner.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(`Deployer bukan owner PublicStaking (${existingOwner}).`);
    }
    console.log(`Melanjutkan PublicStaking yang sudah terdeploy: ${stakingAddress}`);
  } else {
    staking = await stakingFactory.deploy(
      tokenAddress,
      p2eAddress,
      pricePoolAddress,
      quoteTokenAddress,
      twapInterval,
      deployer.address,
    );
    await staking.waitForDeployment();
    stakingAddress = await staking.getAddress();
    persistNetworkEnv(hre, { PUBLIC_STAKING_ADDRESS: stakingAddress });
    console.log(`PublicStaking ${suffix}: ${stakingAddress}`);
  }
  const referencePriceX18 = await staking.currentPriceX18();

  const dividendFactory = await hre.ethers.getContractFactory("InvestorDividend", deployer);
  const configuredDividendAddress = networkEnv(hre, "INVESTOR_DIVIDEND_ADDRESS");
  let dividend;
  let dividendAddress;
  if (configuredDividendAddress) {
    dividendAddress = hre.ethers.getAddress(configuredDividendAddress);
    if ((await hre.ethers.provider.getCode(dividendAddress)) === "0x") {
      throw new Error(`INVESTOR_DIVIDEND_ADDRESS_${suffix} bukan kontrak: ${dividendAddress}`);
    }
    dividend = dividendFactory.attach(dividendAddress);
    const [existingOwner, existingToken, existingP2E, existingSale] = await Promise.all([
      dividend.owner(),
      dividend.token(),
      dividend.p2eManager(),
      dividend.investorSale(),
    ]);
    if (
      existingToken.toLowerCase() !== tokenAddress.toLowerCase() ||
      existingP2E.toLowerCase() !== p2eAddress.toLowerCase() ||
      existingSale.toLowerCase() !== investorSaleAddress.toLowerCase()
    ) {
      throw new Error(`INVESTOR_DIVIDEND_ADDRESS_${suffix} tidak cocok dengan konfigurasi jaringan saat ini.`);
    }
    if (existingOwner.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(`Deployer bukan owner InvestorDividend (${existingOwner}).`);
    }
    console.log(`Melanjutkan InvestorDividend yang sudah terdeploy: ${dividendAddress}`);
  } else {
    dividend = await dividendFactory.deploy(
      tokenAddress,
      p2eAddress,
      investorSaleAddress,
      deployer.address,
    );
    await dividend.waitForDeployment();
    dividendAddress = await dividend.getAddress();
    persistNetworkEnv(hre, { INVESTOR_DIVIDEND_ADDRESS: dividendAddress });
    console.log(`InvestorDividend ${suffix}: ${dividendAddress}`);
  }

  const pools = [stakingAddress, dividendAddress];
  for (const pool of pools) {
    if (!(await p2e.isMiningPool(pool))) {
      await (await p2e.setMiningPoolStatus(pool, true)).wait();
    }
  }
  console.log("Kedua kontrak reward sudah diizinkan sebagai mining pool P2E.");

  console.log(
    "Batas staking mengikuti saldo SRP P2EManager saat stake; tidak ada budget tetap di .env.",
  );

  const aprParameters = [
    process.env[`PUBLIC_STAKING_REFERENCE_WALLETS_${suffix}`]?.trim(),
    process.env[`PUBLIC_STAKING_MIN_APR_BPS_${suffix}`]?.trim(),
    process.env[`PUBLIC_STAKING_MAX_APR_BPS_${suffix}`]?.trim(),
  ];
  if (await staking.aprConfigured()) {
    console.log("APR PublicStaking sudah dikonfigurasi; tidak diubah.");
  } else if (aprParameters.every(Boolean)) {
    const [referenceWallets, minAprBps, maxAprBps] = aprParameters.map(Number);
    if (
      !Number.isSafeInteger(referenceWallets) ||
      referenceWallets <= 0 ||
      !Number.isSafeInteger(minAprBps) ||
      minAprBps < 0 ||
      !Number.isSafeInteger(maxAprBps) ||
      maxAprBps < minAprBps ||
      maxAprBps > 100_000
    ) {
      throw new Error(`PUBLIC_STAKING_REFERENCE_WALLETS_${suffix}, PUBLIC_STAKING_MIN_APR_BPS_${suffix}, atau PUBLIC_STAKING_MAX_APR_BPS_${suffix} tidak valid.`);
    }
    await (await staking.setAprParameters(
      referencePriceX18,
      referenceWallets,
      minAprBps,
      maxAprBps,
    )).wait();
    console.log("APR staking sudah dikonfigurasi oleh deployer sebelum ownership dipindah ke Safe.");
  } else if (aprParameters.some(Boolean)) {
    throw new Error(`Isi ketiga PUBLIC_STAKING_REFERENCE_WALLETS_${suffix}, PUBLIC_STAKING_MIN_APR_BPS_${suffix}, dan PUBLIC_STAKING_MAX_APR_BPS_${suffix}, atau kosongkan semuanya.`);
  } else {
    console.log(`APR belum aktif; deployer harus mengatur setAprParameters sebelum ownership dipindah ke Safe. Harga referensi TWAP sekarang: ${referencePriceX18}.`);
  }

  await verifyDeployment(hre, {
    address: stakingAddress,
    contract: "contracts/PublicStaking.sol:PublicStaking",
    constructorArguments: [
      tokenAddress,
      p2eAddress,
      pricePoolAddress,
      quoteTokenAddress,
      twapInterval,
      deployer.address,
    ],
  });
  await verifyDeployment(hre, {
    address: dividendAddress,
    contract: "contracts/InvestorDividend.sol:InvestorDividend",
    constructorArguments: [tokenAddress, p2eAddress, investorSaleAddress, deployer.address],
  });
}

main().catch((error) => {
  console.error("Deployment staking/dividen gagal:", error);
  process.exitCode = 1;
});
