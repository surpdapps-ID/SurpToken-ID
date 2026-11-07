function networkSuffix(hre) {
  const chainId = hre.network.config.chainId;
  if (chainId === 80002) return "AMOY";
  if (chainId === 137) return "POLYGON";
  throw new Error(`Network tidak didukung untuk skrip ini (chain ID ${chainId}).`);
}

function networkEnv(hre, name) {
  const suffix = networkSuffix(hre);
  const value = process.env[`${name}_${suffix}`];
  if (value !== undefined && value.trim() !== "") {
    return value.trim();
  }
  return undefined;
}

function requiredNetworkEnv(hre, name) {
  const value = networkEnv(hre, name);
  if (!value) {
    const suffix = networkSuffix(hre);
    throw new Error(`${name}_${suffix} belum diisi di config/networks/${suffix.toLowerCase()}.cjs.`);
  }
  return value;
}

async function assertConfiguredNetwork(hre) {
  const suffix = networkSuffix(hre);
  const expectedChainId = BigInt(hre.network.config.chainId);
  const { chainId } = await hre.ethers.provider.getNetwork();
  if (chainId !== expectedChainId) {
    throw new Error(`RPC chain ID ${chainId} tidak cocok dengan network ${expectedChainId}.`);
  }
  return suffix;
}

module.exports = {
  assertConfiguredNetwork,
  networkEnv,
  networkSuffix,
  requiredNetworkEnv,
};
