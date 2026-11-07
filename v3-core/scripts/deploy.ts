import { promises as fs } from 'fs'
import path from 'path'
import hardhat from 'hardhat'

const { artifacts, ethers, network, run } = hardhat

const expectedChainIds: Record<string, number> = {
  amoy: 80002,
  polygon: 137,
}

async function main() {
  const expectedChainId = expectedChainIds[network.name]
  if (expectedChainId === undefined) {
    throw new Error(`Unsupported deployment network "${network.name}". Use polygon or amoy.`)
  }

  if (!process.env.PRIVATE_KEY?.trim()) {
    throw new Error('Set PRIVATE_KEY in .env to a dedicated deployer wallet.')
  }

  if (!process.env.ETHERSCAN_API_KEY?.trim() && !process.env.POLYGONSCAN_API_KEY?.trim()) {
    throw new Error('Set ETHERSCAN_API_KEY or POLYGONSCAN_API_KEY in .env to verify the source after deployment.')
  }

  if (network.name === 'polygon' && !process.env.POLYGON_RPC_URL?.trim()) {
    throw new Error('Set POLYGON_RPC_URL in .env to a trusted Polygon mainnet RPC endpoint.')
  }

  const { chainId } = await ethers.provider.getNetwork()
  if (chainId !== expectedChainId) {
    throw new Error(`Wrong chain for "${network.name}": expected ${expectedChainId}, connected to ${chainId}.`)
  }

  if (network.name === 'polygon' && process.env.CONFIRM_POLYGON_MAINNET_DEPLOY !== 'YES') {
    throw new Error('Set CONFIRM_POLYGON_MAINNET_DEPLOY=YES to confirm Polygon mainnet deployment.')
  }

  const [deployer] = await ethers.getSigners()
  if (!deployer) {
    throw new Error('No deployer account configured. Set PRIVATE_KEY in .env.')
  }

  const deployerAddress = await deployer.getAddress()
  const deployerBalance = await deployer.getBalance()

  const deploymentDirectory = path.join(__dirname, '..', 'deployments')

  const Factory = await ethers.getContractFactory('contracts/SurpSwapFactory.sol:SurpSwapFactory', deployer)
  const deploymentRequest = Factory.getDeployTransaction()
  const estimatedGas = await ethers.provider.estimateGas({ ...deploymentRequest, from: deployerAddress })
  const gasLimit = estimatedGas.mul(120).div(100)
  const gasPrice = await ethers.provider.getGasPrice()
  const estimatedMaximumCost = gasLimit.mul(gasPrice)

  console.log('================================================')
  console.log('SURPSWAP CORE DEPLOYMENT')
  console.log('Network:', network.name, `(chain ID ${chainId})`)
  console.log('Deployer:', deployerAddress)
  console.log('Balance:', ethers.utils.formatEther(deployerBalance), 'POL')
  console.log(
    'Estimated maximum deployment cost (including 20% gas limit buffer):',
    ethers.utils.formatEther(estimatedMaximumCost),
    'POL'
  )
  console.log('================================================')

  if (deployerBalance.lt(estimatedMaximumCost)) {
    throw new Error('Deployer balance is below the estimated deployment cost. Fund the wallet and retry.')
  }

  const poolArtifact = await artifacts.readArtifact('SurpSwapV3Pool')
  const poolInitCodeHash = ethers.utils.keccak256(poolArtifact.bytecode)
  console.log('POOL_INIT_CODE_HASH:', poolInitCodeHash)

  const factory = await Factory.deploy({ gasLimit })
  await factory.deployed()
  const receipt = await factory.deployTransaction.wait(5)

  const owner = await factory.owner()
  if (owner.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(`Factory owner mismatch: expected ${deployerAddress}, got ${owner}.`)
  }

  const explorer = network.name === 'polygon' ? 'https://polygonscan.com' : 'https://amoy.polygonscan.com'
  const deployment = {
    contract: 'SurpSwapFactory',
    network: network.name,
    chainId,
    deployer: deployerAddress,
    deployerBalance: ethers.utils.formatEther(deployerBalance),
    factory: factory.address,
    owner,
    transaction: factory.deployTransaction.hash,
    block: receipt.blockNumber,
    explorer: `${explorer}/address/${factory.address}`,
    poolInitCodeHash,
  }
  const deploymentFile = path.join(deploymentDirectory, `${network.name}-${factory.deployTransaction.hash}.json`)
  await fs.mkdir(deploymentDirectory, { recursive: true })
  await fs.writeFile(deploymentFile, `${JSON.stringify(deployment, null, 2)}\n`, { flag: 'wx' })

  try {
    await run('verify:verify', {
      address: factory.address,
      contract: 'contracts/SurpSwapFactory.sol:SurpSwapFactory',
      constructorArgsParams: [],
      force: true,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Factory was deployed at ${factory.address} and recorded in ${path.relative(
        process.cwd(),
        deploymentFile
      )}, but source verification failed: ${detail}`
    )
  }

  console.log('================================================')
  console.log('DEPLOYMENT COMPLETE')
  console.log('Factory:', factory.address)
  console.log('Factory owner:', owner)
  console.log('Transaction:', factory.deployTransaction.hash)
  console.log('Block:', receipt.blockNumber)
  console.log('Explorer:', `${explorer}/address/${factory.address}`)
  console.log('POOL_INIT_CODE_HASH:', poolInitCodeHash)
  console.log('================================================')
  console.log('Ensure your periphery uses this exact POOL_INIT_CODE_HASH.')
  console.log('Deployment JSON:', path.relative(process.cwd(), deploymentFile))
}

main().catch((error) => {
  console.error('DEPLOYMENT FAILED:', error)
  process.exitCode = 1
})
