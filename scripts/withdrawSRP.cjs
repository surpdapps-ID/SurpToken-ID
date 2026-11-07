const hre = require("hardhat");
const {
  assertConfiguredNetwork,
  networkEnv,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  console.log("====================================================");
  console.log("💧 LP MANAGER - WITHDRAW 30 JUTA TOKEN SRP");
  console.log("====================================================\n");

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Wallet Executer (Owner) : ${deployer.address}`);
  console.log(`Network                : ${suffix}`);

  // 1. Alamat Kontrak
  const LP_MANAGER_ADDRESS = requiredNetworkEnv(hre, "WITHDRAW_SRP_LP_MANAGER");
  const SRP_TOKEN_ADDRESS = requiredNetworkEnv(hre, "WITHDRAW_SRP_TOKEN");
  const withdrawAmountFormatted = networkEnv(hre, "WITHDRAW_SRP_AMOUNT");
  if (
    !hre.ethers.isAddress(LP_MANAGER_ADDRESS) ||
    !hre.ethers.isAddress(SRP_TOKEN_ADDRESS) ||
    !withdrawAmountFormatted
  ) {
    throw new Error(`Isi WITHDRAW_SRP_LP_MANAGER_${suffix}, WITHDRAW_SRP_TOKEN_${suffix}, dan WITHDRAW_SRP_AMOUNT_${suffix} di config/networks/${suffix.toLowerCase()}.cjs.`);
  }

  // 2. Load Contract LPManager & Token SRP Sesuai ABI LPManager.sol
  const lpManagerAbi = [
    "function releaseForLP(address to, uint256 amount) external",
    "function subsidizer() view returns (address)",
    "function setSubsidizer(address s) external"
  ];

  const lpManager = new hre.ethers.Contract(
    LP_MANAGER_ADDRESS,
    lpManagerAbi,
    deployer
  );
  const [lpManagerCode, tokenCode] = await Promise.all([
    hre.ethers.provider.getCode(LP_MANAGER_ADDRESS),
    hre.ethers.provider.getCode(SRP_TOKEN_ADDRESS),
  ]);
  if (lpManagerCode === "0x" || tokenCode === "0x") {
    throw new Error(`Alamat LP Manager atau token tidak memiliki bytecode pada jaringan ${suffix}.`);
  }

  const srpToken = await hre.ethers.getContractAt(
    "contracts/SurpSidy.sol:IERC20Custom",
    SRP_TOKEN_ADDRESS
  );

  // 3. Nominal Penarikan (30 JUTA SRP)
  const withdrawAmountRaw = hre.ethers.parseEther(withdrawAmountFormatted);
  if (withdrawAmountRaw <= 0n) {
    throw new Error(`WITHDRAW_SRP_AMOUNT_${suffix} harus lebih besar dari nol.`);
  }

  // 4. Cek Saldo SRP di LPManager
  const balanceRaw = await srpToken.balanceOf(LP_MANAGER_ADDRESS);
  console.log(`📍 LPManager Address     : ${LP_MANAGER_ADDRESS}`);
  console.log(`📊 Saldo SRP di LPManager: ${hre.ethers.formatUnits(balanceRaw, 18)} SRP`);
  console.log(`🎯 Target Penarikan     : ${withdrawAmountFormatted} SRP\n`);

  if (balanceRaw < withdrawAmountRaw) {
    console.log("⚠️ Saldo SRP di LPManager tidak mencukupi target penarikan!");
    return;
  }

  // 5. Eksekusi releaseForLP(to, amount)
  console.log(`⏳ Memulai penarikan ${withdrawAmountFormatted} SRP ke wallet ${deployer.address}...`);

  try {
    const tx = await lpManager.releaseForLP(deployer.address, withdrawAmountRaw);
    console.log(`-> TX dikirim! Hash: ${tx.hash}`);
    console.log("⏳ Menunggu konfirmasi block...");
    await tx.wait();

    // 6. Cek Saldo Akhir Wallet
    const walletBalance = await srpToken.balanceOf(deployer.address);
    console.log("\n====================================================");
    console.log("🎉 PENARIKAN 30 JUTA SRP BERHASIL!");
    console.log(`✅ Saldo SRP Wallet Terbaru: ${hre.ethers.formatUnits(walletBalance, 18)} SRP`);
    console.log("====================================================");

  } catch (error) {
    console.error("\n❌ Gagal eksekusi releaseForLP:", error.reason || error.message);
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Proses Gagal:", error);
    process.exit(1);
  });