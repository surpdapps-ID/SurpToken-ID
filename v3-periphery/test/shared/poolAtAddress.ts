import { abi as POOL_ABI } from '@uniswap/v3-core/artifacts/contracts/SurpSwapV3Pool.sol/SurpSwapV3Pool.json'
import { Contract, Wallet } from 'ethers'
import { ISurpSwapV3Pool } from '../../typechain'

export default function poolAtAddress(address: string, wallet: Wallet): ISurpSwapV3Pool {
  return new Contract(address, POOL_ABI, wallet) as ISurpSwapV3Pool
}
