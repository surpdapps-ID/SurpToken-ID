// require("@nomicfoundation/hardhat-ethers");
// require("@nomicfoundation/hardhat-verify");
// require("dotenv").config();

// module.exports = {
//   solidity: {
//     compilers: [
//       {
//         version: "0.8.20",
//         settings: {
//           optimizer: {
//             enabled: true,
//             runs: 200,
//           },
//           viaIR: true, // 🔥 TAMBAHKAN BARIS INI
//         },
//       },
//     ],
//   },

//   networks: {
//     polygon: {
//       url: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",

//       accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],

//       chainId: 137,
//     },
//   },

//   etherscan: {
//     // Hardhat 2 verify plugin
//     // pakai single API key
//     apiKey: process.env.POLYGONSCAN_API_KEY,

//     customChains: [
//       {
//         network: "polygon",

//         chainId: 137,

//         urls: {
//           // JANGAN pakai /v2/api di Hardhat 2
//           apiURL: "https://api.polygonscan.com/api",

//           browserURL: "https://polygonscan.com",
//         },
//       },
//     ],
//   },

//   sourcify: {
//     enabled: false,
//   },
// };
import { HardhatUserConfig } from 'hardhat/config'
import '@nomiclabs/hardhat-ethers'
import '@nomiclabs/hardhat-waffle'
import '@nomicfoundation/hardhat-verify'
import dotenv from 'dotenv'

dotenv.config()

const AMOY_RPC = process.env.AMOY_RPC || ''
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com'
const PRIVATE_KEY = process.env.PRIVATE_KEY || ''

const config: HardhatUserConfig = {
  solidity: {
    version: '0.7.6',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: false,
    },
  },

  networks: {
    amoy: {
      url: AMOY_RPC,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 80002,

      timeout: 60000,

      // ❌ ini bukan solusi ENS (hapus saja kalau ada masalah)
      // gasPrice: 'auto',
    },
    polygon: {
      url: POLYGON_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 137,
      timeout: 60000,
    },
  },

  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || process.env.POLYGONSCAN_API_KEY || '',

    customChains: [
      {
        network: 'amoy',
        chainId: 80002,
        urls: {
          apiURL: 'https://api-amoy.polygonscan.com/api',
          browserURL: 'https://amoy.polygonscan.com',
        },
      },
      {
        network: 'polygon',
        chainId: 137,
        urls: {
          apiURL: 'https://api.polygonscan.com/api',
          browserURL: 'https://polygonscan.com',
        },
      },
    ],
  },

  sourcify: {
    enabled: false,
  },

  mocha: {
    timeout: 200000,
  },
}

export default config
