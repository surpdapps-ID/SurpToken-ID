const selectedEnvNetwork = require("./scripts/utils/loadEnv.cjs").loadEnv();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");

const networks = {};
if (process.env.AMOY_RPC) {
  networks.polygonAmoy = {
    url: process.env.AMOY_RPC,
    accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    chainId: 80002,
  };
}
if (process.env.POLYGON_RPC_URL) {
  networks.polygon = {
    url: process.env.POLYGON_RPC_URL,
    accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    chainId: 137,
  };
}

module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      {
        version: "0.7.6",
        settings: {
          optimizer: {
            enabled: false,
            runs: 200,
          },
          metadata: {
            useLiteralContent: true,
          },
        },
      },
    ],
    overrides: {
      "contracts/proxies/SafeProxy.sol": {
        version: "0.7.6",
        settings: {
          optimizer: {
            enabled: false,
            runs: 200,
          },
          metadata: {
            useLiteralContent: true,
          },
        },
      },
    },
  },

  networks,

  etherscan: {
    apiKey: process.env.POLYGONSCAN_API_KEY,
  },

  sourcify: {
    enabled: false,
  },
};
