const hre = require("hardhat");

const SAFE_OWNER_KEYS = Array.from(
  { length: 5 },
  (_, index) => `SAFE_OWNER_${index + 1}_PRIVATE_KEY`,
);
const ACCEPT_OWNERSHIP_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function acceptOwnership()",
];
const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];
const NFT_COLLECTIONS = [
  "COMMON",
  "RARE",
  "EPIC",
  "FLASH",
  "SCATTERY",
  "BRUSHVIOLET",
];

async function main() {
  const chainIdExpected = hre.network.config.chainId;
  const suffix = chainIdExpected === 80002 ? "AMOY" : chainIdExpected === 137 ? "POLYGON" : null;
  if (!suffix) throw new Error(`Chain ID ${chainIdExpected} tidak didukung; gunakan Amoy atau Polygon.`);
  const rpcChainId = (await hre.ethers.provider.getNetwork()).chainId;
  if (rpcChainId !== BigInt(chainIdExpected)) {
    throw new Error(`RPC chain ID ${rpcChainId} tidak cocok dengan jaringan ${suffix}.`);
  }

  const safeAddressValue = process.env[`SAFE_ADDRESS_${suffix}`]?.trim();
  if (!safeAddressValue || !hre.ethers.isAddress(safeAddressValue)) {
    throw new Error(`SAFE_ADDRESS_${suffix} harus berisi alamat valid.`);
  }
  const safeAddress = hre.ethers.getAddress(safeAddressValue);
  if ((await hre.ethers.provider.getCode(safeAddress)) === "0x") {
    throw new Error(`Safe tidak memiliki bytecode di jaringan ${suffix}.`);
  }

  const sharedConfig = require("../config/shared.cjs");
  const expectedOwners = Array.from({ length: 5 }, (_, index) => {
    const address = sharedConfig[`SAFE_OWNER_${index + 1}`];
    if (!address || !hre.ethers.isAddress(address)) {
      throw new Error(`SAFE_OWNER_${index + 1} di config/shared.cjs tidak valid.`);
    }
    return hre.ethers.getAddress(address);
  });
  const safeContract = new hre.ethers.Contract(safeAddress, SAFE_ABI, hre.ethers.provider);
  const [owners, threshold] = await Promise.all([
    safeContract.getOwners(),
    safeContract.getThreshold(),
  ]);
  const expectedSet = new Set(expectedOwners.map((address) => address.toLowerCase()));
  const actualSet = new Set(owners.map((address) => address.toLowerCase()));
  if (
    expectedSet.size !== 5 ||
    actualSet.size !== 5 ||
    Number(threshold) !== 3 ||
    [...expectedSet].some((address) => !actualSet.has(address))
  ) {
    throw new Error(`Safe ${suffix} tidak cocok dengan konfigurasi 3-of-5 di config/shared.cjs.`);
  }

  const configuredContracts = [
    ["CORE_SRP_TOKEN", "SRP token", true, true],
    ["CORE_SURPZERO_LP_MANAGER", "LPManager", true, true],
    ["CORE_SURPZERO_P2E_MANAGER", "P2EManager", true, false],
    ["CONTRACT_ADDRESS", "SurpSidy", true, true],
    ["SRP_SHOP_ADDRESS", "SRP Shop", false, false],
    ["INVESTOR_SALE_ADDRESS", "InvestorSale", false, false],
    ...NFT_COLLECTIONS.map((name) => [`NFT_${name}_ADDRESS`, `SRP ${name}`, false, false]),
    ["PUBLIC_STAKING_ADDRESS", "PublicStaking", false, false],
    ["INVESTOR_DIVIDEND_ADDRESS", "InvestorDividend", false, false],
    ["LP_NFT_LOCKER_ADDRESS", "LPNFTLocker", false, true],
  ];
  const ownableAbi = [
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)",
    "function acceptOwnership()",
  ];
  const pendingAccepts = [];
  for (const [envName, label, required, supportsTwoStep] of configuredContracts) {
    const addressValue = process.env[`${envName}_${suffix}`]?.trim();
    if (!addressValue) {
      if (required) throw new Error(`${envName}_${suffix} wajib diisi sebelum menerima ownership.`);
      continue;
    }
    if (!hre.ethers.isAddress(addressValue) || addressValue === hre.ethers.ZeroAddress) {
      throw new Error(`${envName}_${suffix} bukan alamat valid.`);
    }
    const address = hre.ethers.getAddress(addressValue);
    if ((await hre.ethers.provider.getCode(address)) === "0x") {
      throw new Error(`${label} ${address} tidak memiliki bytecode di jaringan ${suffix}.`);
    }

    const contract = new hre.ethers.Contract(
      address,
      supportsTwoStep ? ownableAbi : ownableAbi.slice(0, 1),
      hre.ethers.provider,
    );
    const owner = await contract.owner();
    if (owner.toLowerCase() === safeAddress.toLowerCase()) {
      console.log(`${label}: ownership sudah berada di Safe.`);
      continue;
    }
    if (!supportsTwoStep) {
      throw new Error(`${label} masih dimiliki ${owner}; jalankan finalize:ownership:${suffix.toLowerCase()} terlebih dahulu.`);
    }
    const pendingOwner = await contract.pendingOwner();
    if (pendingOwner.toLowerCase() !== safeAddress.toLowerCase()) {
      throw new Error(
        `${label} masih dimiliki ${owner} dan pendingOwner=${pendingOwner}; jalankan finalize:ownership:${suffix.toLowerCase()} terlebih dahulu.`,
      );
    }
    pendingAccepts.push({ address, label });
  }
  if (pendingAccepts.length === 0) {
    console.log(`Semua ownership yang dikonfigurasi sudah berada di Safe ${suffix}.`);
    return;
  }

  const signers = [];
  const signerAddresses = new Set();
  for (const envName of SAFE_OWNER_KEYS) {
    const privateKey = process.env[envName]?.trim();
    if (!privateKey) continue;
    let signer;
    try {
      signer = new hre.ethers.Wallet(privateKey, hre.ethers.provider);
    } catch (error) {
      throw new Error(`${envName} bukan private key yang valid.`, { cause: error });
    }
    const signerAddress = hre.ethers.getAddress(signer.address);
    if (!expectedSet.has(signerAddress.toLowerCase())) {
      throw new Error(`${envName} bukan salah satu owner Safe yang dikonfigurasi.`);
    }
    if (signerAddresses.has(signerAddress.toLowerCase())) {
      throw new Error("Private key owner Safe harus berasal dari tiga owner yang berbeda.");
    }
    signerAddresses.add(signerAddress.toLowerCase());
    signers.push({ envName, privateKey, address: signerAddress });
  }
  if (signers.length < Number(threshold)) {
    throw new Error(
      `Butuh private key ${threshold} owner Safe yang berbeda. Isi SAFE_OWNER_1_PRIVATE_KEY sampai SAFE_OWNER_5_PRIVATE_KEY secara lokal di .env; tersedia ${signers.length}.`,
    );
  }

  const executorPrivateKey = process.env.PRIVATE_KEY?.trim();
  if (!executorPrivateKey) {
    throw new Error("PRIVATE_KEY diperlukan di .env untuk membayar gas eksekusi Safe.");
  }

  const safeModule = await import("@safe-global/protocol-kit");
  const Safe = safeModule.default;
  const safeKit = await Safe.init({
    provider: hre.network.provider,
    safeAddress,
  });
  const acceptOwnershipData = new hre.ethers.Interface(ACCEPT_OWNERSHIP_ABI)
    .encodeFunctionData("acceptOwnership");
  let safeTransaction = await safeKit.createTransaction({
    transactions: pendingAccepts.map(({ address }) => ({
      to: address,
      value: "0",
      data: acceptOwnershipData,
    })),
  });
  const safeTxHash = await safeKit.getTransactionHash(safeTransaction);
  console.log(`Safe: ${safeAddress}`);
  console.log(`Kontrak yang akan menerima ownership: ${pendingAccepts.map(({ label }) => label).join(", ")}`);
  console.log(`Safe transaction hash: ${safeTxHash}`);
  console.log(`Owner signers: ${signers.slice(0, Number(threshold)).map(({ address }) => address).join(", ")}`);
  console.log("Aksi: Safe memanggil acceptOwnership() untuk semua kontrak di atas.");

  for (const signerInfo of signers.slice(0, Number(threshold))) {
    const ownerSafe = await safeKit.connect({ signer: signerInfo.privateKey });
    safeTransaction = await ownerSafe.signTransaction(safeTransaction);
  }
  if (safeTransaction.signatures.size < Number(threshold)) {
    throw new Error("Jumlah tanda tangan Safe belum mencapai threshold.");
  }

  const readline = require("node:readline/promises");
  const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let confirmation;
  try {
    confirmation = await prompt.question(
      `Ketik ACCEPT ALL OWNERSHIP untuk mengeksekusi transaksi di ${suffix}: `,
    );
  } finally {
    prompt.close();
  }
  if (confirmation !== "ACCEPT ALL OWNERSHIP") {
    throw new Error("Eksekusi dibatalkan; tidak ada transaksi yang dikirim.");
  }

  const executorSafe = await safeKit.connect({ signer: executorPrivateKey });
  const result = await executorSafe.executeTransaction(safeTransaction);
  console.log(`Transaksi Safe dikirim: ${result.hash}`);
  let receipt = null;
  for (let attempt = 0; attempt < 60 && !receipt; attempt++) {
    receipt = await hre.ethers.provider.getTransactionReceipt(result.hash);
    if (!receipt) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!receipt || receipt.status !== 1) {
    throw new Error(
      `Receipt transaksi Safe belum sukses setelah 120 detik. Jangan jalankan ulang sebelum memeriksa hash ${result.hash}.`,
    );
  }
  for (const { address, label } of pendingAccepts) {
    const acceptedContract = new hre.ethers.Contract(
      address,
      ACCEPT_OWNERSHIP_ABI,
      hre.ethers.provider,
    );
    const newOwner = await acceptedContract.owner();
    if (newOwner.toLowerCase() !== safeAddress.toLowerCase()) {
      throw new Error(`Transaksi mined, tetapi owner ${label} belum berubah ke Safe: ${newOwner}`);
    }
    console.log(`${label} sekarang dimiliki Safe: ${newOwner}`);
  }
}

main().catch((error) => {
  console.error("Penerimaan ownership LPManager melalui Safe gagal:", error);
  process.exitCode = 1;
});
