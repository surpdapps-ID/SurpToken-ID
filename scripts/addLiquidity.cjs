const hre = require("hardhat");
const { ethers } = hre;
const {
  assertConfiguredNetwork,
  networkEnv,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");
const { persistNetworkEnv } = require("./utils/persistEnv.cjs");

// ================= ABI LENGKAP
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function initialize(uint160 sqrtPriceX96) external",
];

const FACTORY_ABI = [
  "function getPool(address,address,uint24) view returns (address)",
  "function createPool(address tokenA, address tokenB, uint24 fee) external returns (address)",
];

const POSITION_MANAGER_ABI = [
  "function factory() view returns (address)",
  "function mint(tuple(address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) external payable returns (uint256,uint128,uint256,uint256)",
];

const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const WETH_ABI = [
  "function deposit() payable",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const LP_MANAGER_ABI = [
  "function releaseForLP(address to, uint256 amount) external",
];

// ================= MAIN EXECUTION
async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const [deployer] = await ethers.getSigners();
  const profileName = networkEnv(hre, "ADD_LIQ_PROFILE") || "wpol03";
  const config = (name) => networkEnv(hre, name);
  const profiles = {
    wpol03: {
      tokenA: config("ADD_LIQ_TOKEN_A_WPOL"),
      tokenB: config("ADD_LIQ_TOKEN_B_WPOL"),
      lpManager: config("ADD_LIQ_LP_MANAGER_WPOL"),
      fee: config("ADD_LIQ_FEE_WPOL_03"),
      amountA: config("ADD_LIQ_AMOUNT_A_WPOL_03"),
      amountB: config("ADD_LIQ_AMOUNT_B_WPOL_03"),
      wrapNative: true,
    },
    wpol1: {
      tokenA: config("ADD_LIQ_TOKEN_A_WPOL"),
      tokenB: config("ADD_LIQ_TOKEN_B_WPOL"),
      lpManager: config("ADD_LIQ_LP_MANAGER_WPOL"),
      fee: config("ADD_LIQ_FEE_WPOL_1"),
      amountA: config("ADD_LIQ_AMOUNT_A_WPOL_1"),
      amountB: config("ADD_LIQ_AMOUNT_B_WPOL_1"),
      wrapNative: true,
    },
  };
  const profile = profiles[profileName];
  if (!profile) {
    throw new Error(`ADD_LIQ_PROFILE tidak dikenal: ${profileName}`);
  }
  for (const key of ["tokenA", "tokenB", "lpManager", "fee", "amountA", "amountB"]) {
    if (!profile[key]) {
      throw new Error(`Konfigurasi ${key} untuk profil ${profileName} wajib diisi pada network ${suffix}.`);
    }
  }

  console.log("====================================================");
  console.log(`💧 SURPSWAP V3 - ADD LIQUIDITY (${profileName})`);
  console.log(`Network: ${suffix}`);
  console.log("Wallet Deployer:", deployer.address);
  console.log("====================================================");

  // DEKLARASI ALAMAT KONTRAK
  const TOKEN = profile.tokenA;
  const WETH = profile.tokenB;
  const PM = requiredNetworkEnv(hre, "ADD_LIQ_POSITION_MANAGER");
  const LP_MANAGER_ADDRESS = profile.lpManager;
  if (
    ![TOKEN, WETH, PM, LP_MANAGER_ADDRESS].every(ethers.isAddress) ||
    TOKEN.toLowerCase() === WETH.toLowerCase()
  ) {
    throw new Error(`Alamat token/manager untuk profil ${profileName} tidak valid atau belum diisi di config/networks/${suffix.toLowerCase()}.cjs.`);
  }

  const fee = Number(profile.fee);
  if (!Number.isInteger(fee) || fee <= 0 || !profile.amountA || !profile.amountB) {
    throw new Error(`Fee dan jumlah token untuk profil ${profileName} wajib diisi dengan nilai valid di config/networks/${suffix.toLowerCase()}.cjs.`);
  }

  // INISIALISASI INSTANCE KONTRAK
  const token = new ethers.Contract(TOKEN, ERC20_ABI, deployer);
  const weth = new ethers.Contract(WETH, profile.wrapNative ? WETH_ABI : ERC20_ABI, deployer);
  const pm = new ethers.Contract(PM, POSITION_MANAGER_ABI, deployer);
  const surpSwapFactory = ethers.getAddress(requiredNetworkEnv(hre, "SURPSWAP_V3_FACTORY"));
  if ((await ethers.provider.getCode(surpSwapFactory)) === "0x") {
    throw new Error(`SurpSwap factory bukan kontrak di ${suffix}: ${surpSwapFactory}`);
  }
  if ((await pm.factory()).toLowerCase() !== surpSwapFactory.toLowerCase()) {
    throw new Error(`Position Manager ${PM} tidak menggunakan SurpSwap factory ${surpSwapFactory}.`);
  }
  const lpManager = new ethers.Contract(
    LP_MANAGER_ADDRESS,
    LP_MANAGER_ABI,
    deployer,
  );
  const [decimalsA, decimalsB] = await Promise.all([
    token.decimals(),
    weth.decimals(),
  ]);
  if (profile.wrapNative && decimalsB !== 18n) {
    throw new Error("Token wrapped-native untuk profil ini harus memiliki 18 desimal.");
  }
  const jumlahSRP = ethers.parseUnits(profile.amountA, decimalsA);
  const jumlahWETH = ethers.parseUnits(profile.amountB, decimalsB);
  if (jumlahSRP <= 0n || jumlahWETH <= 0n) {
    throw new Error(`Jumlah token untuk profil ${profileName} harus lebih besar dari nol.`);
  }
  const token0 = TOKEN.toLowerCase() < WETH.toLowerCase() ? TOKEN : WETH;
  const token1 = token0 === TOKEN ? WETH : TOKEN;
  const amount0Desired = token0 === TOKEN ? jumlahSRP : jumlahWETH;
  const amount1Desired = token1 === TOKEN ? jumlahSRP : jumlahWETH;
  const minimumAmount = (name, desired) => {
    const configured = requiredNetworkEnv(hre, name);
    if (configured.toUpperCase() !== "AUTO") {
      return BigInt(configured);
    }
    const slippageBps = Number(requiredNetworkEnv(hre, "ADD_LIQ_SLIPPAGE_BPS"));
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10000) {
      throw new Error("ADD_LIQ_SLIPPAGE_BPS harus integer antara 0 dan 9999.");
    }
    return (desired * BigInt(10000 - slippageBps)) / 10000n;
  };
  const amount0Min = minimumAmount("ADD_LIQ_MIN_AMOUNT0", amount0Desired);
  const amount1Min = minimumAmount("ADD_LIQ_MIN_AMOUNT1", amount1Desired);
  if (amount0Min < 0n || amount1Min < 0n ||
      amount0Min > amount0Desired || amount1Min > amount1Desired) {
    throw new Error("Minimum amounts harus non-negatif dan tidak boleh melebihi desired amounts.");
  }
  if (suffix === "POLYGON" && (amount0Min <= 0n || amount1Min <= 0n)) {
    throw new Error("ADD_LIQ_MIN_AMOUNT0_POLYGON dan ADD_LIQ_MIN_AMOUNT1_POLYGON harus lebih besar dari nol.");
  }
  if (![100, 500, 3000, 10000].includes(fee)) {
    throw new Error(`Fee SurpSwap V3 tidak didukung: ${fee}.`);
  }
  const deadlineSeconds = Number(requiredNetworkEnv(hre, "ADD_LIQ_DEADLINE_SECONDS"));
  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds <= 0) {
    throw new Error("ADD_LIQ_DEADLINE_SECONDS harus berupa bilangan bulat positif.");
  }

  if (suffix === "POLYGON") {
    for (const [label, address] of [
      ["token A", TOKEN],
      ["token B", WETH],
      ["Position Manager", PM],
      ["LP Manager", LP_MANAGER_ADDRESS],
    ]) {
      if ((await ethers.provider.getCode(address)) === "0x") {
        throw new Error(`${label} bukan kontrak di Polygon mainnet: ${address}`);
      }
    }
    const factoryAddress = await pm.factory();
    if ((await ethers.provider.getCode(factoryAddress)) === "0x") {
      throw new Error(`Factory Position Manager bukan kontrak di Polygon mainnet: ${factoryAddress}`);
    }
    const mainnetFactory = new ethers.Contract(factoryAddress, FACTORY_ABI, ethers.provider);
    const mainnetPoolAddress = await mainnetFactory.getPool(token0, token1, fee);
    if (mainnetPoolAddress === ethers.ZeroAddress) {
      throw new Error("Pool SurpSwap V3 belum ada; buat/initialize pool secara terpisah sebelum menambah LP.");
    }
    if ((await ethers.provider.getCode(mainnetPoolAddress)) === "0x") {
      throw new Error(`Pool SurpSwap V3 bukan kontrak: ${mainnetPoolAddress}`);
    }
    const mainnetPool = new ethers.Contract(mainnetPoolAddress, POOL_ABI, ethers.provider);
    const mainnetSlot0 = await mainnetPool.slot0();
    if (mainnetSlot0.sqrtPriceX96 === 0n) {
      throw new Error("Pool Polygon mainnet belum diinisialisasi; atur harga awal secara terpisah sebelum menambah LP.");
    }
  }

  // ================= 1. OTOMATIS AMBIL SRP DARI LPMANAGER
  const walletTokenBalance = await token.balanceOf(deployer.address);
  if (walletTokenBalance < jumlahSRP) {
    const managerTokenBalance = await token.balanceOf(LP_MANAGER_ADDRESS);
    if (managerTokenBalance < jumlahSRP) {
      throw new Error("Saldo SRP di wallet dan LPManager tidak mencukupi jumlah yang diminta.");
    }
    console.log(
      `Mengeksekusi releaseForLP dari LPManager sebesar ${ethers.formatUnits(jumlahSRP, decimalsA)} token...`,
    );
    const txRelease = await lpManager.releaseForLP(deployer.address, jumlahSRP);
    console.log("-> TX Release dikirim:", txRelease.hash);
    await txRelease.wait();
    console.log("✅ Token SRP berhasil ditarik otomatis ke wallet.");
  } else {
    console.log("Saldo token di wallet cukup; releaseForLP tidak diperlukan.");
  }

  if (profile.wrapNative) {
    console.log(`\nWrapping ${ethers.formatUnits(jumlahWETH, decimalsB)} POL menjadi WPOL...`);
    await (await weth.deposit({ value: jumlahWETH })).wait();
  }

  // ================= 3. VALIDASI SALDO DOMPET
  console.log("\nMemeriksa isi dompet Anda...");
  const saldoSRP = await token.balanceOf(deployer.address);
  const saldoWETH = await weth.balanceOf(deployer.address);

  console.log("-> Saldo token A Anda  :", ethers.formatUnits(saldoSRP, decimalsA));
  console.log("-> Saldo token B Anda:", ethers.formatUnits(saldoWETH, decimalsB));

  if (saldoSRP < jumlahSRP) {
    throw new Error("Saldo token A di wallet tidak mencukupi.");
  }
  if (saldoWETH < jumlahWETH) {
    throw new Error("Saldo token B di wallet tidak mencukupi.");
  }
  console.log("✅ Saldo terverifikasi aman.");

  // ================= 4. APPROVAL
  console.log("\nMemberikan izin akses token (Approve) ke Position Manager...");
  await (await token.approve(PM, jumlahSRP)).wait();
  await (await weth.approve(PM, jumlahWETH)).wait();
  console.log("✅ Approve Berhasil.");

  // ================= 5. URUTKAN TOKEN
  // ================= 6. DAPATKAN / BUAT POOL BARU VIA FACTORY
  const factoryAddress = await pm.factory();
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, deployer);

  let poolAddress = await factory.getPool(token0, token1, fee);

  if (poolAddress === ethers.ZeroAddress) {
    if (suffix === "POLYGON") {
      throw new Error("Pool SurpSwap V3 belum ada; buat/initialize pool secara terpisah sebelum menambah LP.");
    }
    console.log(
      `\n-> Pool kelompok fee ${fee} belum ada. Membuat pool baru...`,
    );
    const txCreate = await factory.createPool(token0, token1, fee);
    await txCreate.wait();
    poolAddress = await factory.getPool(token0, token1, fee);
  }

  console.log("-> Pool Address Aktif:", poolAddress);

  const pool = new ethers.Contract(poolAddress, POOL_ABI, deployer);
  let slot0 = await pool.slot0();

  // ================= 7. HITUNG DAN INITIALIZE HARGA BERDASARKAN RASIO ASLI (Bukan 1/1)
  if (slot0.sqrtPriceX96.toString() === "0") {
    if (suffix === "POLYGON") {
      throw new Error("Pool Polygon mainnet belum diinisialisasi; atur harga awal secara terpisah sebelum menambah LP.");
    }
    console.log(
      "-> Pool masih perawan. Menghitung harga awal dari rasio input...",
    );

    // Menentukan jumlah berdasarkan urutan token0 dan token1 pool.
    const r0 = token0 === TOKEN ? jumlahSRP : jumlahWETH;
    const r1 = token1 === TOKEN ? jumlahSRP : jumlahWETH;
    const decimals0 = token0 === TOKEN ? decimalsA : decimalsB;
    const decimals1 = token1 === TOKEN ? decimalsA : decimalsB;

    // Rumus: sqrtPriceX96 = sqrt(price) * 2^96 = sqrt(r1 / r0) * 2^96
    const priceRatio =
      (Number(r1) / Number(r0)) * 10 ** (Number(decimals0) - Number(decimals1));
    const sqrtPrice = Math.sqrt(priceRatio);
    const q96 = BigInt(2) ** BigInt(96);

    // Konversi hasil akhir ke format string BigInt untuk dikirim ke blockchain
    const calculatedSqrtPriceX96 = BigInt(
      Math.floor(sqrtPrice * Number(q96)),
    ).toString();

    console.log(
      `-> Menyuntikkan harga awal (sqrtPriceX96): ${calculatedSqrtPriceX96}`,
    );
    await (await pool.initialize(calculatedSqrtPriceX96)).wait();
    slot0 = await pool.slot0();
    console.log("-> Harga Pool Sukses Di-set:", slot0.sqrtPriceX96.toString());
  }

  // ================= 8. SETTING RANGE TICK LIKUIDITAS FULL RANGE
  const tickSpacing = await pool.tickSpacing();
  const tickLower =
    Math.ceil(-887220 / Number(tickSpacing)) * Number(tickSpacing);
  const tickUpper =
    Math.floor(887220 / Number(tickSpacing)) * Number(tickSpacing);
  if (tickLower >= tickUpper) {
    throw new Error("Rentang tick tidak valid untuk tickSpacing pool ini.");
  }

  const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;

  const mintParams = {
    token0: token0,
    token1: token1,
    fee: fee,
    tickLower: tickLower,
    tickUpper: tickUpper,
    amount0Desired: amount0Desired,
    amount1Desired: amount1Desired,
    amount0Min,
    amount1Min,
    recipient: deployer.address,
    deadline: deadline,
  };

  console.log(
    `\n-> Menyusun Pasokan Likuiditas: amount0=${ethers.formatUnits(amount0Desired, token0 === TOKEN ? decimalsA : decimalsB)}, amount1=${ethers.formatUnits(amount1Desired, token1 === TOKEN ? decimalsA : decimalsB)}`,
  );

  // ================= 9. SIMULASI SEBELUM TERBANG
  console.log("\nMelakukan simulasi transaksi (Static Call)...");
  try {
    await pm.mint.staticCall(mintParams);
    console.log("✅ SIMULASI 100% AMAN (Rasio harga & pasokan sinkron)");
  } catch (e) {
    console.log("❌ SIMULASI REVERT:");
    if (e.data) console.log("Hex Data Error:", e.data);
    console.dir(e, { depth: 1 });
    throw e;
  }

  // ================= 10. TEMBAK REAL TRANSACTION
  console.log(`\nMengirim transaksi mint ke Polygon ${suffix}...`);
  const tx = await pm.mint(mintParams);
  console.log("-> TX Hash dikirim:", tx.hash);
  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    throw new Error(`Transaksi add-LP gagal/revert: ${tx.hash}`);
  }

  const matchesPair = (configuredTokenA, configuredTokenB) => {
    if (!configuredTokenA || !configuredTokenB ||
        !ethers.isAddress(configuredTokenA) || !ethers.isAddress(configuredTokenB)) {
      return false;
    }
    const configured0 = configuredTokenA.toLowerCase();
    const configured1 = configuredTokenB.toLowerCase();
    return (
      (configured0 === TOKEN.toLowerCase() && configured1 === WETH.toLowerCase()) ||
      (configured0 === WETH.toLowerCase() && configured1 === TOKEN.toLowerCase())
    );
  };

  let surpSidyPoolOutput;
  if (matchesPair(networkEnv(hre, "SURPSIDY_TOKEN_SRP"), networkEnv(hre, "SURPSIDY_TOKEN_WETH9"))) {
    const fee03 = Number(networkEnv(hre, "SURPSWAP_FEE_03"));
    const fee1 = Number(networkEnv(hre, "SURPSWAP_FEE_1"));
    if (fee === fee03) surpSidyPoolOutput = "SURPSIDY_POOL_WETH9_03";
    if (fee === fee1) surpSidyPoolOutput = "SURPSIDY_POOL_WETH9_1";
  } else if (matchesPair(networkEnv(hre, "SURPSIDY_TOKEN_SRP"), networkEnv(hre, "SURPSIDY_TOKEN_B"))) {
    const fee03 = Number(networkEnv(hre, "SURPSWAP_FEE_03"));
    const fee1 = Number(networkEnv(hre, "SURPSWAP_FEE_1"));
    if (fee === fee03) surpSidyPoolOutput = "SURPSIDY_TOKEN_B_POOL_03";
    if (fee === fee1) surpSidyPoolOutput = "SURPSIDY_TOKEN_B_POOL_1";
  }

  const outputValues = { ADD_LIQ_POOL_ADDRESS: poolAddress };
  if (
    matchesPair(
      networkEnv(hre, "SURPSIDY_TOKEN_SRP"),
      networkEnv(hre, "SURPSIDY_TOKEN_WETH9"),
    )
  ) {
    outputValues.SRP_WETH9_POOL = poolAddress;
  }
  if (surpSidyPoolOutput) outputValues[surpSidyPoolOutput] = poolAddress;
  persistNetworkEnv(hre, outputValues);
  console.log(`Pool add-LP otomatis disimpan ke constants jaringan: ADD_LIQ_POOL_ADDRESS_${suffix}`);
  if (surpSidyPoolOutput) {
    console.log(`Pool SurpSidy otomatis disimpan ke ${surpSidyPoolOutput}_${suffix}.`);
  } else {
    console.log("Pasangan token tidak cocok dengan token SurpSidy; hanya output ADD_LIQ_POOL_ADDRESS yang diperbarui.");
  }
  console.log("\n====================================================");
  console.log("✅ LIQUIDITY DAN RASIO HARGA BERHASIL DITAMBAHKAN!");
  console.log("====================================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
