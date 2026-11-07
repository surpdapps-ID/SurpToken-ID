// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPolygonWpol is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IUniswapV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

interface IQuickSwapAlgebraSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 limitSqrtPrice;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

contract PolygonDexSwapHelper is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant WPOL = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270;
    address public constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public constant QUICKSWAP_V3_ROUTER = 0xf5b509bB0909a69B1c207E495f687a596C168E12;
    uint256 private constant MAX_DEADLINE_WINDOW = 30 minutes;

    enum Dex {
        UNISWAP_V3,
        QUICKSWAP_V3
    }

    event SwapExecuted(
        address indexed user,
        Dex indexed dex,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor() {
        require(block.chainid == 137, "Polygon mainnet only");
        require(UNISWAP_V3_ROUTER.code.length > 0, "Uniswap router missing");
        require(QUICKSWAP_V3_ROUTER.code.length > 0, "QuickSwap router missing");
        require(WPOL.code.length > 0, "WPOL missing");
    }

    function buyWithPOL(
        address tokenOut,
        Dex dex,
        uint24 uniswapFee,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 amountOut) {
        _validateSwap(tokenOut, WPOL, amountOutMinimum, deadline);
        require(msg.value > 0, "zero POL input");
        require(tokenOut != WPOL, "token is WPOL");

        IPolygonWpol(WPOL).deposit{value: msg.value}();
        IERC20(WPOL).forceApprove(_routerFor(dex), msg.value);

        amountOut = _swapExactInput(
            dex,
            WPOL,
            tokenOut,
            msg.value,
            amountOutMinimum,
            deadline,
            uniswapFee,
            msg.sender
        );

        IERC20(WPOL).forceApprove(_routerFor(dex), 0);
        emit SwapExecuted(msg.sender, dex, WPOL, tokenOut, msg.value, amountOut);
    }

    function sellForPOL(
        address tokenIn,
        Dex dex,
        uint24 uniswapFee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        _validateSwap(WPOL, tokenIn, amountOutMinimum, deadline);
        require(tokenIn != WPOL, "token is WPOL");
        require(amountIn > 0, "zero token input");

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(_routerFor(dex), amountIn);

        amountOut = _swapExactInput(
            dex,
            tokenIn,
            WPOL,
            amountIn,
            amountOutMinimum,
            deadline,
            uniswapFee,
            address(this)
        );

        IERC20(tokenIn).forceApprove(_routerFor(dex), 0);
        IPolygonWpol(WPOL).withdraw(amountOut);
        (bool sent, ) = payable(msg.sender).call{value: amountOut}("");
        require(sent, "POL transfer failed");

        emit SwapExecuted(msg.sender, dex, tokenIn, WPOL, amountIn, amountOut);
    }

    function swapTokens(
        address tokenIn,
        address tokenOut,
        Dex dex,
        uint24 uniswapFee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        _validateSwap(tokenOut, tokenIn, amountOutMinimum, deadline);
        require(tokenIn != tokenOut, "identical tokens");
        require(amountIn > 0, "zero token input");

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(_routerFor(dex), amountIn);

        amountOut = _swapExactInput(
            dex,
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMinimum,
            deadline,
            uniswapFee,
            msg.sender
        );

        IERC20(tokenIn).forceApprove(_routerFor(dex), 0);
        emit SwapExecuted(msg.sender, dex, tokenIn, tokenOut, amountIn, amountOut);
    }

    function _swapExactInput(
        Dex dex,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline,
        uint24 uniswapFee,
        address recipient
    ) private returns (uint256 amountOut) {
        if (dex == Dex.UNISWAP_V3) {
            require(
                uniswapFee == 100 ||
                    uniswapFee == 500 ||
                    uniswapFee == 3000 ||
                    uniswapFee == 10000,
                "invalid fee"
            );
            return IUniswapV3SwapRouter(UNISWAP_V3_ROUTER).exactInputSingle(
                IUniswapV3SwapRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: uniswapFee,
                    recipient: recipient,
                    deadline: deadline,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMinimum,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        require(dex == Dex.QUICKSWAP_V3, "unsupported DEX");
        require(uniswapFee == 0, "QuickSwap does not use a fee tier");
        return IQuickSwapAlgebraSwapRouter(QUICKSWAP_V3_ROUTER).exactInputSingle(
            IQuickSwapAlgebraSwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                recipient: recipient,
                deadline: deadline,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                limitSqrtPrice: 0
            })
        );
    }

    function _routerFor(Dex dex) private pure returns (address) {
        if (dex == Dex.UNISWAP_V3) {
            return UNISWAP_V3_ROUTER;
        }
        require(dex == Dex.QUICKSWAP_V3, "unsupported DEX");
        return QUICKSWAP_V3_ROUTER;
    }

    function _validateSwap(
        address tokenOut,
        address tokenIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) private view {
        require(tokenOut != address(0) && tokenIn != address(0), "zero token");
        require(amountOutMinimum > 0, "zero minimum output");
        require(deadline >= block.timestamp, "deadline expired");
        require(deadline <= block.timestamp + MAX_DEADLINE_WINDOW, "deadline too far");
    }

    receive() external payable {
        require(msg.sender == WPOL, "only WPOL may send POL");
    }
}
