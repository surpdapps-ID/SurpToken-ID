const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const root = path.resolve(__dirname, "..", "..");

function requestedNetwork() {
  const args = process.argv.slice(2);
  const networkArgument = args.findIndex((argument) => argument === "--network" || argument === "-n");
  const network = networkArgument >= 0
    ? args[networkArgument + 1]
    : args.find((argument) => argument.startsWith("--network="))?.split("=")[1];

  if (network === "polygonAmoy") return "amoy";
  if (network === "polygon") return "polygon";
  return null;
}

function loadEnv() {
  const commonPath = path.join(root, ".env");
  if (fs.existsSync(commonPath)) dotenv.config({ path: commonPath });

  const sharedConstants = require(path.join(root, "config", "shared.cjs"));
  for (const [key, value] of Object.entries(sharedConstants)) {
    if (process.env[key] === undefined) process.env[key] = String(value);
  }

  for (const key of Object.keys(process.env)) {
    const isRescueAmount = /^RESCUE_(LP|P2E)_AMOUNT_(AMOY|POLYGON)$/.test(key);
    const isNetworkScoped = /_AMOY$|_POLYGON$/.test(key);
    if ((isNetworkScoped && !isRescueAmount) || key.startsWith("DUAL_")) {
      delete process.env[key];
    }
  }

  for (const network of ["amoy", "polygon"]) {
    const networkConstants = require(path.join(root, "config", "networks", `${network}.cjs`));
    for (const [key, value] of Object.entries(networkConstants)) {
      process.env[key] = String(value);
    }

    const deploymentsPath = path.join(root, "deployments", `${network}.json`);
    if (fs.existsSync(deploymentsPath)) {
      let deployments;
      try {
        deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
      } catch (error) {
        throw new Error(`File deployments/${network}.json tidak valid: ${error.message}`, { cause: error });
      }
      for (const [key, value] of Object.entries(deployments)) {
        if (value === null || value === undefined) continue;
        process.env[key] = String(value);
      }
    }
  }

  const network = requestedNetwork();
  if (network) {
    const rpcVariable = network === "amoy" ? "AMOY_RPC" : "POLYGON_RPC_URL";
    if (!process.env[rpcVariable]) {
      throw new Error(`${rpcVariable} belum diisi di .env.`);
    }
  }
  return network;
}

module.exports = { loadEnv, requestedNetwork };
