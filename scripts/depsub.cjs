const hre = require("hardhat");
const { verifyDeployment } = require("./utils/verifyDeployment.cjs");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");
const {
  assertConfiguredNetwork,
  networkEnv,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");

async function main() {
  const suffix = await assertConfiguredNetwork(hre);

  const requiredEnv = (name) => {
    const value = requiredNetworkEnv(hre, name);
    if (!value || !hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
      throw new Error(`${name}_${suffix} di config/networks/${suffix.toLowerCase()}.cjs harus berisi alamat kontrak valid.`);
    }
    return hre.ethers.getAddress(value);
  };
  const configuredNumber = (name) => {
    const value = networkEnv(hre, name);
    const number = Number(value);
    if (!value || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error(`${name}_${suffix} di config/networks/${suffix.toLowerCase()}.cjs harus berupa bilangan bulat positif.`);
    }
    return number;
  };
  const TOKEN_SRP = requiredEnv("SURPSIDY_TOKEN_SRP");
  const TOKEN_WETH = requiredEnv("SURPSIDY_TOKEN_WETH9");
  const QUOTER_ADDRESS = requiredEnv("SURPSIDY_QUOTER");
  const QUOTER_V2_ADDRESS = requiredEnv("SURPSIDY_QUOTER_V2");
  const SWAP_ROUTER = requiredEnv("SURPSIDY_SWAP_ROUTER");
  const POSITION_MANAGER = requiredEnv("SURPSIDY_POSITION_MANAGER");
  const SURPSWAP_FACTORY = requiredEnv("SURPSWAP_V3_FACTORY");
  const LP_MANAGER = requiredEnv("SURPSIDY_LP_MANAGER");
  const POOL_FEE_03 = configuredNumber("SURPSWAP_FEE_03");
  const POOL_FEE_1 = configuredNumber("SURPSWAP_FEE_1");
  const verifyConfirmations = Number(process.env.DEPLOY_VERIFY_CONFIRMATIONS);
  if (!Number.isInteger(verifyConfirmations) || verifyConfirmations <= 0) {
    throw new Error("DEPLOY_VERIFY_CONFIRMATIONS di config/shared.cjs harus berupa bilangan bulat positif.");
  }

  const tokenBAddress = networkEnv(hre, "SURPSIDY_TOKEN_B");
  const tokenBPool03 = networkEnv(hre, "SURPSIDY_TOKEN_B_POOL_03");
  const tokenBPool1 = networkEnv(hre, "SURPSIDY_TOKEN_B_POOL_1");
  const poolAddress03 = networkEnv(hre, "SURPSIDY_POOL_WETH9_03");
  const poolAddress1 = networkEnv(hre, "SURPSIDY_POOL_WETH9_1");
  const hasTokenBPool = Boolean(tokenBPool03 || tokenBPool1);
  if (tokenBAddress && (!hre.ethers.isAddress(tokenBAddress) || tokenBAddress === hre.ethers.ZeroAddress)) {
    throw new Error(`SURPSIDY_TOKEN_B_${suffix} di config/networks/${suffix.toLowerCase()}.cjs harus berisi alamat token ERC-20 yang valid.`);
  }
  if (hasTokenBPool && !tokenBAddress) {
    throw new Error("Isi SURPSIDY_TOKEN_B sebelum mengonfigurasi pool token B.");
  }
  if (tokenBPool03 && (!hre.ethers.isAddress(tokenBPool03) || tokenBPool03 === hre.ethers.ZeroAddress)) {
    throw new Error("SURPSIDY_TOKEN_B_POOL_03 harus kosong atau berisi alamat pool SRP/token B fee 3000 yang valid.");
  }
  if (tokenBPool1 && (!hre.ethers.isAddress(tokenBPool1) || tokenBPool1 === hre.ethers.ZeroAddress)) {
    throw new Error(`SURPSIDY_TOKEN_B_POOL_1_${suffix} di config/networks/${suffix.toLowerCase()}.cjs harus kosong atau berisi alamat pool SRP/token B fee 10000 yang valid.`);
  }
  const TOKEN_B_ADDRESS = tokenBAddress ? hre.ethers.getAddress(tokenBAddress) : null;
  const TOKEN_B_POOL_03 = tokenBPool03 ? hre.ethers.getAddress(tokenBPool03) : null;
  const TOKEN_B_POOL_1 = tokenBPool1 ? hre.ethers.getAddress(tokenBPool1) : null;
  if (TOKEN_B_ADDRESS && (
    TOKEN_B_ADDRESS.toLowerCase() === TOKEN_SRP.toLowerCase() ||
    TOKEN_B_ADDRESS.toLowerCase() === TOKEN_WETH.toLowerCase()
  )) {
    throw new Error("TOKEN_B_ADDRESS harus berbeda dari SRP dan WETH.");
  }

  async function validatePool(poolAddress, tokenA, tokenB, expectedFee, label) {
    if ((await hre.ethers.provider.getCode(poolAddress)) === "0x") {
      throw new Error(`Alamat ${label} bukan kontrak pool: ${poolAddress}`);
    }
    const pool = new hre.ethers.Contract(
      poolAddress,
      [
        "function token0() view returns (address)",
        "function token1() view returns (address)",
        "function fee() view returns (uint24)",
        "function factory() view returns (address)",
      ],
      hre.ethers.provider,
    );
    const [token0, token1, fee, factoryAddress] = await Promise.all([
      pool.token0(),
      pool.token1(),
      pool.fee(),
      pool.factory(),
    ]);
    const expectedToken0 = tokenA.toLowerCase() < tokenB.toLowerCase() ? tokenA : tokenB;
    const expectedToken1 = expectedToken0.toLowerCase() === tokenA.toLowerCase() ? tokenB : tokenA;
    if (
      token0.toLowerCase() !== expectedToken0.toLowerCase() ||
      token1.toLowerCase() !== expectedToken1.toLowerCase() ||
      BigInt(fee) !== BigInt(expectedFee) ||
      factoryAddress.toLowerCase() !== SURPSWAP_FACTORY.toLowerCase()
    ) {
      throw new Error(`${label} ${poolAddress} bukan pool SurpSwap pasangan yang diharapkan dengan fee ${expectedFee}.`);
    }
  }

  if (TOKEN_B_ADDRESS && (await hre.ethers.provider.getCode(TOKEN_B_ADDRESS)) === "0x") {
    throw new Error(`SURPSIDY_TOKEN_B bukan kontrak: ${TOKEN_B_ADDRESS}`);
  }
  if (TOKEN_B_POOL_03) {
    await validatePool(TOKEN_B_POOL_03, TOKEN_SRP, TOKEN_B_ADDRESS, POOL_FEE_03, "Pool token B fee 3000");
  }
  if (TOKEN_B_POOL_1) {
    await validatePool(TOKEN_B_POOL_1, TOKEN_SRP, TOKEN_B_ADDRESS, POOL_FEE_1, "Pool token B");
  }
  if (poolAddress03 && !hre.ethers.isAddress(poolAddress03)) {
    throw new Error("SURPSIDY_POOL_WETH9_03 harus kosong atau alamat pool yang valid.");
  }
  if (poolAddress1 && !hre.ethers.isAddress(poolAddress1)) {
    throw new Error("SURPSIDY_POOL_WETH9_1 harus kosong atau alamat pool yang valid.");
  }
  if (poolAddress03) {
    await validatePool(hre.ethers.getAddress(poolAddress03), TOKEN_SRP, TOKEN_WETH, POOL_FEE_03, "Pool SRP/WETH9 fee 3000");
  }
  if (poolAddress1) {
    await validatePool(hre.ethers.getAddress(poolAddress1), TOKEN_SRP, TOKEN_WETH, POOL_FEE_1, "Pool SRP/WETH9 fee 10000");
  }
  for (const [label, address] of [
    ["SRP", TOKEN_SRP],
    ["WPOL", TOKEN_WETH],
    ["Quoter", QUOTER_ADDRESS],
    ["Quoter V2", QUOTER_V2_ADDRESS],
    ["Swap Router", SWAP_ROUTER],
    ["Position Manager", POSITION_MANAGER],
    ["SurpSwap Factory", SURPSWAP_FACTORY],
    ["LP Manager", LP_MANAGER],
  ]) {
    if ((await hre.ethers.provider.getCode(address)) === "0x") {
      throw new Error(`${label} bukan kontrak di jaringan ${suffix}: ${address}`);
    }
  }
  const peripheryFactoryAbi = ["function factory() view returns (address)"];
  for (const [label, address] of [
    ["Quoter", QUOTER_ADDRESS],
    ["Quoter V2", QUOTER_V2_ADDRESS],
    ["Swap Router", SWAP_ROUTER],
    ["Position Manager", POSITION_MANAGER],
  ]) {
    const endpoint = new hre.ethers.Contract(
      address,
      peripheryFactoryAbi,
      hre.ethers.provider,
    );
    if ((await endpoint.factory()).toLowerCase() !== SURPSWAP_FACTORY.toLowerCase()) {
      throw new Error(`${label} tidak menggunakan SurpSwap factory ${SURPSWAP_FACTORY}.`);
    }
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("Deployer tidak tersedia; isi PRIVATE_KEY di .env.");

  console.log("====================================================");
  console.log("Deploy & konfigurasi SurpSidy; ownership tetap pada deployer sampai Safe final.");
  console.log("====================================================\n");

  // 7 Constructor Arguments sesuai SurpSidy.sol
  const constructorArgs = [
    TOKEN_SRP,
    TOKEN_WETH,
    SWAP_ROUTER,
    POSITION_MANAGER,
    QUOTER_ADDRESS,
    QUOTER_V2_ADDRESS,
    LP_MANAGER,
  ];

  // 2. Eksekusi Deployment
  const SurpSidy = await hre.ethers.getContractFactory("SurpSidy");
  console.log("1. Sedang men-deploy kontrak ke Network...");

  const subsidizer = await SurpSidy.deploy(...constructorArgs);
  await subsidizer.waitForDeployment();

  const deployedAddress = await subsidizer.getAddress();
  persistNetworkEnv(hre, {
    CONTRACT_ADDRESS: deployedAddress,
  });
  console.log(`✅ Kontrak Berhasil Dideploy di Alamat: ${deployedAddress}\n`);
  console.log(`Config Timelock (delay 24 jam): ${await subsidizer.configTimelock()}\n`);

  const scheduleConfig = async (transaction, label) => {
    const receipt = await transaction.wait();
    const event = receipt.logs
      .map((log) => {
        try {
          return subsidizer.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "ConfigOperationScheduled");
    if (!event) {
      throw new Error(`Jadwal konfigurasi ${label} tidak mengeluarkan event.`);
    }
    console.log(`✅ ${label} dijadwalkan; aktif setelah 24 jam.`);
    console.log(`   Nonce: ${event.args.nonce}`);
    console.log(`   Data eksekusi: ${event.args.data}`);
  };

  // ============================================================
  // 🔥 SETTING DINAMIS: POOL & BUY MODES
  // ============================================================
  console.log("1.5 Menjadwalkan pool yang sudah tersedia...");
  const configuredPools = [];
  if (TOKEN_B_ADDRESS) {
    await scheduleConfig(
      subsidizer.setTokenB(TOKEN_B_ADDRESS),
      `Token B ${TOKEN_B_ADDRESS}`,
    );
  }
  if (TOKEN_B_POOL_03) {
    await scheduleConfig(
      subsidizer.setTokenBPoolAndTwap(
        POOL_FEE_03,
        TOKEN_B_POOL_03,
        configuredNumber("SURPSIDY_POOL_TOKEN_B_TWAP_INTERVAL"),
        configuredNumber("SURPSIDY_POOL_TOKEN_B_CARDINALITY"),
      ),
      `Pool SRP/token B fee ${POOL_FEE_03}`,
    );
    configuredPools.push("token B 3000");
  }
  if (TOKEN_B_POOL_1) {
    await scheduleConfig(
      subsidizer.setTokenBPoolAndTwap(
        POOL_FEE_1,
        TOKEN_B_POOL_1,
        configuredNumber("SURPSIDY_POOL_TOKEN_B_TWAP_INTERVAL"),
        configuredNumber("SURPSIDY_POOL_TOKEN_B_CARDINALITY"),
      ),
      `Pool SRP/token B fee ${POOL_FEE_1}`,
    );
    configuredPools.push("token B 10000");
  }

  for (const [fee, poolAddress, label] of [
    [POOL_FEE_03, poolAddress03, "WETH9 3000"],
    [POOL_FEE_1, poolAddress1, "WETH9 10000"],
  ]) {
    if (!poolAddress) continue;
    await scheduleConfig(
      subsidizer.setPoolAndTwap(
        fee,
        hre.ethers.getAddress(poolAddress),
        configuredNumber("SURPSIDY_POOL_WETH9_TWAP_INTERVAL"),
        configuredNumber("SURPSIDY_POOL_WETH9_CARDINALITY"),
      ),
      `Pool SRP/WETH9 fee ${fee}`,
    );
    configuredPools.push(label);
  }
  if (configuredPools.length === 0) {
    console.log("Belum ada pool SurpSidy dijadwalkan; isi alamat pool setelah add LP, lalu jalankan configure:surpsidy-pools.");
  }

  // C. Aktifkan Semua Buy Mode Secara Eksplisit (Dinamis / BISA AKTIF SEMUA)
  // Index Enum: 0 = LP_FIRST, 1 = SWAP_FIRST, 2 = PURE_SWAP, 3 = LP50_SWAP50
  console.log("   -> Memastikan semua 4 Buy Mode aktif...");
  for (let modeIndex = 0; modeIndex <= 3; modeIndex++) {
    const txMode = await subsidizer.setBuyModeEnabled(modeIndex, true);
    await txMode.wait();
  }
  console.log("      ✅ Semua Buy Mode (0, 1, 2, 3) aktif.");
  console.log("      ⚠️ Buy tetap revert sampai pool yang dibutuhkan dikonfigurasi dan jeda 24 jam selesai.\n");

  const lpManager = new hre.ethers.Contract(
    LP_MANAGER,
    [
      "function owner() view returns (address)",
      "function subsidizer() view returns (address)",
      "function setSubsidizer(address) external",
    ],
    deployer,
  );
  const configuredSubsidizer = await lpManager.subsidizer();
  if (configuredSubsidizer.toLowerCase() !== deployedAddress.toLowerCase()) {
    const lpManagerOwner = await lpManager.owner();
    if (lpManagerOwner.toLowerCase() === deployer.address.toLowerCase()) {
      const setSubsidizerTx = await lpManager.setSubsidizer(deployedAddress);
      await setSubsidizerTx.wait();
      if ((await lpManager.subsidizer()).toLowerCase() !== deployedAddress.toLowerCase()) {
        throw new Error("LPManager gagal dikonfigurasi untuk SurpSidy baru.");
      }
      console.log("✅ LPManager terhubung ke kontrak SurpSidy.\n");
    } else {
      console.warn(
        `⚠️ LPManager dimiliki ${lpManagerOwner}. Owner LPManager harus mengatur subsidizer ke ${deployedAddress} sebelum mode LP dapat digunakan.`,
      );
    }
  } else {
    console.log("✅ LPManager sudah terhubung ke kontrak SurpSidy.\n");
  }
  persistNetworkEnv(hre, {
    LP_MANAGER_SUBSIDIZER: await lpManager.subsidizer(),
  });

  console.log("Ownership SurpSidy tetap di wallet deployer sampai tahap finalize ownership Safe.");

  // ============================================================
  // 3. Menunggu Konfirmasi Blok untuk Verifikasi
  // ============================================================
  console.log("2. Menunggu 5 konfirmasi block...");
  await subsidizer.deploymentTransaction().wait(verifyConfirmations);

  // 4. Verifikasi Otomatis
  console.log("3. Memulai proses verifikasi ke Explorer...");
  await verifyDeployment(hre, {
    address: deployedAddress,
    constructorArguments: constructorArgs,
    contract: "contracts/SurpSidy.sol:SurpSidy",
  });
  console.log("\n🎉 SEMUA SELESAI: Contract Aktif, Config Dinamis Siap, & Diverifikasi!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Proses Gagal:", error);
    process.exit(1);
  });