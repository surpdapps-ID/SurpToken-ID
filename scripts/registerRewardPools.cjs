const hre = require("hardhat");
const {
  assertConfiguredNetwork,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const address = (name) => {
    const value = requiredNetworkEnv(hre, name);
    if (!hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
      throw new Error(`${name}_${suffix} harus berupa alamat valid.`);
    }
    return hre.ethers.getAddress(value);
  };

  const p2eAddress = address("P2E_MANAGER");
  const stakingAddress = address("PUBLIC_STAKING_ADDRESS");
  const dividendAddress = address("INVESTOR_DIVIDEND_ADDRESS");
  if (stakingAddress.toLowerCase() === dividendAddress.toLowerCase()) {
    throw new Error("Alamat staking dan dividen tidak boleh sama.");
  }

  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("Signer tidak tersedia; isi PRIVATE_KEY di .env.");

  const p2e = new hre.ethers.Contract(
    p2eAddress,
    [
      "function owner() view returns (address)",
      "function token() view returns (address)",
      "function isMiningPool(address) view returns (bool)",
      "function setMiningPoolStatus(address,bool)",
    ],
    signer,
  );
  const staking = new hre.ethers.Contract(
    stakingAddress,
    [
      "function token() view returns (address)",
      "function p2eManager() view returns (address)",
    ],
    hre.ethers.provider,
  );
  const dividend = new hre.ethers.Contract(
    dividendAddress,
    [
      "function token() view returns (address)",
      "function p2eManager() view returns (address)",
    ],
    hre.ethers.provider,
  );

  const [p2eOwner, p2eToken, stakingToken, stakingP2E, dividendToken, dividendP2E] =
    await Promise.all([
      p2e.owner(),
      p2e.token(),
      staking.token(),
      staking.p2eManager(),
      dividend.token(),
      dividend.p2eManager(),
    ]);
  if (
    stakingToken.toLowerCase() !== p2eToken.toLowerCase() ||
    dividendToken.toLowerCase() !== p2eToken.toLowerCase()
  ) {
    throw new Error("Token staking/dividen tidak cocok dengan token P2EManager.");
  }
  if (
    stakingP2E.toLowerCase() !== p2eAddress.toLowerCase() ||
    dividendP2E.toLowerCase() !== p2eAddress.toLowerCase()
  ) {
    throw new Error(`Kontrak reward tidak menggunakan P2E_MANAGER_${suffix} dari deployments/${suffix.toLowerCase()}.json.`);
  }

  const pools = [
    ["PublicStaking", stakingAddress],
    ["InvestorDividend", dividendAddress],
  ];
  const pendingPools = [];
  for (const [name, poolAddress] of pools) {
    if (!(await p2e.isMiningPool(poolAddress))) pendingPools.push([name, poolAddress]);
    else console.log(`${name} sudah terdaftar sebagai mining pool.`);
  }
  if (pendingPools.length === 0) {
    console.log("Tidak ada perubahan; kedua kontrak reward sudah terotorisasi.");
    return;
  }

  if (p2eOwner.toLowerCase() !== signer.address.toLowerCase()) {
    const iface = new hre.ethers.Interface(["function setMiningPoolStatus(address,bool)"]);
    console.log(`Signer ${signer.address} bukan owner P2EManager; owner sekarang: ${p2eOwner}.`);
    console.log("Jalankan transaksi berikut dari owner P2EManager (misalnya melalui Safe):");
    for (const [name, poolAddress] of pendingPools) {
      console.log(JSON.stringify({
        target: p2eAddress,
        data: iface.encodeFunctionData("setMiningPoolStatus", [poolAddress, true]),
        description: `Daftarkan ${name} sebagai mining pool P2EManager.`,
      }));
    }
    return;
  }

  for (const [name, poolAddress] of pendingPools) {
    const tx = await p2e.setMiningPoolStatus(poolAddress, true);
    await tx.wait();
    if (!(await p2e.isMiningPool(poolAddress))) {
      throw new Error(`P2EManager gagal mengotorisasi ${name} (${poolAddress}).`);
    }
    console.log(`${name} terdaftar sebagai mining pool. Tx: ${tx.hash}`);
  }
}

main().catch((error) => {
  console.error("Pendaftaran reward pool gagal:", error);
  process.exitCode = 1;
});
