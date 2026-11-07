import hardhat from 'hardhat'
import { saveDeploymentOutput } from './saveDeploymentOutput'

const { ethers, network } = hardhat

const DEPLOYMENT_CONFIGS: Record<
  string,
  {
    chainId: number
    factory: string
    weth9: string
    nativeCurrencyLabel: string
    confirmationVariable: string
  }
> = {
  amoy: {
    chainId: 80002,
    factory: '0x98Fc69014c04Fa5E8F46a96FDc5614876f312334',
    weth9: '0x81e6D597F2c5A4144e9C2ACa8c516bc9A5891e5F',
    nativeCurrencyLabel: 'ETH',
    confirmationVariable: 'CONFIRM_AMOY_PERIPHERY_DEPLOY',
  },
  polygon: {
    chainId: 137,
    factory: '0x0dB995B73CeA857cEB24c7B3135eC9a64A12e0c6',
    weth9: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    nativeCurrencyLabel: 'POL',
    confirmationVariable: 'CONFIRM_POLYGON_PERIPHERY_DEPLOY',
  },
}

async function deploy(name: string, args: string[] = [], libraries?: Record<string, string>) {
  const factory = await ethers.getContractFactory(name, libraries ? { libraries } : {})
  const contract = await factory.deploy(...args)
  await contract.deployed()
  console.log(`${name}: ${contract.address}`)
  return contract
}

async function main() {
  const deploymentConfig = DEPLOYMENT_CONFIGS[network.name]
  if (!deploymentConfig) {
    throw new Error(`Refusing deployment on "${network.name}"; use --network amoy or --network polygon.`)
  }

  const { chainId } = await ethers.provider.getNetwork()
  if (chainId !== deploymentConfig.chainId) {
    throw new Error(`Wrong chain ID ${chainId}; expected ${network.name} (${deploymentConfig.chainId}).`)
  }

  for (const [name, address] of [
    ['SurpSwapFactory', deploymentConfig.factory],
    ['WETH9', deploymentConfig.weth9],
  ]) {
    if ((await ethers.provider.getCode(address)) === '0x') {
      throw new Error(`${name} has no contract code at ${address}.`)
    }
  }

  const factory = await ethers.getContractAt(
    ['function feeAmountTickSpacing(uint24) view returns (int24)'],
    deploymentConfig.factory
  )
  const tickSpacing = await factory.feeAmountTickSpacing(3000)
  if (Number(tickSpacing) !== 60) {
    throw new Error(`Factory fee tier 3000 has unexpected tick spacing ${tickSpacing}.`)
  }

  console.log(`Network: ${network.name} (${deploymentConfig.chainId})`)
  console.log('Factory:', deploymentConfig.factory)
  console.log('WETH9:', deploymentConfig.weth9)
  console.log('Pool init-code hash: 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54')

  if (process.env[deploymentConfig.confirmationVariable] !== 'YES') {
    throw new Error(
      `Preflight passed. Set ${deploymentConfig.confirmationVariable}=YES to broadcast deployment transactions.`
    )
  }

  const [deployer] = await ethers.getSigners()
  if (!deployer) {
    throw new Error('No deployer account configured. Add a rotated PRIVATE_KEY to .env before deployment.')
  }

  console.log('Deployer:', await deployer.getAddress())

  const nftDescriptor = await deploy('contracts/libraries/SurpSwapNFTDescriptor.sol:SurpSwapNFTDescriptor')
  const descriptor = await deploy(
    'SurpSwapV3PositionDescriptor',
    [deploymentConfig.weth9, ethers.utils.formatBytes32String(deploymentConfig.nativeCurrencyLabel)],
    { SurpSwapNFTDescriptor: nftDescriptor.address }
  )
  const positionManager = await deploy('SurpSwapV3PositionManager', [
    deploymentConfig.factory,
    deploymentConfig.weth9,
    descriptor.address,
  ])
  const swapRouter = await deploy('contracts/SurpSwapV3SwapRouter.sol:SurpSwapV3SwapRouter', [
    deploymentConfig.factory,
    deploymentConfig.weth9,
  ])
  const quoter = await deploy('contracts/lens/SurpSwapV3Quoter.sol:SurpSwapV3Quoter', [
    deploymentConfig.factory,
    deploymentConfig.weth9,
  ])
  const quoterV2 = await deploy('contracts/lens/SurpSwapV3QuoterV2.sol:SurpSwapV3QuoterV2', [
    deploymentConfig.factory,
    deploymentConfig.weth9,
  ])
  const tickLens = await deploy('contracts/lens/SurpSwapV3TickLens.sol:SurpSwapV3TickLens')
  const migrator = await deploy('SurpSwapV3Migrator', [
    deploymentConfig.factory,
    deploymentConfig.weth9,
    positionManager.address,
  ])

  saveDeploymentOutput(network.name, chainId, await deployer.getAddress(), {
    SurpSwapFactory: deploymentConfig.factory,
    WETH9: deploymentConfig.weth9,
    SurpSwapNFTDescriptor: nftDescriptor.address,
    SurpSwapV3PositionDescriptor: descriptor.address,
    SurpSwapV3PositionManager: positionManager.address,
    SurpSwapV3SwapRouter: swapRouter.address,
    SurpSwapV3Quoter: quoter.address,
    SurpSwapV3QuoterV2: quoterV2.address,
    SurpSwapV3TickLens: tickLens.address,
    SurpSwapV3Migrator: migrator.address,
  })

  console.log('Deployment complete.')
  console.log('SurpSwapV3PositionDescriptor:', descriptor.address)
  console.log('SurpSwapV3PositionManager:', positionManager.address)
  console.log('SurpSwapV3SwapRouter:', swapRouter.address)
  console.log('SurpSwapV3Quoter:', quoter.address)
  console.log('SurpSwapV3QuoterV2:', quoterV2.address)
  console.log('SurpSwapV3TickLens:', tickLens.address)
  console.log('SurpSwapV3Migrator:', migrator.address)
}

main().catch((error) => {
  console.error('DEPLOYMENT FAILED:', error)
  process.exitCode = 1
})
