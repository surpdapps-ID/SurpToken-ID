const hre = require("hardhat");
const { assertConfiguredNetwork } = require("./utils/networkEnv.cjs");

const NFT_COLLECTIONS = [
  "COMMON",
  "RARE",
  "EPIC",
  "FLASH",
  "SCATTERY",
  "BRUSHVIOLET",
];

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("Deployer tidak tersedia; isi PRIVATE_KEY di .env.");

  const networkOutput = (name) => process.env[`${name}_${suffix}`]?.trim();
  const safeValue = networkOutput("SAFE_ADDRESS");
  if (!safeValue) throw new Error(`SAFE_ADDRESS_${suffix} wajib diisi setelah Safe dibuat.`);
  if (!hre.ethers.isAddress(safeValue) || safeValue === hre.ethers.ZeroAddress) {
    throw new Error(`SAFE_ADDRESS_${suffix} harus alamat valid dan bukan zero address.`);
  }
  const safeAddress = hre.ethers.getAddress(safeValue);
  if ((await hre.ethers.provider.getCode(safeAddress)) === "0x") {
    throw new Error(`SAFE_ADDRESS_${suffix} tidak memiliki bytecode di jaringan ini.`);
  }

  const configuredOwners = Array.from({ length: 5 }, (_, index) => {
    const name = `SAFE_OWNER_${index + 1}`;
    const value = process.env[name]?.trim();
    if (!value || !hre.ethers.isAddress(value)) {
      throw new Error(`${name} harus berisi alamat wallet yang valid.`);
    }
    return hre.ethers.getAddress(value);
  });
  if (configuredOwners.some((address) => address === hre.ethers.ZeroAddress)) {
    throw new Error("Alamat SAFE_OWNER tidak boleh zero address.");
  }
  const safe = new hre.ethers.Contract(
    safeAddress,
    ["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"],
    hre.ethers.provider,
  );
  const [safeOwners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()]);
  const expected = new Set(configuredOwners.map((address) => address.toLowerCase()));
  const actual = new Set(safeOwners.map((address) => address.toLowerCase()));
  if (
    expected.size !== 5 ||
    actual.size !== 5 ||
    Number(threshold) !== 3 ||
    [...expected].some((address) => !actual.has(address))
  ) {
    throw new Error(`SAFE_ADDRESS_${suffix} bukan Safe 3/5 yang cocok dengan SAFE_OWNER_1..5.`);
  }

  const investorOutputKeys = [
    "SRP_SHOP_ADDRESS",
    "INVESTOR_SALE_ADDRESS",
    ...NFT_COLLECTIONS.map((name) => `NFT_${name}_ADDRESS`),
  ];
  const investorOutputStatus = investorOutputKeys.map((name) => Boolean(networkOutput(name)));
  if (investorOutputStatus.some(Boolean) && investorOutputStatus.some((present) => !present)) {
    throw new Error(
      `Investor/NFT belum lengkap. Deploy dan sambungkan Shop, InvestorSale, serta keenam NFT sebelum finalisasi.`,
    );
  }
  const rewardOutputStatus = [
    Boolean(networkOutput("PUBLIC_STAKING_ADDRESS")),
    Boolean(networkOutput("INVESTOR_DIVIDEND_ADDRESS")),
  ];
  if (rewardOutputStatus.some(Boolean) && rewardOutputStatus.some((present) => !present)) {
    throw new Error("PublicStaking dan InvestorDividend harus dideploy berpasangan sebelum finalisasi.");
  }

  const mandatoryContracts = [
    ["CORE_SRP_TOKEN", "SRP token", true, true],
    ["CORE_SURPZERO_LP_MANAGER", "LPManager", true, true],
    ["CORE_SURPZERO_P2E_MANAGER", "P2EManager", true, false],
    ["CONTRACT_ADDRESS", "SurpSidy", true, true],
    ["SRP_SHOP_ADDRESS", "SRP_Shop", false, false],
    ["INVESTOR_SALE_ADDRESS", "InvestorSale", false, false],
    ...NFT_COLLECTIONS.map((name) => [`NFT_${name}_ADDRESS`, `SRP_${name}`, false, false]),
    ["PUBLIC_STAKING_ADDRESS", "PublicStaking", false, false],
    ["INVESTOR_DIVIDEND_ADDRESS", "InvestorDividend", false, false],
  ];
  const entries = mandatoryContracts.map(([envName, label, required, twoStep]) => ({
    envName,
    label,
    required,
    twoStep,
    value: networkOutput(envName),
  }));
  const missing = entries
    .filter(({ required, value }) => required && !value)
    .map(({ envName, label }) => `${envName}_${suffix} (${label})`);
  if (missing.length) {
    throw new Error(`Deploy dulu kontrak wajib sebelum finalisasi Safe:\n- ${missing.join("\n- ")}`);
  }

  const acceptOwnershipInterface = new hre.ethers.Interface(["function acceptOwnership()"]);
  const ownable = [
    "function owner() view returns (address)",
    "function transferOwnership(address)",
    "function acceptOwnership()",
  ];
  const contracts = [];
  for (const { envName, label, value, twoStep } of entries) {
    if (!value) continue;
    if (!hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
      throw new Error(`${envName}_${suffix} bukan alamat kontrak yang valid.`);
    }
    const address = hre.ethers.getAddress(value);
    if ((await hre.ethers.provider.getCode(address)) === "0x") {
      throw new Error(`${envName}_${suffix} ${address} tidak memiliki bytecode.`);
    }

    const contractAbi = twoStep
      ? [...ownable, "function pendingOwner() view returns (address)"]
      : ownable;
    const contract = new hre.ethers.Contract(address, contractAbi, deployer);
    const owner = await contract.owner();
    const pendingOwner = twoStep ? await contract.pendingOwner() : hre.ethers.ZeroAddress;
    if (
      owner.toLowerCase() !== safeAddress.toLowerCase() &&
      owner.toLowerCase() !== deployer.address.toLowerCase()
    ) {
      throw new Error(
        `${label} dimiliki ${owner}, bukan deployer atau Safe; ownership tidak diubah.`,
      );
    }
    contracts.push({ contract, address, label, owner, pendingOwner, twoStep });
  }

  const pendingAccepts = [];
  const transferred = [];
  const alreadyOwned = [];

  for (const { contract, address, label, owner, pendingOwner, twoStep } of contracts) {
    if (owner.toLowerCase() === safeAddress.toLowerCase()) {
      alreadyOwned.push(label);
      continue;
    }
    if (pendingOwner.toLowerCase() === safeAddress.toLowerCase()) {
      pendingAccepts.push({ label, target: address });
      continue;
    }

    await (await contract.transferOwnership(safeAddress)).wait();
    const nextOwner = await contract.owner();
    if (nextOwner.toLowerCase() === safeAddress.toLowerCase()) {
      alreadyOwned.push(label);
      continue;
    }
    if (!twoStep || (await contract.pendingOwner()).toLowerCase() !== safeAddress.toLowerCase()) {
      throw new Error(`Transfer ownership ${label} ke Safe tidak terkonfirmasi.`);
    }
    pendingAccepts.push({ label, target: address });
    transferred.push(label);
  }

  console.log(`Finalisasi ownership ${suffix} untuk Safe ${safeAddress}`);
  if (transferred.length) console.log(`Transfer diajukan: ${transferred.join(", ")}`);
  if (alreadyOwned.length) console.log(`Sudah di bawah Safe: ${alreadyOwned.join(", ")}`);
  if (pendingAccepts.length) {
    console.log("\nSafe harus menjalankan acceptOwnership() untuk kontrak Ownable2Step berikut:");
    for (const { label, target } of pendingAccepts) {
      console.log(JSON.stringify({
        target,
        data: acceptOwnershipInterface.encodeFunctionData("acceptOwnership"),
        description: `Terima ownership ${label} ke Safe.`,
      }));
    }
  } else {
    console.log("Semua ownership sudah berada di Safe.");
  }
}

main().catch((error) => {
  console.error("Finalisasi ownership gagal:", error);
  process.exitCode = 1;
});
