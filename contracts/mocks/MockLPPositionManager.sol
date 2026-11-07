// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockLPPositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    address public lastRecipient;
    uint256 public lastAmount0;
    uint256 public lastAmount1;

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        amount0 = (params.amount0Desired * 9) / 10;
        amount1 = (params.amount1Desired * 9) / 10;
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "minimum not met");
        IERC20(params.token0).transferFrom(msg.sender, address(this), amount0);
        IERC20(params.token1).transferFrom(msg.sender, address(this), amount1);
        lastRecipient = params.recipient;
        lastAmount0 = amount0;
        lastAmount1 = amount1;
        return (1, 100, amount0, amount1);
    }
}
