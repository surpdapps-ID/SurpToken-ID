const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertConfiguredNetwork,
  networkEnv,
  requiredNetworkEnv,
} = require("./utils/networkEnv.cjs");

const ROOT = path.resolve(__dirname, "..");

function pendingConfigPath(suffix) {
  return path.join(ROOT, "deployments", `pending-surpsidy-${suffix.toLowerCase()}.json`);
}

function savePendingConfigs(suffix, scheduled) {
  const filePath = pendingConfigPath(suffix);
  let existing = [];
  if (fs.existsSync(filePath)) {
    existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(existing)) {
      throw new Error(`File ${path.relative(ROOT, filePath)} harus berisi array.`);
    }
  }

  const nonces = new Set(existing.map((item) => String(item.nonce)));
  for (const item of scheduled) {
    if (nonces.has(item.nonce)) {
      throw new Error(`Nonce ${item.nonce} sudah tercatat di ${path.relative(ROOT, filePath)}.`);
    }
    nonces.add(item.nonce);
    existing.push(item);
  }

  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw new Error(`Gagal menyimpan jadwal SurpSidy: ${error.message}`, { cause: error });
  }
}

async function main() {
  const suffix = await assertConfiguredNetwork(hre);
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("Deployer tidak tersedia; isi PRIVATE_KEY di .env.");

  const addressFromEnv = (name, optional = false) => {
    const value = networkEnv(hre, name);
    if (!value && optional) return null;
    if (!value || !hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
      throw new Error(`${name}_${suffix} harus alamat valid${optional ? " atau kosong" : ""}.`);
    }
    return hre.ethers.getAddress(value);
  };
  const positiveInteger = (name) => {
    const value = networkEnv(hre, name);
    const number = Number(value);
    if (!value || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error(`${name}_${suffix} harus bilangan bulat positif.`);
    }
    return number;
  };
  const fee03 = positiveInteger("SURPSWAP_FEE_03");
  const fee1 = positiveInteger("SURPSWAP_FEE_1");
  const surpSwapFactory = hre.ethers.getAddress(
    requiredNetworkEnv(hre, "SURPSWAP_V3_FACTORY"),
  );
  const token = addressFromEnv("SURPSIDY_TOKEN_SRP");
  const weth = addressFromEnv("SURPSIDY_TOKEN_WETH9");
  const subsidizerAddress = addressFromEnv("CONTRACT_ADDRESS");
  const tokenB = addressFromEnv("SURPSIDY_TOKEN_B", true);
  const poolWeth03 = addressFromEnv("SURPSIDY_POOL_WETH9_03", true);
  const poolWeth1 = addressFromEnv("SURPSIDY_POOL_WETH9_1", true);
  const poolTokenB03 = addressFromEnv("SURPSIDY_TOKEN_B_POOL_03", true);
  const poolTokenB1 = addressFromEnv("SURPSIDY_TOKEN_B_POOL_1", true);
  if ((poolTokenB03 || poolTokenB1) && !tokenB) {
    throw new Error("Isi SURPSIDY_TOKEN_B sebelum mengatur pool token B.");
  }
  if (![fee03, fee1].every((fee) => fee === 3000 || fee === 10000) || fee03 === fee1) {
    throw new Error("SURPSWAP_FEE_03 dan SURPSWAP_FEE_1 harus masing-masing 3000 dan 10000.");
  }

  const subsidizer = new hre.ethers.Contract(
    subsidizerAddress,
    [
      "function owner() view returns (address)",
      "function tokenB() view returns (address)",
      "function feePools(uint24) view returns (address)",
      "function tokenBFeePools(uint24) view returns (address)",
      "function setTokenB(address)",
      "function setPoolAndTwap(uint24,address,uint32,uint24)",
      "function setTokenBPoolAndTwap(uint24,address,uint32,uint24)",
      "event ConfigOperationScheduled(bytes32 indexed operationId,uint256 indexed nonce,uint256 readyAt,bytes data)",
    ],
    deployer,
  );
  if ((await hre.ethers.provider.getCode(subsidizerAddress)) === "0x") {
    throw new Error(`CONTRACT_ADDRESS_${suffix} bukan kontrak di jaringan ini.`);
  }
  const owner = await subsidizer.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer bukan owner SurpSidy (${owner}); konfigurasi harus dijadwalkan oleh owner.`);
  }

  async function validatePool(poolAddress, otherToken, fee, label) {
    if ((await hre.ethers.provider.getCode(poolAddress)) === "0x") {
      throw new Error(`${label} ${poolAddress} bukan kontrak di jaringan ${suffix}.`);
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
    const [token0, token1, actualFee, actualFactory] = await Promise.all([
      pool.token0(),
      pool.token1(),
      pool.fee(),
      pool.factory(),
    ]);
    const expected0 = token.toLowerCase() < otherToken.toLowerCase() ? token : otherToken;
    const expected1 = expected0.toLowerCase() === token.toLowerCase() ? otherToken : token;
    if (
      token0.toLowerCase() !== expected0.toLowerCase() ||
      token1.toLowerCase() !== expected1.toLowerCase() ||
      BigInt(actualFee) !== BigInt(fee) ||
      actualFactory.toLowerCase() !== surpSwapFactory.toLowerCase()
    ) {
      throw new Error(`${label} bukan pool SurpSwap pasangan/fee yang diharapkan.`);
    }
  }

  for (const [pool, otherToken, fee, label] of [
    [poolWeth03, weth, fee03, "Pool SRP/WETH9 fee 3000"],
    [poolWeth1, weth, fee1, "Pool SRP/WETH9 fee 10000"],
    [poolTokenB03, tokenB, fee03, "Pool SRP/token B fee 3000"],
    [poolTokenB1, tokenB, fee1, "Pool SRP/token B fee 10000"],
  ]) {
    if (pool) await validatePool(pool, otherToken, fee, label);
  }

  const scheduled = [];
  const schedule = async (transaction, label) => {
    const receipt = await (await transaction).wait();
    const event = receipt.logs
      .map((log) => {
        try {
          return subsidizer.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "ConfigOperationScheduled");
    if (!event) throw new Error(`${label} tidak mengeluarkan event jadwal.`);
    scheduled.push({
      label,
      nonce: event.args.nonce.toString(),
      readyAt: event.args.readyAt.toString(),
      data: event.args.data,
    });
  };

  if (tokenB && (await subsidizer.tokenB()).toLowerCase() !== tokenB.toLowerCase()) {
    await schedule(subsidizer.setTokenB(tokenB), `Set token B ${tokenB}`);
  }

  for (const [pool, fee, label] of [
    [poolWeth03, fee03, "Pool SRP/WETH9 fee 3000"],
    [poolWeth1, fee1, "Pool SRP/WETH9 fee 10000"],
  ]) {
    if (!pool || (await subsidizer.feePools(fee)).toLowerCase() === pool.toLowerCase()) continue;
    await schedule(
      subsidizer.setPoolAndTwap(
        fee,
        pool,
        positiveInteger("SURPSIDY_POOL_WETH9_TWAP_INTERVAL"),
        positiveInteger("SURPSIDY_POOL_WETH9_CARDINALITY"),
      ),
      label,
    );
  }

  for (const [pool, fee, label] of [
    [poolTokenB03, fee03, "Pool SRP/token B fee 3000"],
    [poolTokenB1, fee1, "Pool SRP/token B fee 10000"],
  ]) {
    if (!pool || (await subsidizer.tokenBFeePools(fee)).toLowerCase() === pool.toLowerCase()) continue;
    await schedule(
      subsidizer.setTokenBPoolAndTwap(
        fee,
        pool,
        positiveInteger("SURPSIDY_POOL_TOKEN_B_TWAP_INTERVAL"),
        positiveInteger("SURPSIDY_POOL_TOKEN_B_CARDINALITY"),
      ),
      label,
    );
  }

  if (scheduled.length === 0) {
    console.log("Semua pool yang diisi sudah terkonfigurasi; tidak ada jadwal baru.");
    return;
  }
  savePendingConfigs(suffix, scheduled);
  console.log(`Konfigurasi pool SurpSidy ${suffix} dijadwalkan; tunggu minimal 24 jam.`);
  console.log("Setelah readyAt, jalankan command npm run execute:surpsidy-config untuk mengeksekusi jadwal yang sudah siap:");
  for (const item of scheduled) console.log(JSON.stringify(item));
  console.log("Pastikan eksekusi Set token B dilakukan sebelum konfigurasi pool token B.");
}

main().catch((error) => {
  console.error("Konfigurasi pool SurpSidy gagal:", error);
  process.exitCode = 1;
});
