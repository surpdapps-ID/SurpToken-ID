import { Fixture } from 'ethereum-waffle'
import { ethers } from 'hardhat'
import { v3RouterFixture } from './externalFixtures'
import { constants } from 'ethers'
import {
  IWETH9,
  MockTimeSurpSwapV3PositionManager,
  MockTimeSurpSwapV3SwapRouter,
  SurpSwapV3PositionDescriptor,
  TestERC20,
  ISurpSwapFactory,
} from '../../typechain'

const completeFixture: Fixture<{
  weth9: IWETH9
  factory: ISurpSwapFactory
  router: MockTimeSurpSwapV3SwapRouter
  nft: MockTimeSurpSwapV3PositionManager
  nftDescriptor: SurpSwapV3PositionDescriptor
  tokens: [TestERC20, TestERC20, TestERC20]
}> = async ([wallet], provider) => {
  const { weth9, factory, router } = await v3RouterFixture([wallet], provider)

  const tokenFactory = await ethers.getContractFactory('TestERC20')
  const tokens: [TestERC20, TestERC20, TestERC20] = [
    (await tokenFactory.deploy(constants.MaxUint256.div(2))) as TestERC20, // do not use maxu256 to avoid overflowing
    (await tokenFactory.deploy(constants.MaxUint256.div(2))) as TestERC20,
    (await tokenFactory.deploy(constants.MaxUint256.div(2))) as TestERC20,
  ]

  const nftDescriptorLibraryFactory = await ethers.getContractFactory('SurpSwapNFTDescriptor')
  const nftDescriptorLibrary = await nftDescriptorLibraryFactory.deploy()
  const positionDescriptorFactory = await ethers.getContractFactory('SurpSwapV3PositionDescriptor', {
    libraries: {
      SurpSwapNFTDescriptor: nftDescriptorLibrary.address,
    },
  })
  const nftDescriptor = (await positionDescriptorFactory.deploy(
    tokens[0].address,
    // 'ETH' as a bytes32 string
    '0x4554480000000000000000000000000000000000000000000000000000000000'
  )) as SurpSwapV3PositionDescriptor

  const positionManagerFactory = await ethers.getContractFactory('MockTimeSurpSwapV3PositionManager')
  const nft = (await positionManagerFactory.deploy(
    factory.address,
    weth9.address,
    nftDescriptor.address
  )) as MockTimeSurpSwapV3PositionManager

  tokens.sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))

  return {
    weth9,
    factory,
    router,
    tokens,
    nft,
    nftDescriptor,
  }
}

export default completeFixture
