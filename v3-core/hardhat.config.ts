import '@nomiclabs/hardhat-ethers'
import '@nomiclabs/hardhat-waffle'
import '@nomicfoundation/hardhat-verify'
import 'hardhat-typechain'
import dotenv from 'dotenv'

dotenv.config()

export default {
  solidity: {
    version: '0.7.6',
    settings: {
      optimizer: {
        enabled: true,
        runs: 800,
      },
      metadata: {
        bytecodeHash: 'none',
      },
    },
  },

  networks: {
    polygon: {
      url: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
      chainId: 137,
      accounts: process.env.PRIVATE_KEY?.trim() ? [process.env.PRIVATE_KEY.trim()] : [],
    },
    amoy: {
      url: process.env.AMOY_RPC || 'https://rpc-amoy.polygon.technology',
      chainId: 80002,
      accounts: process.env.PRIVATE_KEY?.trim() ? [process.env.PRIVATE_KEY.trim()] : [],
    },
  },

  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || process.env.POLYGONSCAN_API_KEY,
  },
}
