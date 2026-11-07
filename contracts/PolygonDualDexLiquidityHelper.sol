// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IUniswapV3PositionManager {
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

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface IQuickSwapV3PositionManager {
    struct MintParams {
        address token0;
        address token1;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

contract PolygonDualDexLiquidityHelper is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant UNISWAP_V3_POSITION_MANAGER =
        0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address public constant QUICKSWAP_V3_POSITION_MANAGER =
        0x8eF88E4c7CfbbaC1C163f7eddd4B578792201de6;

    event LiquidityAdded(
        address indexed provider,
        address indexed positionManager,
        uint256 indexed tokenId,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    );

    constructor() {
        require(block.chainid == 137, "Polygon mainnet only");
        require(UNISWAP_V3_POSITION_MANAGER.code.length > 0, "Uniswap manager missing");
        require(QUICKSWAP_V3_POSITION_MANAGER.code.length > 0, "QuickSwap manager missing");
    }

    function addUniswapV3Liquidity(
        IUniswapV3PositionManager.MintParams calldata params
    ) external nonReentrant returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        _validate(
            params.token0,
            params.token1,
            params.tickLower,
            params.tickUpper,
            params.amount0Desired,
            params.amount1Desired,
            params.amount0Min,
            params.amount1Min,
            params.deadline
        );
        require(params.recipient == msg.sender, "Recipient must be caller");
        require(
            params.fee == 100 || params.fee == 500 || params.fee == 3000 || params.fee == 10000,
            "Invalid Uniswap fee"
        );

        _pullAndApprove(
            params.token0,
            params.token1,
            params.amount0Desired,
            params.amount1Desired,
            UNISWAP_V3_POSITION_MANAGER
        );
        (tokenId, liquidity, amount0, amount1) = IUniswapV3PositionManager(
            UNISWAP_V3_POSITION_MANAGER
        ).mint(
            IUniswapV3PositionManager.MintParams({
                token0: params.token0,
                token1: params.token1,
                fee: params.fee,
                tickLower: params.tickLower,
                tickUpper: params.tickUpper,
                amount0Desired: params.amount0Desired,
                amount1Desired: params.amount1Desired,
                amount0Min: params.amount0Min,
                amount1Min: params.amount1Min,
                recipient: msg.sender,
                deadline: params.deadline
            })
        );
        _refundAndClear(
            params.token0,
            params.token1,
            params.amount0Desired - amount0,
            params.amount1Desired - amount1,
            UNISWAP_V3_POSITION_MANAGER
        );
        emit LiquidityAdded(msg.sender, UNISWAP_V3_POSITION_MANAGER, tokenId, liquidity, amount0, amount1);
    }

    function addQuickSwapV3Liquidity(
        IQuickSwapV3PositionManager.MintParams calldata params
    ) external nonReentrant returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        _validate(
            params.token0,
            params.token1,
            params.tickLower,
            params.tickUpper,
            params.amount0Desired,
            params.amount1Desired,
            params.amount0Min,
            params.amount1Min,
            params.deadline
        );
        require(params.recipient == msg.sender, "Recipient must be caller");

        _pullAndApprove(
            params.token0,
            params.token1,
            params.amount0Desired,
            params.amount1Desired,
            QUICKSWAP_V3_POSITION_MANAGER
        );
        (tokenId, liquidity, amount0, amount1) = IQuickSwapV3PositionManager(
            QUICKSWAP_V3_POSITION_MANAGER
        ).mint(
            IQuickSwapV3PositionManager.MintParams({
                token0: params.token0,
                token1: params.token1,
                tickLower: params.tickLower,
                tickUpper: params.tickUpper,
                amount0Desired: params.amount0Desired,
                amount1Desired: params.amount1Desired,
                amount0Min: params.amount0Min,
                amount1Min: params.amount1Min,
                recipient: msg.sender,
                deadline: params.deadline
            })
        );
        _refundAndClear(
            params.token0,
            params.token1,
            params.amount0Desired - amount0,
            params.amount1Desired - amount1,
            QUICKSWAP_V3_POSITION_MANAGER
        );
        emit LiquidityAdded(msg.sender, QUICKSWAP_V3_POSITION_MANAGER, tokenId, liquidity, amount0, amount1);
    }

    function _validate(
        address token0,
        address token1,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) private view {
        require(token0 != address(0) && token1 != address(0), "Zero token");
        require(uint160(token0) < uint160(token1), "Tokens not sorted");
        require(token0.code.length > 0 && token1.code.length > 0, "Token contract missing");
        require(tickLower < tickUpper, "Invalid tick range");
        require(amount0Desired > 0 && amount1Desired > 0, "Zero desired amount");
        require(amount0Min <= amount0Desired && amount1Min <= amount1Desired, "Minimum exceeds desired");
        require(deadline >= block.timestamp, "Deadline expired");
    }

    function _pullAndApprove(
        address token0,
        address token1,
        uint256 amount0,
        uint256 amount1,
        address positionManager
    ) private {
        IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1);
        IERC20(token0).safeApprove(positionManager, 0);
        IERC20(token1).safeApprove(positionManager, 0);
        IERC20(token0).safeApprove(positionManager, amount0);
        IERC20(token1).safeApprove(positionManager, amount1);
    }

    function _refundAndClear(
        address token0,
        address token1,
        uint256 refund0,
        uint256 refund1,
        address positionManager
    ) private {
        IERC20(token0).safeApprove(positionManager, 0);
        IERC20(token1).safeApprove(positionManager, 0);
        if (refund0 > 0) IERC20(token0).safeTransfer(msg.sender, refund0);
        if (refund1 > 0) IERC20(token1).safeTransfer(msg.sender, refund1);
    }
}
