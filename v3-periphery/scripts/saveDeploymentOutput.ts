import { mkdirSync, writeFileSync } from 'fs'
import path from 'path'

export function saveDeploymentOutput(
  network: string,
  chainId: number,
  deployer: string,
  contracts: Record<string, string>
) {
  const outputDirectory = path.resolve(process.cwd(), 'deployments')
  mkdirSync(outputDirectory, { recursive: true })

  const outputPath = path.join(outputDirectory, `${network}.json`)
  const output = {
    network,
    chainId,
    deployedAt: new Date().toISOString(),
    deployer,
    contracts,
  }

  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`Deployment output saved: ${outputPath}`)
}
