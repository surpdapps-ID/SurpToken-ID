const fs = require("node:fs");
const path = require("node:path");

function readNetworkConstants(network) {
  const constantsPath = path.resolve(__dirname, "..", "..", "config", "networks", `${network}.cjs`);
  try {
    const modulePath = require.resolve(constantsPath);
    delete require.cache[modulePath];
    const constants = require(modulePath);
    if (!constants || typeof constants !== "object" || Array.isArray(constants)) {
      throw new Error("Konfigurasi harus berupa object.");
    }
    return { constantsPath, constants: { ...constants } };
  } catch (error) {
    throw new Error(`Constants config/networks/${network}.cjs tidak valid: ${error.message}`, { cause: error });
  }
}

function persistDeploymentValues(network, values) {
  if (network !== "amoy" && network !== "polygon") {
    throw new Error(`Network deployment tidak valid: ${network}`);
  }
  const { constantsPath, constants } = readNetworkConstants(network);
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(`Nama output deployment tidak valid: ${key}`);
    }
    constants[key] = String(value);
  }

  const deploymentsPath = path.resolve(__dirname, "..", "..", "deployments", `${network}.json`);
  let contents = {};
  if (fs.existsSync(deploymentsPath)) {
    try {
      contents = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    } catch (error) {
      throw new Error(`File deployments/${network}.json tidak valid: ${error.message}`, { cause: error });
    }
  }
  for (const [key, value] of Object.entries(values)) {
    contents[key] = String(value);
  }

  const deploymentTemporaryPath = `${deploymentsPath}.${process.pid}.tmp`;
  const constantsTemporaryPath = `${constantsPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(deploymentsPath), { recursive: true });
    const comment = fs.readFileSync(constantsPath, "utf8").match(/^\/\/.*\n/)?.[0] ?? "";
    fs.writeFileSync(
      constantsTemporaryPath,
      `${comment}module.exports = Object.freeze(${JSON.stringify(constants, null, 2)});\n`,
      { mode: 0o644 },
    );
    fs.writeFileSync(deploymentTemporaryPath, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(constantsTemporaryPath, constantsPath);
    fs.renameSync(deploymentTemporaryPath, deploymentsPath);
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = String(value);
    }
  } catch (error) {
    if (fs.existsSync(constantsTemporaryPath)) fs.unlinkSync(constantsTemporaryPath);
    if (fs.existsSync(deploymentTemporaryPath)) fs.unlinkSync(deploymentTemporaryPath);
    throw new Error(`Gagal menyimpan output ${network}: ${error.message}`, { cause: error });
  }
}

function persistNetworkEnv(hre, values) {
  const chainId = hre.network.config.chainId;
  const network = chainId === 80002 ? "amoy" : chainId === 137 ? "polygon" : null;
  const suffix = network === "amoy" ? "AMOY" : network === "polygon" ? "POLYGON" : null;
  if (!network || !suffix) throw new Error(`Network tidak didukung untuk menyimpan alamat (chain ID ${chainId}).`);

  persistDeploymentValues(
    network,
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name.startsWith("DUAL_") ? name : `${name}_${suffix}`,
        value,
      ]),
    ),
  );
}

module.exports = { persistDeploymentValues, persistNetworkEnv, readNetworkConstants };
