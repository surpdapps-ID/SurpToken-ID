// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/SurpSwapV3Interfaces.sol";

interface IERC20Custom {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from,address to,uint256 amount) external returns (bool);
    function balanceOf(address user) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ILPManager {
    function useForLP(uint256 amount) external returns (uint256);
}

contract SurpZeroSubsidizer is Ownable2Step, ReentrancyGuard, Pausable {

    using SafeERC20 for IERC20;

    IERC20 public token;
    IWETH public weth;
    ISurpSwapV3SwapRouter public router;
    ISurpSwapV3PositionManager public pm;
    ISurpSwapV3Quoter public quoter;
    ILPManager public lpManager;

    uint24 public constant FEE = 3000;

    enum BuyMode { LP_FIRST, SWAP_FIRST, PURE_SWAP }
    BuyMode public buyMode;

    bool public sellPaused;
    bool public emergencyStop;

    uint256 public maxSubsidyPerTx = 1000 ether;
    uint256 public dailySubsidyLimit = 10000 ether;
    uint256 public usedToday;
    uint256 public lastReset;

    uint256 public maxDeviationBps = 500;

    mapping(address => uint256) public lastBuy;

    uint256[] public lpPositions;

    modifier notStopped() {
        require(!emergencyStop, "stopped");
        _;
    }

    constructor(
        address _token,
        address _weth,
        address _router,
        address _pm,
        address _quoter,
        address _lp
    ) {
        token = IERC20(_token);
        weth = IWETH(_weth);
        _validateSurpSwapCore(_router, _pm, _quoter);
        router = ISurpSwapV3SwapRouter(_router);
        pm = ISurpSwapV3PositionManager(_pm);
        quoter = ISurpSwapV3Quoter(_quoter);
        lpManager = ILPManager(_lp);
    }

    function _validateSurpSwapCore(
        address routerAddress,
        address positionManagerAddress,
        address quoterAddress
    ) private view {
        require(
            routerAddress.code.length > 0 &&
                positionManagerAddress.code.length > 0 &&
                quoterAddress.code.length > 0,
            "Invalid SurpSwap periphery"
        );
        address factory = ISurpSwapV3SwapRouter(routerAddress).factory();
        require(factory.code.length > 0, "Invalid SurpSwap factory");
        require(
            ISurpSwapV3PositionManager(positionManagerAddress).factory() == factory &&
                ISurpSwapV3Quoter(quoterAddress).factory() == factory,
            "SurpSwap factory mismatch"
        );
    }

    // ============================================================
    // BUY
    // ============================================================

    function buy() external payable nonReentrant notStopped {

        require(msg.value > 0, "no ETH");
        require(block.timestamp > lastBuy[msg.sender] + 10, "cooldown");

        lastBuy[msg.sender] = block.timestamp;

        if (buyMode == BuyMode.LP_FIRST) {
            _buyLpFirst(msg.value);
        } else if (buyMode == BuyMode.SWAP_FIRST) {
            _buySwapFirst(msg.value);
        } else {
            _buyPure(msg.value);
        }
    }

    function _buyLpFirst(uint256 eth) internal {

        uint256 lpEth = eth / 2;
        uint256 swapEth = eth - lpEth;

        uint256 srpLP = lpManager.useForLP(lpEth);
        _addLiquidity(lpEth, srpLP);

        uint256 out = _swapETH(swapEth);
        uint256 subsidy = _subsidy(out, swapEth);

        token.safeTransfer(msg.sender, out + subsidy);
    }

    function _buySwapFirst(uint256 eth) internal {

        uint256 swapEth = eth / 2;
        uint256 lpEth = eth - swapEth;

        uint256 out = _swapETH(swapEth);
        uint256 subsidy = _subsidy(out, swapEth);

        token.safeTransfer(msg.sender, out + subsidy);

        uint256 srpLP = lpManager.useForLP(lpEth);
        _addLiquidity(lpEth, srpLP);
    }

    function _buyPure(uint256 eth) internal {

        uint256 out = _swapETH(eth);
        uint256 subsidy = _subsidy(out, eth);

        token.safeTransfer(msg.sender, out + subsidy);
    }

    // ============================================================
    // SWAP
    // ============================================================

    function _swapETH(uint256 amount) internal returns (uint256) {

        uint256 minOut = _getMinOut(amount);

        weth.deposit{value: amount}();
        weth.approve(address(router), amount);

        uint256 out = router.exactInputSingle(
            ISurpSwapV3SwapRouter.ExactInputSingleParams({
                tokenIn: address(weth),
                tokenOut: address(token),
                fee: FEE,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amount,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        _validatePrice(minOut, out);

        return out;
    }

    function _getMinOut(uint256 amount) internal returns (uint256) {

        uint256 quoted = quoter.quoteExactInputSingle(
            address(weth),
            address(token),
            FEE,
            amount,
            0
        );

        return (quoted * 98) / 100;
    }

    function _validatePrice(uint256 quoted, uint256 actual) internal view {

        uint256 diff = quoted > actual ? quoted - actual : actual - quoted;
        require((diff * 10000) / quoted < maxDeviationBps, "manipulated");
    }

    // ============================================================
    // SUBSIDY
    // ============================================================

    function _subsidy(uint256 actual, uint256 ethIn)
        internal returns (uint256)
    {
        if (block.timestamp > lastReset + 1 days) {
            usedToday = 0;
            lastReset = block.timestamp;
        }

        uint256 expected = _getMinOut(ethIn);

        if (actual >= expected) return 0;

        uint256 gap = expected - actual;

        if (gap > maxSubsidyPerTx) gap = maxSubsidyPerTx;

        if (usedToday + gap > dailySubsidyLimit) {
            gap = dailySubsidyLimit - usedToday;
        }

        usedToday += gap;

        return lpManager.useForLP(gap);
    }

    // ============================================================
    // LP
    // ============================================================

    function _addLiquidity(uint256 ethAmount, uint256 tokenAmount) internal {

        weth.deposit{value: ethAmount}();

        weth.approve(address(pm), ethAmount);
        token.safeApprove(address(pm), tokenAmount);

        (int24 lower, int24 upper) = _getTicks();

        (uint256 id,,,) = pm.mint(
            ISurpSwapV3PositionManager.MintParams({
                token0: address(token) < address(weth) ? address(token) : address(weth),
                token1: address(token) < address(weth) ? address(weth) : address(token),
                fee: FEE,
                tickLower: lower,
                tickUpper: upper,
                amount0Desired: tokenAmount,
                amount1Desired: ethAmount,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );

        lpPositions.push(id);
    }

    function _getTicks() internal pure returns (int24, int24) {
        return (-60000, 60000);
    }

    // ============================================================
    // AUTO COMPOUND
    // ============================================================

    function autoCompound(uint256 tokenId) external onlyOwner {

        (uint256 amount0, uint256 amount1) = pm.collect(
            ISurpSwapV3PositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        uint256 tokenAmt;
        uint256 wethAmt;

        if (address(token) < address(weth)) {
            tokenAmt = amount0;
            wethAmt = amount1;
        } else {
            tokenAmt = amount1;
            wethAmt = amount0;
        }

        token.safeApprove(address(pm), tokenAmt);
        weth.approve(address(pm), wethAmt);

        (int24 lower, int24 upper) = _getTicks();

        pm.mint(
            ISurpSwapV3PositionManager.MintParams({
                token0: address(token) < address(weth) ? address(token) : address(weth),
                token1: address(token) < address(weth) ? address(weth) : address(token),
                fee: FEE,
                tickLower: lower,
                tickUpper: upper,
                amount0Desired: tokenAmt,
                amount1Desired: wethAmt,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
    }

    // ============================================================
    // LP CONTROL
    // ============================================================

    function withdrawLP(uint256 tokenId, address to) external onlyOwner {
        pm.safeTransferFrom(address(this), to, tokenId);
    }

    function decreaseLP(uint256 tokenId, uint128 liquidity) external onlyOwner {
        pm.decreaseLiquidity(
            ISurpSwapV3PositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        );
    }

    // ============================================================
    // SELL
    // ============================================================

    function sell(uint256 amount) external nonReentrant {

        require(!sellPaused, "paused");

        token.safeTransferFrom(msg.sender, address(this), amount);
        token.safeApprove(address(router), amount);

        uint256 out = router.exactInputSingle(
            ISurpSwapV3SwapRouter.ExactInputSingleParams({
                tokenIn: address(token),
                tokenOut: address(weth),
                fee: FEE,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amount,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );

        weth.withdraw(out);
        payable(msg.sender).transfer(out);
    }

    // ============================================================
    // ADMIN
    // ============================================================

    function setBuyMode(BuyMode m) external onlyOwner {
        buyMode = m;
    }

    function setSellPaused(bool b) external onlyOwner {
        sellPaused = b;
    }

    function triggerEmergency() external onlyOwner {
        emergencyStop = true;
    }

    function rescueToken(address t, uint256 a) external onlyOwner {
        IERC20Custom(t).transfer(msg.sender, a);
    }

    receive() external payable {}

    // ============================================================
    // EXTRA FIX (ADDED WITHOUT REMOVING ANYTHING)
    // ============================================================

    function setCoreAddresses(
        address _router,
        address _pm,
        address _quoter
    ) external onlyOwner {
        _validateSurpSwapCore(_router, _pm, _quoter);
        router = ISurpSwapV3SwapRouter(_router);
        pm = ISurpSwapV3PositionManager(_pm);
        quoter = ISurpSwapV3Quoter(_quoter);
    }

    function initializeConfig(
        address _router,
        address _pm,
        address _quoter
    ) external onlyOwner {
        _validateSurpSwapCore(_router, _pm, _quoter);
        router = ISurpSwapV3SwapRouter(_router);
        pm = ISurpSwapV3PositionManager(_pm);
        quoter = ISurpSwapV3Quoter(_quoter);
    }
}