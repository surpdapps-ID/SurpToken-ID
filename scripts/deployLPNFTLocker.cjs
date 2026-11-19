const hre = require("hardhat");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");
const { verifyDeployment } = require("./utils/verifyDeployment.cjs");

async function main() {
  const expectedChainId = BigInt(hre.network.config.chainId);
  if (expectedChainId !== 137n && expectedChainId !== 80002n) {
    throw new Error(`LPNFTLocker hanya mendukung Polygon/Amoy; network chain ID ${expectedChainId}.`);
  }
  const suffix = expectedChainId === 137n ? "POLYGON" : "AMOY";
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== expectedChainId) {
    throw new Error(`RPC chain ID ${network.chainId} tidak cocok dengan network ${expectedChainId}.`);
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("Deployer tidak tersedia; isi PRIVATE_KEY di .env.");

  const unlockSignerValue = process.env[`LP_NFT_UNLOCK_SIGNER_${suffix}`]?.trim();
  if (
    unlockSignerValue &&
    (!hre.ethers.isAddress(unlockSignerValue) || unlockSignerValue === hre.ethers.ZeroAddress)
  ) {
    throw new Error(`LP_NFT_UNLOCK_SIGNER_${suffix} harus berupa alamat wallet valid.`);
  }

  const factory = await hre.ethers.getContractFactory("LPNFTLocker", deployer);
  const locker = await factory.deploy();
  const deploymentTx = locker.deploymentTransaction();
  if (!deploymentTx) throw new Error("Transaksi deployment LPNFTLocker tidak terbentuk.");

  console.log(`Deployer/owner: ${deployer.address}`);
  console.log(`Transaksi deploy LPNFTLocker: ${deploymentTx.hash}`);
  await locker.waitForDeployment();
  const address = await locker.getAddress();
  console.log(`LPNFTLocker: ${address}`);
  console.log(`Durasi awal: ${await locker.lockDuration()} detik (10 tahun).`);
  persistNetworkEnv(hre, { LP_NFT_LOCKER_ADDRESS: address });

  if (unlockSignerValue) {
    const unlockSigner = hre.ethers.getAddress(unlockSignerValue);
    const signerTx = await locker.setUnlockSigner(unlockSigner);
    await signerTx.wait();
    if ((await locker.unlockSigner()).toLowerCase() !== unlockSigner.toLowerCase()) {
      throw new Error("Verifikasi alamat unlock signer gagal setelah konfigurasi.");
    }
    console.log(`Unlock signer backend: ${unlockSigner}`);
  } else {
    console.log(`LP_NFT_UNLOCK_SIGNER_${suffix} kosong; isi sebelum locker menerima NFT.`);
  }

  await verifyDeployment(hre, {
    address,
    contract: "contracts/LPNFTLocker.sol:LPNFTLocker",
  });
}

main().catch((error) => {
  console.error("Deployment LPNFTLocker gagal:", error);
  process.exitCode = 1;
});
