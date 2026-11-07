const hre = require("hardhat");
const { verifySafeProxy } = require("./utils/verifySafeProxy.cjs");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");

async function main() {
  if (hre.network.config.chainId !== 137) {
    throw new Error("scripts/deploySafePolygon.cjs hanya mendukung Polygon mainnet (chain ID 137).");
  }

  const rpcChainId = (await hre.ethers.provider.getNetwork()).chainId;
  if (rpcChainId !== 137n) {
    throw new Error(`RPC chain ID ${rpcChainId} bukan Polygon mainnet (137).`);
  }

  const ownerAddresses = Array.from({ length: 5 }, (_, index) => {
    const name = `SAFE_OWNER_${index + 1}`;
    const address = process.env[name];
    if (!address || !hre.ethers.isAddress(address)) {
      throw new Error(`${name} di config/shared.cjs harus berisi alamat wallet yang valid.`);
    }
    return hre.ethers.getAddress(address);
  });

  if (ownerAddresses.some((address) => address === hre.ethers.ZeroAddress)) {
    throw new Error("Alamat owner Safe tidak boleh zero address.");
  }
  if (new Set(ownerAddresses.map((address) => address.toLowerCase())).size !== 5) {
    throw new Error("Kelima SAFE_OWNER harus merupakan alamat wallet yang berbeda.");
  }

  const [deployer] = await hre.ethers.getSigners();
  const safeModule = await import("@safe-global/protocol-kit");
  const Safe = safeModule.default;
  const safeKit = await Safe.init({
    provider: hre.network.provider,
    predictedSafe: {
      safeAccountConfig: {
        owners: ownerAddresses,
        threshold: 3,
      },
      safeDeploymentConfig: {
        safeVersion: "1.4.1",
        saltNonce: Date.now().toString(),
      },
    },
  });

  const safeAddress = await safeKit.getAddress();
  if ((await hre.ethers.provider.getCode(safeAddress)) !== "0x") {
    throw new Error(`Safe hasil prediksi sudah ada: ${safeAddress}. Jalankan lagi untuk alamat baru.`);
  }

  const deployment = await safeKit.createSafeDeploymentTransaction();
  console.log(`Mendeploy Safe 3/5 ke Polygon mainnet: ${safeAddress}`);
  const transaction = await deployer.sendTransaction(deployment);
  console.log(`Transaksi deployment Safe: ${transaction.hash}`);
  await transaction.wait();

  if ((await hre.ethers.provider.getCode(safeAddress)) === "0x") {
    throw new Error(`Deployment Safe gagal; tidak ditemukan bytecode di ${safeAddress}.`);
  }

  const deployedOwners = await safeKit.getOwners();
  const deployedThreshold = await safeKit.getThreshold();
  const expectedOwners = new Set(ownerAddresses.map((address) => address.toLowerCase()));
  const actualOwners = new Set(deployedOwners.map((address) => address.toLowerCase()));
  if (
    Number(deployedThreshold) !== 3 ||
    actualOwners.size !== 5 ||
    [...expectedOwners].some((address) => !actualOwners.has(address))
  ) {
    throw new Error("Safe ter-deploy, tetapi konfigurasi owner/threshold tidak cocok.");
  }

  persistNetworkEnv(hre, { SAFE_ADDRESS: safeAddress });
  await verifySafeProxy(hre, {
    address: safeAddress,
    deploymentTransaction: deployment,
  });
  console.log(`Safe berhasil dibuat: ${safeAddress}`);
  console.log("Alamat Safe tersimpan ke deployments/polygon.json.");
}

main().catch((error) => {
  console.error("Deployment Safe Polygon mainnet gagal:", error);
  process.exitCode = 1;
});
