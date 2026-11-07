# Uniswap V3

[![Lint](https://github.com/Uniswap/uniswap-v3-core/actions/workflows/lint.yml/badge.svg)](https://github.com/Uniswap/uniswap-v3-core/actions/workflows/lint.yml)
[![Tests](https://github.com/Uniswap/uniswap-v3-core/actions/workflows/tests.yml/badge.svg)](https://github.com/Uniswap/uniswap-v3-core/actions/workflows/tests.yml)
[![Fuzz Testing](https://github.com/Uniswap/uniswap-v3-core/actions/workflows/fuzz-testing.yml/badge.svg)](https://github.com/Uniswap/uniswap-v3-core/actions/workflows/fuzz-testing.yml)
[![Mythx](https://github.com/Uniswap/uniswap-v3-core/actions/workflows/mythx.yml/badge.svg)](https://github.com/Uniswap/uniswap-v3-core/actions/workflows/mythx.yml)
[![npm version](https://img.shields.io/npm/v/@uniswap/v3-core/latest.svg)](https://www.npmjs.com/package/@uniswap/v3-core/v/latest)

This repository contains the core smart contracts for the Uniswap V3 Protocol.
For higher level contracts, see the [uniswap-v3-periphery](https://github.com/Uniswap/uniswap-v3-periphery)
repository.

## Bug bounty

This repository is subject to the Uniswap V3 bug bounty program, per the terms defined [here](./bug-bounty.md).

## Local deployment

In order to deploy this code to a local testnet, you should install the npm package
`@uniswap/v3-core`
and import the factory bytecode located at
`@uniswap/v3-core/artifacts/contracts/SurpSwapFactory.sol/SurpSwapFactory.json`.
For example:

```typescript
import {
  abi as FACTORY_ABI,
  bytecode as FACTORY_BYTECODE,
} from '@uniswap/v3-core/artifacts/contracts/SurpSwapFactory.sol/SurpSwapFactory.json'

// deploy the bytecode
```

This will ensure that you are testing against the same bytecode that is deployed to
mainnet and public testnets, and all Uniswap code will correctly interoperate with
your local deployment.

## Deploying to Polygon

Install the project dependencies, copy `.env.example` to `.env`, and set `PRIVATE_KEY`.
Use a dedicated deployer wallet and set `AMOY_RPC` and `POLYGON_RPC_URL` to RPC endpoints
you trust. Polygon mainnet deployment refuses to run without an explicitly configured RPC.

Deploy to Polygon Amoy first:

```sh
npm run deploy:amoy
```

For Polygon PoS mainnet, make sure the deployer wallet is funded with POL, then explicitly
confirm the mainnet deployment in `.env`:

```dotenv
CONFIRM_POLYGON_MAINNET_DEPLOY=YES
```

Run the mainnet deployment only when you are ready to broadcast a real transaction:

```sh
npm run deploy:polygon
```

The deployment script checks the selected network's chain ID, estimates the gas cost,
checks the deployer balance, and verifies factory ownership. It refuses to overwrite an
existing deployment record. It deploys only the factory contract; the factory creates
pools itself. It also prints the `POOL_INIT_CODE_HASH`, which must match the value used by
the periphery contracts that interact with this factory. On success, the script saves the
deployment details as a transaction-specific `deployments/amoy-<transaction-hash>.json`
file on Amoy or `deployments/polygon-<transaction-hash>.json` on mainnet, preserving
previous deployment records.
The deployment script verifies the exact `SurpSwapFactory` source on Polygonscan after
deployment. Set `ETHERSCAN_API_KEY` or `POLYGONSCAN_API_KEY` in `.env`; deployment stops
before broadcasting if neither key is configured. To force a fresh verification for an
existing address (for example, if Polygonscan shows a similar contract match), run:

```sh
npx hardhat verify --force --network amoy FACTORY_ADDRESS
```

### Hasil deployment dan verifikasi Polygon Amoy

Factory berhasil di-deploy ke jaringan uji Polygon Amoy (chain ID `80002`) dan source
kontraknya sudah terverifikasi di Polygonscan:

- Alamat Factory: [`0x90de499A0A784c95B91B4229a6a54b8EC25e1F7A`](https://amoy.polygonscan.com/address/0x90de499A0A784c95B91B4229a6a54b8EC25e1F7A#code)
- Owner: `0xfbe90f900c1890e232fD7F09295436e0Fc7eCeF8`
- Transaksi deployment: [`0x223f117803472f7e640a111a2c7bac5d085a9fd65ff36163e92aba47f2f4109a`](https://amoy.polygonscan.com/tx/0x223f117803472f7e640a111a2c7bac5d085a9fd65ff36163e92aba47f2f4109a)
- Blok: `50441961`
- Hash init code pool: `0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54`

Deployment ini hanya untuk jaringan uji. Jangan gunakan alamat Factory Amoy sebagai
alamat deployment Polygon mainnet.

## Using solidity interfaces

The Uniswap v3 interfaces are available for import into solidity smart contracts
via the npm artifact `@uniswap/v3-core`, e.g.:

```solidity
import '@uniswap/v3-core/contracts/interfaces/ISurpSwapV3Pool.sol';

contract MyContract {
  ISurpSwapV3Pool pool;

  function doSomethingWithPool() {
    // pool.swap(...);
  }
}

```

## Licensing

The primary license for Uniswap V3 Core is the Business Source License 1.1 (`BUSL-1.1`), see [`LICENSE`](./LICENSE). However, some files are dual licensed under `GPL-2.0-or-later`:

- All files in `contracts/interfaces/` may also be licensed under `GPL-2.0-or-later` (as indicated in their SPDX headers), see [`contracts/interfaces/LICENSE`](./contracts/interfaces/LICENSE)
- Several files in `contracts/libraries/` may also be licensed under `GPL-2.0-or-later` (as indicated in their SPDX headers), see [`contracts/libraries/LICENSE`](contracts/libraries/LICENSE)

### Other Exceptions

- `contracts/libraries/FullMath.sol` is licensed under `MIT` (as indicated in its SPDX header), see [`contracts/libraries/LICENSE_MIT`](contracts/libraries/LICENSE_MIT)
- All files in `contracts/test` remain unlicensed (as indicated in their SPDX headers).
