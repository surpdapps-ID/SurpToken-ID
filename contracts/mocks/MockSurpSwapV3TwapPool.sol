// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockSurpSwapV3TwapPool {
    address public immutable token0;
    address public immutable token1;
    int24 public tick;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setTick(int24 tick_) external {
        tick = tick_;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            tickCumulatives[i] = int56(tick) * int56(uint56(secondsAgos[0] - secondsAgos[i]));
        }
    }
}
