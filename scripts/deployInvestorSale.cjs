const hre = require("hardhat");
const { verifyDeployment } = require("./utils/verifyDeployment.cjs");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");
const MIN_TWAP_INTERVAL = 1800;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} wajib diisi di config/networks/${suffix.toLowerCase()}.cjs.`);
  return value;
}

async function main() {
  const suffix = hre.network.config.chainId === 80002
    ? "AMOY"
    : hre.network.config.chainId === 137
      ? "POLYGON"
      : null;
  if (!suffix) throw new Error("Gunakan network polygonAmoy atau polygon.");

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== BigInt(hre.network.config.chainId)) {
    throw new Error(`RPC chain ID ${network.chainId} tidak cocok dengan konfigurasi Hardhat.`);
  }

  const tokenAddress = hre.ethers.getAddress(requiredEnv(`SRP_TOKEN_${suffix}`));
  const lpManagerAddress = hre.ethers.getAddress(requiredEnv(`SURPSIDY_LP_MANAGER_${suffix}`));
  const wrappedNative = hre.ethers.getAddress(requiredEnv(`WETH9_${suffix}`));
  const p2eAddress = hre.ethers.getAddress(requiredEnv(`P2E_MANAGER_${suffix}`));
  const salesTreasuryValue = process.env[`SALES_TREASURY_ADDRESS_${suffix}`]?.trim();
  const salesTreasury = salesTreasuryValue
    ? hre.ethers.getAddress(salesTreasuryValue)
    : undefined;
  const manualPriceValue = process.env[`SRP_PRICE_POL_${suffix}`]?.trim();
  const poolAddressValue = process.env[`SRP_WETH9_POOL_${suffix}`]?.trim();
  if (Boolean(manualPriceValue) === Boolean(poolAddressValue)) {
    throw new Error(`Isi tepat satu dari SRP_PRICE_POL_${suffix} atau SRP_WETH9_POOL_${suffix}.`);
  }
  const manualPrice = manualPriceValue
    ? hre.ethers.parseUnits(manualPriceValue, 18)
    : undefined;
  if (manualPrice !== undefined && manualPrice <= 0n) {
    throw new Error(`SRP_PRICE_POL_${suffix} harus lebih besar dari nol.`);
  }
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("Deployer tidak tersedia; isi PRIVATE_KEY di .env.");

  const codeAddresses = [tokenAddress, lpManagerAddress, wrappedNative, p2eAddress];
  const code = await Promise.all(codeAddresses.map((address) => hre.ethers.provider.getCode(address)));
  if (code.some((value) => value === "0x")) {
    throw new Error("SRP, LPManager, WETH9 project, dan P2E Manager harus merupakan kontrak di jaringan target.");
  }

  const token = new hre.ethers.Contract(
    tokenAddress,
    ["function name() view returns (string)", "function symbol() view returns (string)", "function balanceOf(address) view returns (uint256)"],
    deployer,
  );
  if (await token.name() !== "Standard Units Rupol" || await token.symbol() !== "SRP") {
    throw new Error(`SRP_TOKEN_${suffix} harus menunjuk Standard Units Rupol (SRP).`);
  }

  const lpManager = new hre.ethers.Contract(
    lpManagerAddress,
    [
      "function token() view returns (address)",
      "function owner() view returns (address)",
      "function setInvestorSale(address sale)",
    ],
    deployer,
  );
  const [lpManagerToken, lpManagerOwner] = await Promise.all([
    lpManager.token(),
    lpManager.owner(),
  ]);
  if (lpManagerToken.toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new Error(`SURPSIDY_LP_MANAGER_${suffix} tidak menyimpan Standard Units Rupol (SRP) yang dikonfigurasi.`);
  }
  if (lpManagerOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Wallet deployer bukan owner LPManager (${lpManagerOwner}); hanya owner LPManager yang bisa mengotorisasi InvestorSale.`,
    );
  }
  const p2e = new hre.ethers.Contract(
    p2eAddress,
    ["function token() view returns (address)"],
    hre.ethers.provider,
  );
  if ((await p2e.token()).toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new Error(`P2E_MANAGER_${suffix} memakai token yang berbeda dari SRP_TOKEN_${suffix}.`);
  }

  const investmentAmounts = Array.from({ length: 5 }, (_, index) => {
    const envName = `INVESTMENT_LEVEL_${index + 1}_POL_${suffix}`;
    const amount = hre.ethers.parseEther(requiredEnv(envName));
    if (amount <= 0n) throw new Error(`${envName} harus lebih besar dari nol.`);
    return amount;
  });
  let poolAddress;
  let poolInterval;
  if (poolAddressValue) {
    poolAddress = hre.ethers.getAddress(poolAddressValue);
    if ((await hre.ethers.provider.getCode(poolAddress)) === "0x") {
      throw new Error(`SRP_WETH9_POOL_${suffix} bukan kontrak di jaringan ini.`);
    }
    poolInterval = MIN_TWAP_INTERVAL;
    const pool = new hre.ethers.Contract(
      poolAddress,
      [
        "function token0() view returns (address)",
        "function token1() view returns (address)",
        "function observe(uint32[]) view returns (int56[],uint160[])",
      ],
      hre.ethers.provider,
    );
    const [token0, token1] = await Promise.all([pool.token0(), pool.token1()]);
    const expectedToken0 = BigInt(tokenAddress) < BigInt(wrappedNative) ? tokenAddress : wrappedNative;
    const expectedToken1 = expectedToken0.toLowerCase() === tokenAddress.toLowerCase()
      ? wrappedNative
      : tokenAddress;
    if (
      token0.toLowerCase() !== expectedToken0.toLowerCase() ||
      token1.toLowerCase() !== expectedToken1.toLowerCase()
    ) {
      throw new Error(`SRP_WETH9_POOL_${suffix} bukan pool SRP/WETH9 project yang diharapkan.`);
    }
    await pool.observe([poolInterval, 0]);
  }

  const shopFactory = await hre.ethers.getContractFactory("SRP_Shop");
  const shop = await shopFactory.deploy(tokenAddress);
  await shop.waitForDeployment();
  if (salesTreasury) await (await shop.setSalesTreasury(salesTreasury)).wait();
  const shopAddress = await shop.getAddress();
  persistNetworkEnv(hre, { SRP_SHOP_ADDRESS: shopAddress });

  const investorFactory = await hre.ethers.getContractFactory("InvestorSale");
  const investor = await investorFactory.deploy(
    tokenAddress,
    wrappedNative,
    deployer.address,
    investmentAmounts,
  );
  await investor.waitForDeployment();
  if (salesTreasury) await (await investor.setSalesTreasury(salesTreasury)).wait();
  const investorAddress = await investor.getAddress();

  await (await lpManager.setInvestorSale(investorAddress)).wait();
  persistNetworkEnv(hre, {
    INVESTOR_SALE_ADDRESS: investorAddress,
    LP_MANAGER_INVESTOR_SALE: investorAddress,
  });
  await (await investor.setLPManager(lpManagerAddress)).wait();
  if (poolAddress) {
    await (await investor.enableDEXPricing(poolAddress, poolInterval)).wait();
  } else {
    await (await investor.setManualPrice(manualPrice)).wait();
  }

  console.log("Sale tetap nonaktif sampai NFT di-deploy dan seluruh koneksi investor/shop/P2E selesai.");

  console.log(`InvestorSale ${suffix}: ${investorAddress}`);
  console.log(`SRP_Shop ${suffix}: ${shopAddress}`);
  console.log(`Sale aktif: ${await investor.saleActive()}`);
  console.log(`LPManager sumber SRP: ${lpManagerAddress}`);
  console.log(`Alamat InvestorSale dan Shop tersimpan di deployments/${suffix.toLowerCase()}.json.`);
  console.log("SRP ditarik dari LPManager sesuai kebutuhan tiap pembelian; saldo LPManager tetap harus cukup.");
  console.log("Voucher pembeli dicatat langsung; redeemVoucher baru bisa dipakai setelah keenam NFT dihubungkan.");

  const failures = [];
  for (const item of [
    {
      name: "SRP_Shop",
      address: shopAddress,
      constructorArguments: [tokenAddress],
      contract: "contracts/SRP_Shop.sol:SRP_Shop",
    },
    {
      name: "InvestorSale",
      address: investorAddress,
      constructorArguments: [tokenAddress, wrappedNative, deployer.address, investmentAmounts],
      contract: "contracts/InvestorSale.sol:InvestorSale",
    },
  ]) {
    try {
      await verifyDeployment(hre, item);
    } catch (error) {
      failures.push(`${item.name} (${item.address}): ${error.message}`);
    }
  }
  if (failures.length) {
    throw new Error(`Deployment berhasil, tetapi sebagian verifikasi gagal:\n${failures.join("\n")}`);
  }
}

main().catch((error) => {
  console.error("Deployment InvestorSale gagal:", error);
  process.exitCode = 1;
});
