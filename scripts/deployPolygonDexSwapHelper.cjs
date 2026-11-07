const hre = require("hardhat");
const { verifyDeployment } = require("./utils/verifyDeployment.cjs");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");

const EXPECTED_CHAIN_ID = 137n;
const REQUIRED_CONTRACTS = {
  WPOL: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  UniswapV3Router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  QuickSwapV3Router: "0xf5b509bB0909a69B1c207E495f687a596C168E12",
};

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Refusing deployment: expected Polygon mainnet (137), RPC is chain ${network.chainId}.`,
    );
  }

  for (const [name, address] of Object.entries(REQUIRED_CONTRACTS)) {
    const code = await hre.ethers.provider.getCode(address);
    if (code === "0x") {
      throw new Error(`${name} address ${address} has no contract code on Polygon mainnet.`);
    }
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer configured. Set PRIVATE_KEY in .env.");
  }

  console.log(`Deploying PolygonDexSwapHelper on chain ${network.chainId}`);
  console.log(`Deployer: ${deployer.address}`);

  const factory = await hre.ethers.getContractFactory("PolygonDexSwapHelper", deployer);
  const helper = await factory.deploy();
  const deploymentTransaction = helper.deploymentTransaction();
  if (!deploymentTransaction) {
    throw new Error("Deployment transaction was not created.");
  }

  console.log(`Deployment transaction: ${deploymentTransaction.hash}`);
  await helper.waitForDeployment();
  const address = await helper.getAddress();
  console.log(`PolygonDexSwapHelper: ${address}`);
  persistNetworkEnv(hre, { DUAL_DEX_SWAP_HELPER_ADDRESS: address });
  await verifyDeployment(hre, {
    address,
    contract: "contracts/PolygonDexSwapHelper.sol:PolygonDexSwapHelper",
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
