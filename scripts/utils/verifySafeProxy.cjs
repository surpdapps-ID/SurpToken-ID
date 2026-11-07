const { verifyDeployment } = require("./verifyDeployment.cjs");

const SAFE_FACTORY_INTERFACE = [
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
];

function getSafeSingletonAddress(hre, deploymentTransaction) {
  if (!deploymentTransaction?.data) {
    throw new Error("Data deployment Safe tidak tersedia untuk verifikasi proxy.");
  }
  const safeFactoryInterface = new hre.ethers.Interface(SAFE_FACTORY_INTERFACE);
  const parsedTransaction = safeFactoryInterface.parseTransaction({
    data: deploymentTransaction.data,
  });
  if (!parsedTransaction || parsedTransaction.name !== "createProxyWithNonce") {
    throw new Error("Transaksi deployment Safe bukan pemanggilan createProxyWithNonce yang diharapkan.");
  }
  return hre.ethers.getAddress(parsedTransaction.args._singleton);
}

async function verifySafeProxy(hre, { address, deploymentTransaction }) {
  const singletonAddress = getSafeSingletonAddress(hre, deploymentTransaction);
  await verifyDeployment(hre, {
    address,
    constructorArguments: [singletonAddress],
    contract: "contracts/proxies/SafeProxy.sol:SafeProxy",
  });
}

module.exports = { getSafeSingletonAddress, verifySafeProxy };
