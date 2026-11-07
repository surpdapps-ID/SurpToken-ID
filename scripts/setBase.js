const hre = require("hardhat");
const { ethers } = hre;
const {
  assertConfiguredNetwork,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const [deployer] = await ethers.getSigners();
  console.log("=========================================================");
  console.log(`Jaringan: ${suffix}`);
  console.log("Memulai Update Base URI dengan wallet:", deployer.address);
  console.log("=========================================================");

  // !!! PASTE ALAMAT NFT YANG UDAH LU DEPLOY DI SINI !!!
  const nftAddresses = {
    SRP_Common: requiredNetworkEnv(hre, "NFT_COMMON_ADDRESS"),
    SRP_Rare: requiredNetworkEnv(hre, "NFT_RARE_ADDRESS"),
    SRP_Epic: requiredNetworkEnv(hre, "NFT_EPIC_ADDRESS"),
    SRP_Flash: requiredNetworkEnv(hre, "NFT_FLASH_ADDRESS"),
    SRP_Scattery: requiredNetworkEnv(hre, "NFT_SCATTERY_ADDRESS"),
    SRP_BrushViolet: requiredNetworkEnv(hre, "NFT_BRUSHVIOLET_ADDRESS"),
  };

  const baseURIs = Object.fromEntries(
    Object.keys(nftAddresses).map((name) => [
      name,
      requiredNetworkEnv(hre, `NFT_BASE_URI_${name.replace("SRP_", "").toUpperCase()}`),
    ]),
  );

  const nftNames = Object.keys(nftAddresses);
  for (const name of nftNames) {
    const targetAddress = nftAddresses[name];
    if (!baseURIs[name]) {
      throw new Error(`NFT_BASE_URI_${name.replace("SRP_", "").toUpperCase()}_${suffix} belum diisi di config/networks/${suffix.toLowerCase()}.cjs.`);
    }
    if (!ethers.isAddress(targetAddress) || targetAddress === ethers.ZeroAddress) {
      throw new Error(`Alamat NFT ${name} pada network ${suffix} tidak valid.`);
    }
    if ((await ethers.provider.getCode(targetAddress)) === "0x") {
      throw new Error(`Alamat NFT ${name} bukan kontrak pada network ${suffix}.`);
    }
  }

  for (const name of nftNames) {
    const targetAddress = nftAddresses[name];

    console.log(`\n- Memproses ${name} (${targetAddress})...`);

    const nftContract = await ethers.getContractAt(name, targetAddress);
    console.log(`  > Eksekusi setBaseURI ke: ${baseURIs[name]}`);
    const tx = await nftContract.setBaseURI(baseURIs[name]);
    console.log(`  > Menunggu konfirmasi transaksi...`);
    await tx.wait();
    console.log(`  > [SUKSES] Base URI ${name} berhasil di-update!`);
  }

  console.log("\n=========================================================");
  console.log("Proses update Base URI selesai!");
  console.log("=========================================================");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
