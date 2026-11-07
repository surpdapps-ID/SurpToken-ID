# SurpSwap V3 Periphery

[![Tests](https://github.com/Uniswap/uniswap-v3-periphery/workflows/Tests/badge.svg)](https://github.com/Uniswap/uniswap-v3-periphery/actions?query=workflow%3ATests)
[![Lint](https://github.com/Uniswap/uniswap-v3-periphery/workflows/Lint/badge.svg)](https://github.com/Uniswap/uniswap-v3-periphery/actions?query=workflow%3ALint)

This repository contains SurpSwap V3 periphery contracts, built to interoperate with
V3-compatible core contracts. For the lower-level core implementation, see the
[uniswap-v3-core](https://github.com/Uniswap/uniswap-v3-core) repository.

## Bug bounty

This repository is subject to the SurpSwap V3 bug bounty program,
per the terms defined [here](./bug-bounty.md).

## Polygon Amoy deployment

Periphery contracts were deployed on Polygon Amoy (chain ID `80002`) on 2026-10-18.
Each address below has a verified source page on PolygonScan. SurpSwapV3TickLens is marked as
a similar match to an already verified deployment; the other contracts show an exact
bytecode match.

| Contract | Address | Verification |
| --- | --- | --- |
| SurpSwapNFTDescriptor | [0x51845bd4259C86828A390f66b17011354a95B0b2](https://amoy.polygonscan.com/address/0x51845bd4259C86828A390f66b17011354a95B0b2#code) | Exact match |
| SurpSwapV3PositionDescriptor | [0x1B1BCBb6D3593D5261d0aB8f5C15325ae45E9039](https://amoy.polygonscan.com/address/0x1B1BCBb6D3593D5261d0aB8f5C15325ae45E9039#code) | Exact match |
| SurpSwapV3PositionManager | [0x54460eF33310C1604e5fCC7BcA3aEAd8fD04d2c3](https://amoy.polygonscan.com/address/0x54460eF33310C1604e5fCC7BcA3aEAd8fD04d2c3#code) | Exact match |
| SurpSwapV3SwapRouter | [0x8E201E758F62Cc6DceAF71C88cE83B18fE367e32](https://amoy.polygonscan.com/address/0x8E201E758F62Cc6DceAF71C88cE83B18fE367e32#code) | Exact match |
| SurpSwapV3Quoter | [0x1FEfE44A4576C25e2ecFA979fb40AF83D0124063](https://amoy.polygonscan.com/address/0x1FEfE44A4576C25e2ecFA979fb40AF83D0124063#code) | Exact match |
| SurpSwapV3QuoterV2 | [0xAfd6cCb9CCf0657df4bF7e68BEF809b0cdAc24C3](https://amoy.polygonscan.com/address/0xAfd6cCb9CCf0657df4bF7e68BEF809b0cdAc24C3#code) | Exact match |
| SurpSwapV3TickLens | [0xb7d36Ad40FE6E406864f81902238d741C4DD823B](https://amoy.polygonscan.com/address/0xb7d36Ad40FE6E406864f81902238d741C4DD823B#code) | Similar match |
| SurpSwapV3Migrator | [0x6b823f338dFa84cb6dD21b71aA94CbdE11B59F95](https://amoy.polygonscan.com/address/0x6b823f338dFa84cb6dD21b71aA94CbdE11B59F95#code) | Exact match |

These contracts use the Amoy factory at
[`0x90de499A0A784c95B91B4229a6a54b8EC25e1F7A`](https://amoy.polygonscan.com/address/0x90de499A0A784c95B91B4229a6a54b8EC25e1F7A)
and WETH9 at
[`0xd72eB396628a23ffc46E4b249B068b87c629A937`](https://amoy.polygonscan.com/address/0xd72eB396628a23ffc46E4b249B068b87c629A937).
These are testnet deployments only.

The deployment script temporarily inserted an external image URL into the generated
NFT SVG before compilation and restored the local source file afterward. The deployed
descriptor therefore renders that external image in NFT metadata; the verified
on-chain bytecode is authoritative for the deployed behavior.

## Polygon deployment

The deployment script supports both Polygon Amoy and Polygon Mainnet. Set
`POLYGON_RPC_URL`, `PRIVATE_KEY`, and `ETHERSCAN_API_KEY` in `.env`. Keep
`CONFIRM_POLYGON_PERIPHERY_DEPLOY` empty during preflight; set it to `YES` only
after confirming the network, deployer account, and POL gas balance.

```sh
npm run deploy:polygon
```

Amoy remains available through `npm run deploy:amoy` and uses its separate
`CONFIRM_AMOY_PERIPHERY_DEPLOY` confirmation variable.
After deployment, the network configuration and deployed contract addresses are
saved to `deployments/<network>.json`.
`deployments/polygon.json` initially contains only the Polygon factory and WETH9
configuration; a successful Polygon deployment replaces it with the actual
deployment output.

## Local deployment

In order to deploy this code to a local testnet, you should install the npm package
`@uniswap/v3-periphery`
and import bytecode imported from artifacts located at
`@uniswap/v3-periphery/artifacts/contracts/*/*.json`.
For example:

```typescript
import {
  abi as SWAP_ROUTER_ABI,
  bytecode as SWAP_ROUTER_BYTECODE,
} from '@uniswap/v3-periphery/artifacts/contracts/SurpSwapV3SwapRouter.sol/SurpSwapV3SwapRouter.json'

// deploy the bytecode
```

This will ensure that you are testing against the same bytecode that is deployed to
mainnet and public testnets, and SurpSwap code will correctly interoperate with
your local deployment.

## Using solidity interfaces

The SurpSwap V3 periphery interfaces are available for import into solidity smart contracts
via the npm artifact `@uniswap/v3-periphery`, e.g.:

```solidity
import '@uniswap/v3-periphery/contracts/interfaces/ISurpSwapV3SwapRouter.sol';

contract MyContract {
  ISurpSwapV3SwapRouter router;

  function doSomethingWithSurpSwapV3SwapRouter() {
    // router.exactInput(...);
  }
}

```
