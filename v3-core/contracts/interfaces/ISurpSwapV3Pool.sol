// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

import './pool/ISurpSwapV3PoolImmutables.sol';
import './pool/ISurpSwapV3PoolState.sol';
import './pool/ISurpSwapV3PoolDerivedState.sol';
import './pool/ISurpSwapV3PoolActions.sol';
import './pool/ISurpSwapV3PoolOwnerActions.sol';
import './pool/ISurpSwapV3PoolEvents.sol';

/// @title The interface for a SurpSwap pool
/// @notice A SurpSwap pool facilitates swapping and automated market making between any two assets that strictly conform
/// to the ERC20 specification
/// @dev The pool interface is broken up into many smaller pieces
interface ISurpSwapV3Pool is
    ISurpSwapV3PoolImmutables,
    ISurpSwapV3PoolState,
    ISurpSwapV3PoolDerivedState,
    ISurpSwapV3PoolActions,
    ISurpSwapV3PoolOwnerActions,
    ISurpSwapV3PoolEvents
{

}
