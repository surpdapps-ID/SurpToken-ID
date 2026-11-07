const hre = require("hardhat");
const { verifyDeployment } = require("./utils/verifyDeployment.cjs");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");

const NFT_NAMES = [
  "SRP_Common",
  "SRP_Rare",
  "SRP_Epic",
  "SRP_Flash",
  "SRP_Scattery",
  "SRP_BrushViolet",
];
const MIN_TWAP_INTERVAL = 1800;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    const network = hre.network.config.chainId === 80002 ? "amoy" : "polygon";
    throw new Error(`Variabel ${name} wajib diisi di config/networks/${network}.cjs.`);
  }
  return value;
}

async function main() {
  const networkSuffix = hre.network.config.chainId === 80002
    ? "AMOY"
    : hre.network.config.chainId === 137
      ? "POLYGON"
      : null;
  if (!networkSuffix) {
    throw new Error("Gunakan network hardhat 'polygonAmoy' atau 'polygon'.");
  }

  const baseUris = Object.fromEntries(
    NFT_NAMES.map((name) => [
      name,
      requiredEnv(`NFT_BASE_URI_${name.replace("SRP_", "").toUpperCase()}_${networkSuffix}`),
    ]),
  );
  const chainId = hre.network.config.chainId;
  const tokenAddress = hre.ethers.getAddress(requiredEnv(`SRP_TOKEN_${networkSuffix}`));
  const wrappedNative = hre.ethers.getAddress(requiredEnv(`WETH9_${networkSuffix}`));
  const lpManagerAddress = hre.ethers.getAddress(requiredEnv(`SURPSIDY_LP_MANAGER_${networkSuffix}`));
  const p2eManagerAddress = hre.ethers.getAddress(requiredEnv(`P2E_MANAGER_${networkSuffix}`));
  const salesTreasuryValue = process.env[`SALES_TREASURY_ADDRESS_${networkSuffix}`]?.trim();
  const salesTreasury = salesTreasuryValue
    ? hre.ethers.getAddress(salesTreasuryValue)
    : undefined;
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error("Deployer tidak tersedia; isi PRIVATE_KEY di .env.");
  }
  const rpcChainId = (await hre.ethers.provider.getNetwork()).chainId;
  if (rpcChainId !== BigInt(chainId)) {
    throw new Error(`RPC chain ID ${rpcChainId} tidak cocok dengan network ${chainId}.`);
  }

  const tokenCode = await hre.ethers.provider.getCode(tokenAddress);
  const wrappedCode = await hre.ethers.provider.getCode(wrappedNative);
  const lpManagerCode = await hre.ethers.provider.getCode(lpManagerAddress);
  const p2eCode = await hre.ethers.provider.getCode(p2eManagerAddress);
  if ([tokenCode, wrappedCode, lpManagerCode, p2eCode].some((code) => code === "0x")) {
    throw new Error("Salah satu alamat SRP, WETH9 project, LPManager, atau P2EManager bukan kontrak di jaringan ini.");
  }
  const token = new hre.ethers.Contract(
    tokenAddress,
    ["function name() view returns (string)", "function symbol() view returns (string)"],
    deployer,
  );
  if ((await token.name()) !== "Standard Units Rupol" || (await token.symbol()) !== "SRP") {
    throw new Error("SRP_TOKEN harus menunjuk Standard Units Rupol (SRP).");
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
  if ((await lpManager.token()).toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new Error(`SURPSIDY_LP_MANAGER_${networkSuffix} memakai token yang berbeda dari SRP_TOKEN.`);
  }
  if ((await lpManager.owner()).toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer harus menjadi owner SURPSIDY_LP_MANAGER_${networkSuffix} untuk mengotorisasi InvestorSale.`);
  }
  const p2e = new hre.ethers.Contract(
    p2eManagerAddress,
    [
      "function owner() view returns (address)",
      "function token() view returns (address)",
      "function isMiningPool(address) view returns (bool)",
      "function setMiningPoolStatus(address,bool)",
    ],
    hre.ethers.provider,
  );
  if ((await p2e.token()).toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new Error("Token P2EManager tidak cocok dengan SRP_TOKEN jaringan ini.");
  }
  const p2eOwner = await p2e.owner();
  if (p2eOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error("Sebelum Safe dibuat, deployer harus menjadi owner P2EManager untuk mengotorisasi NFT.");
  }

  const manualPrice = process.env[`SRP_PRICE_POL_${networkSuffix}`];
  const poolAddressValue = process.env[`SRP_WETH9_POOL_${networkSuffix}`];
  if (!manualPrice) {
    throw new Error(`Isi SRP_PRICE_POL_${networkSuffix} untuk mengaktifkan InvestorSale saat deployment.`);
  }
  const manualPriceRaw = hre.ethers.parseUnits(manualPrice, 18);
  if (manualPriceRaw <= 0n) {
    throw new Error(`SRP_PRICE_POL_${networkSuffix} harus lebih besar dari nol.`);
  }
  let poolAddress;
  let poolInterval;
  if (poolAddressValue) {
    poolAddress = hre.ethers.getAddress(poolAddressValue);
    if ((await hre.ethers.provider.getCode(poolAddress)) === "0x") {
      throw new Error(`SRP_WETH9_POOL_${networkSuffix} bukan kontrak di jaringan ini.`);
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
      throw new Error(`SRP_WETH9_POOL_${networkSuffix} bukan pool SRP/WETH9 project yang diharapkan.`);
    }
    await pool.observe([poolInterval, 0]);
  }

  console.log(`Jaringan ${chainId}; deployer/admin sementara ${deployer.address}`);

  const investmentAmounts = Array.from({ length: 5 }, (_, index) => {
    const envName = `INVESTMENT_LEVEL_${index + 1}_POL_${networkSuffix}`;
    const amount = hre.ethers.parseEther(requiredEnv(envName));
    if (amount <= 0n) {
      throw new Error(`${envName} harus lebih besar dari nol.`);
    }
    return amount;
  });

  const shopFactory = await hre.ethers.getContractFactory("SRP_Shop");
  const shop = await shopFactory.deploy(tokenAddress);
  await shop.waitForDeployment();
  if (salesTreasury) await (await shop.setSalesTreasury(salesTreasury)).wait();
  const shopAddress = await shop.getAddress();
  persistNetworkEnv(hre, { SRP_SHOP_ADDRESS: shopAddress });
  const deployedNFTs = [];
  for (const name of NFT_NAMES) {
    const factory = await hre.ethers.getContractFactory(name);
    const nft = await factory.deploy(tokenAddress);
    await nft.waitForDeployment();
    if (salesTreasury) await (await nft.setSalesTreasury(salesTreasury)).wait();
    const nftAddress = await nft.getAddress();
    persistNetworkEnv(hre, {
      [`NFT_${name.replace("SRP_", "").toUpperCase()}_ADDRESS`]: nftAddress,
    });
    await (await nft.setShopContract(shopAddress)).wait();
    await (await nft.setP2EConfig(p2eManagerAddress)).wait();
    await (await nft.setBaseURI(baseUris[name])).wait();
    await (await nft.setMintPhases(true, false)).wait();
    await (await shop.setNFTWhitelist(await nft.getAddress(), true)).wait();
    deployedNFTs.push({ name, contract: nft, address: nftAddress });
  }

  const investorFactory = await hre.ethers.getContractFactory("InvestorSale");
  const investorSale = await investorFactory.deploy(
    tokenAddress,
    wrappedNative,
    deployer.address,
    investmentAmounts,
  );
  await investorSale.waitForDeployment();
  if (salesTreasury) await (await investorSale.setSalesTreasury(salesTreasury)).wait();
  const investorAddress = await investorSale.getAddress();
  console.log(
    `Nominal Invest Level 1-5 (POL): ${investmentAmounts.map((amount) => hre.ethers.formatEther(amount)).join(", ")}`,
  );

  await (await lpManager.setInvestorSale(investorAddress)).wait();
  persistNetworkEnv(hre, {
    INVESTOR_SALE_ADDRESS: investorAddress,
    LP_MANAGER_INVESTOR_SALE: investorAddress,
  });
  await (await investorSale.setLPManager(lpManagerAddress)).wait();
  for (const nft of deployedNFTs) {
    await (await nft.contract.setInvestorContract(investorAddress)).wait();
  }
  await (await investorSale.setNFTContracts(deployedNFTs.map(({ address }) => address))).wait();
  for (const nft of deployedNFTs) {
    await (await nft.contract.setMintPhases(true, false)).wait();
  }

  await (await investorSale.setManualPrice(manualPriceRaw)).wait();

  if (poolAddress) {
    const surpSwapFactoryAddress = hre.ethers.getAddress(
      requiredEnv(`SURPSWAP_V3_FACTORY_${networkSuffix}`),
    );
    const pool = new hre.ethers.Contract(
      poolAddress,
      [
        "function factory() view returns (address)",
        "function token0() view returns (address)",
        "function token1() view returns (address)",
      ],
      hre.ethers.provider,
    );
    const [poolFactory, poolToken0, poolToken1] = await Promise.all([
      pool.factory(),
      pool.token0(),
      pool.token1(),
    ]);
    const expectedToken0 = BigInt(tokenAddress) < BigInt(wrappedNative)
      ? tokenAddress
      : wrappedNative;
    const expectedToken1 = expectedToken0.toLowerCase() === tokenAddress.toLowerCase()
      ? wrappedNative
      : tokenAddress;
    if (
      poolFactory.toLowerCase() !== surpSwapFactoryAddress.toLowerCase() ||
      poolToken0.toLowerCase() !== expectedToken0.toLowerCase() ||
      poolToken1.toLowerCase() !== expectedToken1.toLowerCase()
    ) {
      throw new Error(`SRP_WETH9_POOL_${networkSuffix} bukan pool SurpSwap pasangan SRP/WETH9 yang diharapkan.`);
    }
    for (const nft of deployedNFTs) {
      await (await nft.contract.setTokenPool(poolAddress, wrappedNative, poolInterval)).wait();
    }
  }

  const p2eAdmin = p2e.connect(deployer);
  for (const nft of deployedNFTs) {
    if (!(await p2e.isMiningPool(nft.address))) {
      await (await p2eAdmin.setMiningPoolStatus(nft.address, true)).wait();
    }
  }

  await (await investorSale.setSaleActive(true)).wait();

  const deployedContracts = [
    {
      name: "SRP_Shop",
      address: shopAddress,
      constructorArguments: [tokenAddress],
      contract: "contracts/SRP_Shop.sol:SRP_Shop",
    },
    ...deployedNFTs.map(({ name, address }) => ({
      name,
      address,
      constructorArguments: [tokenAddress],
      contract: `contracts/${name}.sol:${name}`,
    })),
    {
      name: "InvestorSale",
      address: investorAddress,
      constructorArguments: [tokenAddress, wrappedNative, deployer.address, investmentAmounts],
      contract: "contracts/InvestorSale.sol:InvestorSale",
    },
  ];
  console.log("\nSistem investor terhubung dan InvestorSale/voucher mint aktif; public mint tetap nonaktif.");
  console.log(`Standard Units Rupol (SRP): ${tokenAddress}`);
  console.log(`WETH9 project (wrapped POL): ${wrappedNative}`);
  console.log(`SRP_Shop: ${shopAddress}`);
  for (const nft of deployedNFTs) {
    console.log(`${nft.name}: ${nft.address}`);
  }
  console.log(`InvestorSale: ${investorAddress}`);
  console.log(`Alamat Shop, NFT, dan InvestorSale sudah disimpan ke deployments/${networkSuffix.toLowerCase()}.json.`);
  console.log("Pastikan inventory InvestorSale/LPManager dan harga sudah benar sebelum membuka penjualan.");

  const verificationFailures = [];
  for (const deployedContract of deployedContracts) {
    console.log(`Memulai verifikasi ${deployedContract.name}...`);
    try {
      await verifyDeployment(hre, deployedContract);
    } catch (error) {
      verificationFailures.push(`${deployedContract.name} (${deployedContract.address}): ${error.message}`);
    }
  }
  if (verificationFailures.length > 0) {
    throw new Error(`Deployment berhasil, tetapi sebagian verifikasi gagal:\n${verificationFailures.join("\n")}`);
  }
}

main().catch((error) => {
  console.error("Deployment investor gagal:", error);
  process.exitCode = 1;
});
