import { BigNumber } from 'ethers'
import { ethers } from 'hardhat'
import { MockTimeSurpSwapV3Pool } from '../../typechain/MockTimeSurpSwapV3Pool'
import { TestERC20 } from '../../typechain/TestERC20'
import { SurpSwapFactory } from '../../typechain/SurpSwapFactory'
import { TestSurpSwapV3Callee } from '../../typechain/TestSurpSwapV3Callee'
import { TestSurpSwapV3Router } from '../../typechain/TestSurpSwapV3Router'
import { MockTimeSurpSwapV3PoolDeployer } from '../../typechain/MockTimeSurpSwapV3PoolDeployer'

import { Fixture } from 'ethereum-waffle'

interface FactoryFixture {
  factory: SurpSwapFactory
}

async function factoryFixture(): Promise<FactoryFixture> {
  const factoryFactory = await ethers.getContractFactory('SurpSwapFactory')
  const factory = (await factoryFactory.deploy()) as SurpSwapFactory
  return { factory }
}

interface TokensFixture {
  token0: TestERC20
  token1: TestERC20
  token2: TestERC20
}

async function tokensFixture(): Promise<TokensFixture> {
  const tokenFactory = await ethers.getContractFactory('TestERC20')
  const tokenA = (await tokenFactory.deploy(BigNumber.from(2).pow(255))) as TestERC20
  const tokenB = (await tokenFactory.deploy(BigNumber.from(2).pow(255))) as TestERC20
  const tokenC = (await tokenFactory.deploy(BigNumber.from(2).pow(255))) as TestERC20

  const [token0, token1, token2] = [tokenA, tokenB, tokenC].sort((tokenA, tokenB) =>
    tokenA.address.toLowerCase() < tokenB.address.toLowerCase() ? -1 : 1
  )

  return { token0, token1, token2 }
}

type TokensAndFactoryFixture = FactoryFixture & TokensFixture

interface PoolFixture extends TokensAndFactoryFixture {
  swapTargetCallee: TestSurpSwapV3Callee
  swapTargetRouter: TestSurpSwapV3Router
  createPool(
    fee: number,
    tickSpacing: number,
    firstToken?: TestERC20,
    secondToken?: TestERC20
  ): Promise<MockTimeSurpSwapV3Pool>
}

// Monday, October 5, 2020 9:00:00 AM GMT-05:00
export const TEST_POOL_START_TIME = 1601906400

export const poolFixture: Fixture<PoolFixture> = async function (): Promise<PoolFixture> {
  const { factory } = await factoryFixture()
  const { token0, token1, token2 } = await tokensFixture()

  const MockTimeSurpSwapV3PoolDeployerFactory = await ethers.getContractFactory('MockTimeSurpSwapV3PoolDeployer')
  const MockTimeSurpSwapV3PoolFactory = await ethers.getContractFactory('MockTimeSurpSwapV3Pool')

  const calleeContractFactory = await ethers.getContractFactory('TestSurpSwapV3Callee')
  const routerContractFactory = await ethers.getContractFactory('TestSurpSwapV3Router')

  const swapTargetCallee = (await calleeContractFactory.deploy()) as TestSurpSwapV3Callee
  const swapTargetRouter = (await routerContractFactory.deploy()) as TestSurpSwapV3Router

  return {
    token0,
    token1,
    token2,
    factory,
    swapTargetCallee,
    swapTargetRouter,
    createPool: async (fee, tickSpacing, firstToken = token0, secondToken = token1) => {
      const mockTimePoolDeployer = (await MockTimeSurpSwapV3PoolDeployerFactory.deploy()) as MockTimeSurpSwapV3PoolDeployer
      const tx = await mockTimePoolDeployer.deploy(
        factory.address,
        firstToken.address,
        secondToken.address,
        fee,
        tickSpacing
      )

      const receipt = await tx.wait()
      const poolAddress = receipt.events?.[0].args?.pool as string
      return MockTimeSurpSwapV3PoolFactory.attach(poolAddress) as MockTimeSurpSwapV3Pool
    },
  }
}
