import hardhat from 'hardhat'
import { saveDeploymentOutput } from './saveDeploymentOutput'

const { ethers } = hardhat

const DEPLOYMENT_CONFIGS: Record<
  string,
  {
    chainId: number
    factory: string
    weth: string
    nativeCurrencyLabel: string
    confirmationVariable: string
  }
> = {
  amoy: {
    chainId: 80002,
    factory: '0x0B131B5a9673f81e561dD58EC11dEB122DC27a78',
    weth: '0x81e6D597F2c5A4144e9C2ACa8c516bc9A5891e5F',
    nativeCurrencyLabel: 'ETH',
    confirmationVariable: 'CONFIRM_AMOY_PERIPHERY_DEPLOY',
  },
  polygon: {
    chainId: 137,
    factory: '0x0dB995B73CeA857cEB24c7B3135eC9a64A12e0c6',
    weth: '0xfD6362c6b4A293697043B74b620D007C76e8b9E4',
    nativeCurrencyLabel: 'POL',
    confirmationVariable: 'CONFIRM_POLYGON_PERIPHERY_DEPLOY',
  },
}

async function main() {
  const deploymentConfig = DEPLOYMENT_CONFIGS[hardhat.network.name]
  if (!deploymentConfig) {
    throw new Error(`Refusing deployment on "${hardhat.network.name}"; use --network amoy or --network polygon.`)
  }

  const { chainId } = await ethers.provider.getNetwork()
  if (chainId !== deploymentConfig.chainId) {
    throw new Error(`Wrong chain ID ${chainId}; expected ${hardhat.network.name} (${deploymentConfig.chainId}).`)
  }

  for (const [name, address] of [
    ['SurpSwapFactory', deploymentConfig.factory],
    ['WETH9', deploymentConfig.weth],
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

  if (process.env[deploymentConfig.confirmationVariable] !== 'YES') {
    throw new Error(
      `Preflight passed. Set ${deploymentConfig.confirmationVariable}=YES to broadcast deployment transactions.`
    )
  }

  const [deployer] = await ethers.getSigners()
  if (!deployer) {
    throw new Error('No deployer account configured. Add a PRIVATE_KEY to .env before deployment.')
  }

  // ===============================
  // VERIFY HELPER
  // ===============================
  const verify = async (address: string, args: string[] = [], libraries?: Record<string, string>) => {
    try {
      const verifyArgs: {
        address: string
        constructorArguments: string[]
        libraries?: Record<string, string>
      } = {
        address,
        constructorArguments: args,
      }
      if (libraries) {
        verifyArgs.libraries = libraries
      }
      await hardhat.run('verify:verify', verifyArgs)
      console.log('✔ VERIFIED:', address)
    } catch (e) {
      if (e.message?.includes('Already Verified') || e.message?.includes('already verified')) {
        console.log('✔ ALREADY VERIFIED:', address)
      } else {
        console.log('✖ VERIFY FAILED:', address)
        console.log(e.message)
      }
    }
  }

  console.log('⏳ Mengompilasi source contract sebelum deployment...')
  await hardhat.run('compile')

  console.log('DEPLOY PERIPHERY:', deployer.address)

  const SurpSwapNFTDescriptorLib = await ethers.getContractFactory(
    'contracts/libraries/SurpSwapNFTDescriptor.sol:SurpSwapNFTDescriptor'
  )

  const nftDescriptor = await SurpSwapNFTDescriptorLib.deploy()

  await nftDescriptor.deployed()

  console.log('SurpSwapNFTDescriptor:', nftDescriptor.address)

  const SurpSwapV3PositionDescriptor = await ethers.getContractFactory('SurpSwapV3PositionDescriptor', {
    libraries: { SurpSwapNFTDescriptor: nftDescriptor.address },
  })

  const descriptor = await SurpSwapV3PositionDescriptor.deploy(
    deploymentConfig.weth,
    ethers.utils.formatBytes32String(deploymentConfig.nativeCurrencyLabel)
  )

  await descriptor.deployed()

  console.log('SurpSwapV3PositionDescriptor:', descriptor.address)

  const SurpSwapV3PositionManager = await ethers.getContractFactory('SurpSwapV3PositionManager')

  const positionManager = await SurpSwapV3PositionManager.deploy(
    deploymentConfig.factory,
    deploymentConfig.weth,
    descriptor.address
  )

  await positionManager.deployed()

  console.log('SurpSwapV3PositionManager:', positionManager.address)

  const SurpSwapV3SwapRouter = await ethers.getContractFactory(
    'contracts/SurpSwapV3SwapRouter.sol:SurpSwapV3SwapRouter'
  )

  const swapRouter = await SurpSwapV3SwapRouter.deploy(deploymentConfig.factory, deploymentConfig.weth)

  await swapRouter.deployed()

  console.log('SurpSwapV3SwapRouter:', swapRouter.address)

  const SurpSwapV3Quoter = await ethers.getContractFactory('contracts/lens/SurpSwapV3Quoter.sol:SurpSwapV3Quoter')

  console.log('Deploying SurpSwapV3Quoter...')

  const quoter = await SurpSwapV3Quoter.deploy(deploymentConfig.factory, deploymentConfig.weth)

  await quoter.deployed()

  console.log('SurpSwapV3Quoter:', quoter.address)

  const SurpSwapV3QuoterV2 = await ethers.getContractFactory('contracts/lens/SurpSwapV3QuoterV2.sol:SurpSwapV3QuoterV2')

  console.log('Deploying SurpSwapV3QuoterV2...')

  const quoterV2 = await SurpSwapV3QuoterV2.deploy(deploymentConfig.factory, deploymentConfig.weth)

  await quoterV2.deployed()

  console.log('SurpSwapV3QuoterV2:', quoterV2.address)

  const SurpSwapV3TickLens = await ethers.getContractFactory('contracts/lens/SurpSwapV3TickLens.sol:SurpSwapV3TickLens')

  console.log('Deploying SurpSwapV3TickLens...')

  const tickLens = await SurpSwapV3TickLens.deploy()

  await tickLens.deployed()

  console.log('SurpSwapV3TickLens:', tickLens.address)

  const SurpSwapV3Migrator = await ethers.getContractFactory('contracts/SurpSwapV3Migrator.sol:SurpSwapV3Migrator')

  console.log('Deploying SurpSwapV3Migrator...')

  const migrator = await SurpSwapV3Migrator.deploy(
    deploymentConfig.factory,
    deploymentConfig.weth,
    positionManager.address
  )

  await migrator.deployed()

  console.log('SurpSwapV3Migrator:', migrator.address)

  saveDeploymentOutput(hardhat.network.name, chainId, deployer.address, {
    SurpSwapFactory: deploymentConfig.factory,
    WETH9: deploymentConfig.weth,
    SurpSwapNFTDescriptor: nftDescriptor.address,
    SurpSwapV3PositionDescriptor: descriptor.address,
    SurpSwapV3PositionManager: positionManager.address,
    SurpSwapV3SwapRouter: swapRouter.address,
    SurpSwapV3Quoter: quoter.address,
    SurpSwapV3QuoterV2: quoterV2.address,
    SurpSwapV3TickLens: tickLens.address,
    SurpSwapV3Migrator: migrator.address,
  })

  console.log('\n=====================================================')
  console.log('🚀 Memulai proses verifikasi otomatis...\n')

  console.log('\nVerifikasi SurpSwapV3TickLens...')
  await verify(tickLens.address)

  console.log('\nVerifikasi SurpSwapV3Migrator...')
  await verify(migrator.address, [deploymentConfig.factory, deploymentConfig.weth, positionManager.address])

  console.log('Verifikasi SurpSwapNFTDescriptor...')
  await verify(nftDescriptor.address)

  console.log('\nVerifikasi SurpSwapV3PositionDescriptor...')
  await verify(
    descriptor.address,
    [deploymentConfig.weth, ethers.utils.formatBytes32String(deploymentConfig.nativeCurrencyLabel)],
    {
      'contracts/libraries/SurpSwapNFTDescriptor.sol:SurpSwapNFTDescriptor': nftDescriptor.address,
    }
  )

  console.log('\nVerifikasi SurpSwapV3PositionManager...')
  await verify(positionManager.address, [deploymentConfig.factory, deploymentConfig.weth, descriptor.address])

  console.log('\nVerifikasi SurpSwapV3SwapRouter...')
  await verify(swapRouter.address, [deploymentConfig.factory, deploymentConfig.weth])

  console.log('\nVerifikasi SurpSwapV3Quoter...')
  await verify(quoter.address, [deploymentConfig.factory, deploymentConfig.weth])

  console.log('\nVerifikasi SurpSwapV3QuoterV2...')
  await verify(quoterV2.address, [deploymentConfig.factory, deploymentConfig.weth])

  console.log('\n✅ Semua proses Deploy dan Verifikasi selesai!')
  console.log('=====================================================')
}

main().catch(console.error)
