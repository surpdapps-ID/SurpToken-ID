// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import '@openzeppelin/contracts/access/Ownable.sol';

import '@uniswap/v3-core/contracts/libraries/SafeCast.sol';
import '@uniswap/v3-core/contracts/libraries/TickMath.sol';
import '@uniswap/v3-core/contracts/interfaces/ISurpSwapV3Pool.sol';

import './interfaces/ISurpSwapV3SwapRouter.sol';
import './base/PeripheryImmutableState.sol';
import './base/PeripheryValidation.sol';
import './base/PeripheryPaymentsWithFee.sol';
import './base/Multicall.sol';
import './base/SelfPermit.sol';
import './libraries/Path.sol';
import './libraries/PoolAddress.sol';
import './libraries/CallbackValidation.sol';
import './interfaces/external/IWETH9.sol';

contract SurpSwapV3SwapRouter is
    ISurpSwapV3SwapRouter,
    PeripheryImmutableState,
    PeripheryValidation,
    PeripheryPaymentsWithFee,
    Multicall,
    SelfPermit,
    Ownable
{
    string public constant BRAND = 'SurpSwap';

    using Path for bytes;
    using SafeCast for uint256;

    // =========================
    // PAUSE STATE
    // =========================
    bool public paused;
    bool public pauseSell;
    bool public pauseBuy;

    modifier whenNotPaused() {
        require(!paused, 'SWAP_PAUSED');
        _;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }

    function setPauseSell(bool _paused) external onlyOwner {
        pauseSell = _paused;
    }

    function setPauseBuy(bool _paused) external onlyOwner {
        pauseBuy = _paused;
    }

    // =========================
    // INTERNAL STATE
    // =========================
    uint256 private constant DEFAULT_AMOUNT_IN_CACHED = type(uint256).max;
    uint256 private amountInCached = DEFAULT_AMOUNT_IN_CACHED;

    constructor(address _factory, address _WETH9) PeripheryImmutableState(_factory, _WETH9) {}

    // =========================
    // POOL GETTER
    // =========================
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) private view returns (ISurpSwapV3Pool) {
        return ISurpSwapV3Pool(PoolAddress.computeAddress(factory, PoolAddress.getPoolKey(tokenA, tokenB, fee)));
    }

    struct SwapCallbackData {
        bytes path;
        address payer;
    }

    // =========================
    // CALLBACK
    // =========================
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata _data
    ) external override {
        require(amount0Delta > 0 || amount1Delta > 0);

        SwapCallbackData memory data = abi.decode(_data, (SwapCallbackData));
        (address tokenIn, address tokenOut, uint24 fee) = data.path.decodeFirstPool();

        CallbackValidation.verifyCallback(factory, tokenIn, tokenOut, fee);

        (bool isExactInput, uint256 amountToPay) =
            amount0Delta > 0
                ? (tokenIn < tokenOut, uint256(amount0Delta))
                : (tokenOut < tokenIn, uint256(amount1Delta));

        if (isExactInput) {
            pay(tokenIn, data.payer, msg.sender, amountToPay);
        } else {
            if (data.path.hasMultiplePools()) {
                data.path = data.path.skipToken();
                exactOutputInternal(amountToPay, msg.sender, 0, data);
            } else {
                amountInCached = amountToPay;
                pay(tokenOut, data.payer, msg.sender, amountToPay);
            }
        }
    }

    // =========================
    // INTERNAL EXACT INPUT
    // =========================
    function exactInputInternal(
        uint256 amountIn,
        address recipient,
        uint160 sqrtPriceLimitX96,
        SwapCallbackData memory data
    ) private returns (uint256 amountOut) {
        if (recipient == address(0)) recipient = address(this);

        (address tokenIn, address tokenOut, uint24 fee) = data.path.decodeFirstPool();

        bool zeroForOne = tokenIn < tokenOut;

        (int256 amount0, int256 amount1) =
            getPool(tokenIn, tokenOut, fee).swap(
                recipient,
                zeroForOne,
                int256(amountIn),
                sqrtPriceLimitX96 == 0
                    ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                    : sqrtPriceLimitX96,
                abi.encode(data)
            );

        amountOut = uint256(-(zeroForOne ? amount1 : amount0));
    }

    // =========================
    // EXACT INPUT SINGLE
    // =========================
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        checkDeadline(params.deadline)
        whenNotPaused
        returns (uint256 amountOut)
    {
        require(!pauseSell || params.tokenIn < params.tokenOut, 'SELL_PAUSED');
        require(!pauseBuy || params.tokenOut < params.tokenIn, 'BUY_PAUSED');

        amountOut = exactInputInternal(
            params.amountIn,
            params.recipient,
            params.sqrtPriceLimitX96,
            SwapCallbackData({path: abi.encodePacked(params.tokenIn, params.fee, params.tokenOut), payer: msg.sender})
        );

        require(amountOut >= params.amountOutMinimum, 'Too little received');
    }

    // =========================
    // EXACT INPUT (FIXED)
    // =========================
    function exactInput(ExactInputParams memory params)
        external
        payable
        override
        checkDeadline(params.deadline)
        whenNotPaused
        returns (uint256 amountOut)
    {
        address payer = msg.sender;

        bytes memory path = params.path;
        uint256 amountInLocal = params.amountIn;

        while (true) {
            bool hasMultiplePools = path.hasMultiplePools();

            SwapCallbackData memory data = SwapCallbackData({path: path.getFirstPool(), payer: payer});

            amountInLocal = exactInputInternal(
                amountInLocal,
                hasMultiplePools ? address(this) : params.recipient,
                0,
                data
            );

            if (hasMultiplePools) {
                payer = address(this);
                path = path.skipToken();
            } else {
                amountOut = amountInLocal;
                break;
            }
        }

        require(amountOut >= params.amountOutMinimum, 'Too little received');
    }

    // =========================
    // EXACT OUTPUT INTERNAL
    // =========================
    function exactOutputInternal(
        uint256 amountOut,
        address recipient,
        uint160 sqrtPriceLimitX96,
        SwapCallbackData memory data
    ) private returns (uint256 amountIn) {
        if (recipient == address(0)) recipient = address(this);

        (address tokenOut, address tokenIn, uint24 fee) = data.path.decodeFirstPool();

        bool zeroForOne = tokenIn < tokenOut;

        (int256 amount0Delta, int256 amount1Delta) =
            getPool(tokenIn, tokenOut, fee).swap(
                recipient,
                zeroForOne,
                -int256(amountOut),
                sqrtPriceLimitX96 == 0
                    ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                    : sqrtPriceLimitX96,
                abi.encode(data)
            );

        (amountIn, ) = zeroForOne
            ? (uint256(amount0Delta), uint256(-amount1Delta))
            : (uint256(amount1Delta), uint256(-amount0Delta));

        if (sqrtPriceLimitX96 == 0) {
            require(amountIn > 0, 'Invalid swap');
        }
    }

    // =========================
    // EXACT OUTPUT SINGLE
    // =========================
    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        override
        checkDeadline(params.deadline)
        whenNotPaused
        returns (uint256 amountIn)
    {
        require(!pauseSell || params.tokenIn < params.tokenOut, 'SELL_PAUSED');
        require(!pauseBuy || params.tokenOut < params.tokenIn, 'BUY_PAUSED');

        amountIn = exactOutputInternal(
            params.amountOut,
            params.recipient,
            params.sqrtPriceLimitX96,
            SwapCallbackData({path: abi.encodePacked(params.tokenOut, params.fee, params.tokenIn), payer: msg.sender})
        );

        require(amountIn <= params.amountInMaximum, 'Too much requested');
        amountInCached = DEFAULT_AMOUNT_IN_CACHED;
    }

    // =========================
    // EXACT OUTPUT
    // =========================
    function exactOutput(ExactOutputParams memory params)
        external
        payable
        override
        checkDeadline(params.deadline)
        whenNotPaused
        returns (uint256 amountIn)
    {
        require(!pauseSell || params.path.length > 0, 'SELL_PAUSED');
        require(!pauseBuy || params.path.length > 0, 'BUY_PAUSED');

        exactOutputInternal(
            params.amountOut,
            params.recipient,
            0,
            SwapCallbackData({path: params.path, payer: msg.sender})
        );

        amountIn = amountInCached;
        require(amountIn <= params.amountInMaximum, 'Too much requested');
        amountInCached = DEFAULT_AMOUNT_IN_CACHED;
    }
}
