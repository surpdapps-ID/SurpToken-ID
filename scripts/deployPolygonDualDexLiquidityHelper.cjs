const hre = require("hardhat");
const { verifyDeployment } = require("./utils/verifyDeployment.cjs");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (hre.network.config.chainId !== 137 || network.chainId !== 137n) {
    throw new Error(`PolygonDualDexLiquidityHelper hanya bisa deploy ke Polygon mainnet (137); RPC chain ${network.chainId}.`);
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error("Deployer tidak tersedia; isi PRIVATE_KEY di .env.");
  }

  const factory = await hre.ethers.getContractFactory("PolygonDualDexLiquidityHelper", deployer);
  const helper = await factory.deploy();
  const deploymentTx = helper.deploymentTransaction();
  if (!deploymentTx) {
    throw new Error("Transaksi deployment helper tidak terbentuk.");
  }

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Transaksi deploy helper: ${deploymentTx.hash}`);
  await helper.waitForDeployment();
  const address = await helper.getAddress();
  console.log(`PolygonDualDexLiquidityHelper: ${address}`);
  persistNetworkEnv(hre, { DUAL_LP_HELPER_ADDRESS: address });
  await verifyDeployment(hre, {
    address,
    contract: "contracts/PolygonDualDexLiquidityHelper.sol:PolygonDualDexLiquidityHelper",
  });
}

main().catch((error) => {
  console.error("Deployment LP helper gagal:", error);
  process.exitCode = 1;
});
