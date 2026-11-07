// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

import '../interfaces/ISurpSwapV3PositionManager.sol';

contract SurpSwapV3PositionManagerPositionsGasTest {
    ISurpSwapV3PositionManager immutable nonfungiblePositionManager;

    constructor(ISurpSwapV3PositionManager _nonfungiblePositionManager) {
        nonfungiblePositionManager = _nonfungiblePositionManager;
    }

    function getGasCostOfPositions(uint256 tokenId) external view returns (uint256) {
        uint256 gasBefore = gasleft();
        nonfungiblePositionManager.positions(tokenId);
        return gasBefore - gasleft();
    }
}
