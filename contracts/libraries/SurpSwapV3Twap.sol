// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "../interfaces/SurpSwapV3Interfaces.sol";

library SurpSwapV3Twap {
    uint256 private constant Q96 = 1 << 96;
    uint256 private constant BASE_TICK_Q96 = 79236085330515764027303304731;

    function priceX18(
        address poolAddress,
        address baseToken,
        address quoteToken,
        uint32 interval
    ) internal view returns (uint256) {
        require(poolAddress.code.length > 0, "TWAP pool invalid");
        require(baseToken != address(0) && quoteToken != address(0), "TWAP token zero");
        require(interval > 0, "TWAP interval zero");

        ISurpSwapV3Pool pool = ISurpSwapV3Pool(poolAddress);
        address token0 = pool.token0();
        address token1 = pool.token1();
        require(
            (token0 == baseToken && token1 == quoteToken) ||
                (token0 == quoteToken && token1 == baseToken),
            "TWAP pair mismatch"
        );

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = interval;
        secondsAgos[1] = 0;
        int56[] memory tickCumulatives;
        try pool.observe(secondsAgos) returns (
            int56[] memory cumulatives,
            uint160[] memory
        ) {
            tickCumulatives = cumulatives;
        } catch {
            revert("TWAP observation unavailable");
        }
        require(tickCumulatives.length == 2, "TWAP observation invalid");

        int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
        int56 divisor = int56(uint56(interval));
        int56 averageTick = tickDelta / divisor;
        if (tickDelta < 0 && tickDelta % divisor != 0) {
            averageTick--;
        }

        uint256 ratioX96 = _ratioAtTick(averageTick < 0 ? -averageTick : averageTick);
        bool baseIsToken0 = baseToken == token0;
        uint8 baseDecimals = IERC20Metadata(baseToken).decimals();
        uint8 quoteDecimals = IERC20Metadata(quoteToken).decimals();
        require(baseDecimals == 18 && quoteDecimals == 18, "Tokens must use 18 decimals");

        bool invertRatio = (baseIsToken0 && averageTick < 0) ||
            (!baseIsToken0 && averageTick >= 0);
        if (invertRatio) {
            return Math.mulDiv(Q96, 1e18, ratioX96);
        }
        return Math.mulDiv(ratioX96, 1e18, Q96);
    }

    function _ratioAtTick(int56 tick) private pure returns (uint256 ratioX96) {
        uint256 absTick = uint256(uint56(tick < 0 ? -tick : tick));
        ratioX96 = Q96;
        uint256 factor = BASE_TICK_Q96;

        // Q96 exponentiation converts the time-weighted tick into the pool price ratio.
        while (absTick != 0) {
            if ((absTick & 1) != 0) {
                ratioX96 = Math.mulDiv(ratioX96, factor, Q96);
            }
            absTick >>= 1;
            if (absTick != 0) {
                factor = Math.mulDiv(factor, factor, Q96);
            }
        }
    }
}
