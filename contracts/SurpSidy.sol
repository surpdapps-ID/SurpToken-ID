// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/SurpSwapV3Interfaces.sol";

interface IERC20Custom {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
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

contract SurpSidy is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant CONFIG_TIMELOCK_DELAY = 1 days;
    uint256 private constant BUY_SLIPPAGE_BPS = 200;
    TimelockController public immutable configTimelock;
    uint256 public configOperationNonce;

    IERC20 public token;
    IERC20 public tokenB;
    IWETH public weth;
    ISurpSwapV3SwapRouter public router;
    ISurpSwapV3PositionManager public pm;
    ISurpSwapV3Quoter public quoter;
    ISurpSwapV3QuoterV2 public quoterV2;
    ILPManager public lpManager;
    
    mapping(uint24 => ISurpSwapV3Pool) public feePools;
    uint32 public twapInterval = 180;     
    uint24 public maxTwapDeviation = 200; 
    mapping(uint24 => ISurpSwapV3Pool) public tokenBFeePools;
    uint32 public tokenBTwapInterval = 180;
    uint24 public tokenBMaxTwapDeviation = 200;

    enum BuyMode { LP_FIRST, SWAP_FIRST, PURE_SWAP, LP50_SWAP50 }
    mapping(BuyMode => bool) public enabledBuyModes;

    bool public sellPaused;
    bool public emergencyStop;

    uint256 public maxSubsidyPerTx = 9999999999999999999999999999999999999999999999999999 ether;
    uint256 public dailySubsidyLimit = 9999999999999999999999999999999999999999999999999999 ether;
    uint256 public usedToday;
    uint256 public lastReset;
    uint256 public maxDeviationBps = 500;

    mapping(address => uint256) public lastBuy;
    uint256[] public lpPositions;

    modifier notStopped() {
        require(!emergencyStop, "stopped");
        _;
    }

    modifier validFee(uint24 fee) {
        require(fee == 3000 || fee == 10000, "Invalid fee tier. Only 0.3% or 1% allowed");
        _;
    }

    modifier onlyOwnerOrConfigTimelock() {
        require(
            msg.sender == owner() || msg.sender == address(configTimelock),
            "not owner or timelock"
        );
        _;
    }

    constructor(
        address _token,
        address _weth,
        address _router,
        address _pm,
        address _quoter,
        address _quoterV2,
        address _lp
    ) {
        token = IERC20(_token);
        weth = IWETH(_weth);
        _validateSurpSwapCore(_router, _pm, _quoter, _quoterV2);
        router = ISurpSwapV3SwapRouter(_router);
        pm = ISurpSwapV3PositionManager(_pm);
        quoter = ISurpSwapV3Quoter(_quoter);
        quoterV2 = ISurpSwapV3QuoterV2(_quoterV2);
        lpManager = ILPManager(_lp);
        address[] memory proposers = new address[](1);
        proposers[0] = address(this);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        configTimelock = new TimelockController(
            CONFIG_TIMELOCK_DELAY,
            proposers,
            executors,
            address(0)
        );
        lastReset = block.timestamp;
        enabledBuyModes[BuyMode.LP_FIRST]=true;
        enabledBuyModes[BuyMode.SWAP_FIRST]=true;
        enabledBuyModes[BuyMode.PURE_SWAP]=true;
        enabledBuyModes[BuyMode.LP50_SWAP50]=true;
    }

    function _validateSurpSwapCore(
        address routerAddress,
        address positionManagerAddress,
        address quoterAddress,
        address quoterV2Address
    ) private view {
        require(
            routerAddress.code.length > 0 &&
                positionManagerAddress.code.length > 0 &&
                quoterAddress.code.length > 0 &&
                quoterV2Address.code.length > 0,
            "Invalid SurpSwap periphery"
        );
        address factory = ISurpSwapV3SwapRouter(routerAddress).factory();
        require(factory.code.length > 0, "Invalid SurpSwap factory");
        require(
            ISurpSwapV3PositionManager(positionManagerAddress).factory() == factory &&
                ISurpSwapV3Quoter(quoterAddress).factory() == factory &&
                ISurpSwapV3QuoterV2(quoterV2Address).factory() == factory,
            "SurpSwap factory mismatch"
        );
    }

    // ============================================================
    // BUY
    // ============================================================
    function buy(BuyMode mode, uint24 fee)
        external
        payable
        nonReentrant
        notStopped
        validFee(fee)
    {
        _buy(mode, fee, 0, block.timestamp);
    }

    function buy(
        BuyMode mode,
        uint24 fee,
        uint256 amountOutMinimum,
        uint256 deadline
    )
        external
        payable
        nonReentrant
        notStopped
        validFee(fee)
    {
        require(amountOutMinimum > 0, "Minimum output nol");
        require(deadline >= block.timestamp, "Transaction expired");
        _buy(mode, fee, amountOutMinimum, deadline);
    }

    function buyWithProtection(
        BuyMode mode,
        uint24 fee,
        uint256 amountOutMinimum,
        uint256 deadline
    )
        external
        payable
        nonReentrant
        notStopped
        validFee(fee)
    {
        require(amountOutMinimum > 0, "Minimum output nol");
        require(deadline >= block.timestamp, "Transaction expired");
        _buy(mode, fee, amountOutMinimum, deadline);
    }

    function _buy(
        BuyMode mode,
        uint24 fee,
        uint256 amountOutMinimum,
        uint256 deadline
    ) internal {
        require(msg.value > 0, "no ETH");
        require(block.timestamp > lastBuy[msg.sender] + 10, "cooldown");

        _validateTWAP(fee);
        require(enabledBuyModes[mode], "Buy mode disabled");

        lastBuy[msg.sender] = block.timestamp;
        (int24 tickLower, int24 tickUpper) = _getTicks(fee);

        if (mode == BuyMode.LP_FIRST) {
            _buyLpFirst(
                msg.value,
                fee,
                tickLower,
                tickUpper,
                amountOutMinimum,
                deadline
            );
        } else if (mode == BuyMode.SWAP_FIRST) {
            _buySwapFirst(
                msg.value,
                fee,
                tickLower,
                tickUpper,
                amountOutMinimum,
                deadline
            );
        } else if (mode == BuyMode.LP50_SWAP50) {
            _buyLp50Swap50(
                msg.value,
                fee,
                tickLower,
                tickUpper,
                amountOutMinimum,
                deadline
            );
        } else {
            _buyPure(msg.value, fee, amountOutMinimum, deadline);
        }
    }

    function _buyLpFirst(
        uint256 eth,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 amountOutMinimum,
        uint256 deadline
    ) internal {
        uint256 lpEth = eth / 2;
        uint256 swapEth = eth - lpEth;

        uint256 totalMarketValue = _getExactMarketPrice(eth, fee); 

        uint256 tokenValueForLP = _getMinOut(lpEth, fee);
        uint256 srpLP = lpManager.useForLP(tokenValueForLP);             

        _addLiquidity(lpEth, srpLP, fee, tickLower, tickUpper, deadline); 

        uint256 out = _swapETH(swapEth, fee, deadline);

        uint256 finalTransferAmount = out;
        if (totalMarketValue > out) {
            uint256 deficit = totalMarketValue - out;
            
            _checkAndUpdateSubsidy(deficit);

            uint256 exactSubsidy = lpManager.useForLP(deficit);
            finalTransferAmount += exactSubsidy;
        }

        require(finalTransferAmount >= amountOutMinimum, "Insufficient token output");
        token.safeTransfer(msg.sender, finalTransferAmount);
    }

    function _buySwapFirst(
        uint256 eth,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 amountOutMinimum,
        uint256 deadline
    ) internal {
        uint256 swapEth = eth / 2;
        uint256 lpEth = eth - swapEth;

        uint256 totalMarketValue = _getExactMarketPrice(eth, fee);

        uint256 out = _swapETH(swapEth, fee, deadline);
        
        uint256 tokenValueForLP = _getMinOut(lpEth, fee);
        uint256 srpLP = lpManager.useForLP(tokenValueForLP);             
        _addLiquidity(lpEth, srpLP, fee, tickLower, tickUpper, deadline);

        uint256 finalTransferAmount = out;
        if (totalMarketValue > out) {
            uint256 deficit = totalMarketValue - out;
            
            _checkAndUpdateSubsidy(deficit);

            uint256 exactSubsidy = lpManager.useForLP(deficit);
            finalTransferAmount += exactSubsidy;
        }

        require(finalTransferAmount >= amountOutMinimum, "Insufficient token output");
        token.safeTransfer(msg.sender, finalTransferAmount);
    }

    function _buyLp50Swap50(
        uint256 eth,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 amountOutMinimum,
        uint256 deadline
    ) internal {
        uint256 lpEth = eth / 2;
        uint256 swapEth = eth - lpEth;
        uint256 tokenValueForLP = _getMinOut(lpEth, fee);
        uint256 srpLP = lpManager.useForLP(tokenValueForLP);
        _addLiquidity(lpEth, srpLP, fee, tickLower, tickUpper, deadline);
        uint256 out = _swapETH(swapEth, fee, deadline);
        require(out >= amountOutMinimum, "Insufficient token output");
        token.safeTransfer(msg.sender, out);
    }

    function _buyPure(
        uint256 eth,
        uint24 fee,
        uint256 amountOutMinimum,
        uint256 deadline
    ) internal {
        uint256 out = _swapETH(eth, fee, deadline);
        require(out >= amountOutMinimum, "Insufficient token output");
        token.safeTransfer(msg.sender, out); 
    }

    function buyWithTokenB(
        uint256 amount,
        BuyMode mode,
        uint24 fee,
        uint256 amountOutMinimum
    ) external nonReentrant notStopped validFee(fee) {
        require(address(tokenB) != address(0), "Token B belum dikonfigurasi");
        require(amount > 0, "Jumlah token B nol");
        require(block.timestamp > lastBuy[msg.sender] + 10, "cooldown");
        require(enabledBuyModes[mode], "Buy mode disabled");

        _validateTWAPForPool(
            tokenBFeePools[fee],
            tokenBTwapInterval,
            tokenBMaxTwapDeviation
        );

        lastBuy[msg.sender] = block.timestamp;
        tokenB.safeTransferFrom(msg.sender, address(this), amount);

        (int24 tickLower, int24 tickUpper) = _getTicksForPool(
            fee,
            tokenBFeePools[fee]
        );
        uint256 out;

        if (mode == BuyMode.PURE_SWAP) {
            out = _swapTokenB(amount, fee, amountOutMinimum);
        } else {
            uint256 lpAmount = amount / 2;
            uint256 swapAmount = amount - lpAmount;

            if (mode == BuyMode.LP_FIRST || mode == BuyMode.LP50_SWAP50) {
                _addTokenBLiquidity(lpAmount, fee, tickLower, tickUpper);
                out = _swapTokenB(swapAmount, fee, 0);
            } else {
                out = _swapTokenB(swapAmount, fee, 0);
                _addTokenBLiquidity(lpAmount, fee, tickLower, tickUpper);
            }

            if (mode != BuyMode.LP50_SWAP50) {
                uint256 expected = _getQuote(address(tokenB), address(token), amount, fee);
                if (expected > out) {
                    uint256 subsidy = expected - out;
                    _checkAndUpdateSubsidy(subsidy);
                    out += lpManager.useForLP(subsidy);
                }
            }
        }

        require(out >= amountOutMinimum, "Insufficient token output");
        token.safeTransfer(msg.sender, out);
    }

    // ============================================================
    // SWAP
    // ============================================================
    function _swapETH(uint256 amount, uint24 fee, uint256 deadline) internal returns (uint256) {
        uint256 quoted = _getExactMarketPrice(amount, fee);
        uint256 minOut = (quoted * (10000 - BUY_SLIPPAGE_BPS)) / 10000;

        weth.deposit{value: amount}();
        weth.approve(address(router), 0);
        weth.approve(address(router), amount);

        uint256 out = router.exactInputSingle(
            ISurpSwapV3SwapRouter.ExactInputSingleParams({
                tokenIn: address(weth),
                tokenOut: address(token),
                fee: fee,
                recipient: address(this),
                deadline: deadline,
                amountIn: amount,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        _validatePrice(quoted, out);
        return out;
    }

    function _swapTokenB(
        uint256 amount,
        uint24 fee,
        uint256 amountOutMinimum
    ) internal returns (uint256) {
        uint256 quoted = _getQuote(address(tokenB), address(token), amount, fee);
        uint256 minOut = (quoted * (10000 - BUY_SLIPPAGE_BPS)) / 10000;
        if (amountOutMinimum > minOut) {
            minOut = amountOutMinimum;
        }

        tokenB.safeApprove(address(router), 0);
        tokenB.safeApprove(address(router), amount);

        uint256 out = router.exactInputSingle(
            ISurpSwapV3SwapRouter.ExactInputSingleParams({
                tokenIn: address(tokenB),
                tokenOut: address(token),
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amount,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        _validatePrice(quoted, out);
        return out;
    }

    function _getMinOut(uint256 amount, uint24 fee) internal returns (uint256) {
        uint256 quoted = _getExactMarketPrice(amount, fee);
        return (quoted * (10000 - BUY_SLIPPAGE_BPS)) / 10000;
    }

    function _getExactMarketPrice(uint256 amount, uint24 fee) internal returns (uint256) {
        return _getQuote(address(weth), address(token), amount, fee);
    }

    function _getQuote(address tokenIn, address tokenOut, uint256 amount, uint24 fee)
        internal
        returns (uint256 quoted)
    {
        try quoter.quoteExactInputSingle(
            tokenIn,
            tokenOut,
            fee,
            amount,
            0
        ) returns (uint256 amountOut) {
            quoted = amountOut;
        } catch (bytes memory reason) {
            if (reason.length == 32) {
                quoted = abi.decode(reason, (uint256));
            } else {
                revert("SurpSwap quoter failed");
            }
        }
    }

    function _validatePrice(uint256 quoted, uint256 actual) internal view {
        require(quoted > 0, "Harga quote nol");
        uint256 diff = quoted > actual ? quoted - actual : actual - quoted;
        require((diff * 10000) / quoted < maxDeviationBps, "manipulated");
    }

    // ============================================================
    // LP
    // ============================================================
    function _addLiquidity(
        uint256 ethAmount,
        uint256 tokenAmount,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 deadline
    ) internal returns (uint256) {
        weth.deposit{value: ethAmount}();
        
        weth.approve(address(pm), 0);
        weth.approve(address(pm), ethAmount);
        
        token.approve(address(pm), 0);
        token.approve(address(pm), tokenAmount);

        bool isToken0 = address(token) < address(weth);
        address t0 = isToken0 ? address(token) : address(weth);
        address t1 = isToken0 ? address(weth) : address(token);
        uint256 a0 = isToken0 ? tokenAmount : ethAmount;
        uint256 a1 = isToken0 ? ethAmount : tokenAmount;

        (uint256 id,, uint256 amount0, uint256 amount1) = pm.mint(
            ISurpSwapV3PositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: a0,
                amount1Desired: a1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this), 
                deadline: deadline
            })
        );
        lpPositions.push(id);

        uint256 usedToken = isToken0 ? amount0 : amount1;
        return usedToken; 
    }

    function _getTicks(uint24 fee) internal view returns (int24, int24) {
        return _getTicksForPool(fee, feePools[fee]);
    }

    function _getTicksForPool(uint24 fee, ISurpSwapV3Pool targetPool)
        internal
        view
        returns (int24, int24)
    {
        require(address(targetPool) != address(0), "Pool belum di-set");
        
        (, int24 currentTick,,,,,) = targetPool.slot0();
        int24 spacing = fee == 3000 ? int24(60) : int24(200);
        
        int24 lower = (currentTick / spacing) * spacing - (spacing * 100);
        int24 upper = (currentTick / spacing) * spacing + (spacing * 100);
        return (lower, upper);
    }

    function _addTokenBLiquidity(
        uint256 tokenBAmount,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper
    ) internal {
        uint256 tokenAmount = lpManager.useForLP(
            _getQuote(address(tokenB), address(token), tokenBAmount, fee)
        );
        _mintTokenBLiquidity(
            tokenBAmount,
            tokenAmount,
            fee,
            tickLower,
            tickUpper
        );
    }

    function _mintTokenBLiquidity(
        uint256 tokenBAmount,
        uint256 tokenAmount,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper
    ) internal {
        tokenB.safeApprove(address(pm), 0);
        tokenB.safeApprove(address(pm), tokenBAmount);
        token.safeApprove(address(pm), 0);
        token.safeApprove(address(pm), tokenAmount);

        bool isToken0 = address(token) < address(tokenB);
        (uint256 id,,,) = pm.mint(
            ISurpSwapV3PositionManager.MintParams({
                token0: isToken0 ? address(token) : address(tokenB),
                token1: isToken0 ? address(tokenB) : address(token),
                fee: fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: isToken0 ? tokenAmount : tokenBAmount,
                amount1Desired: isToken0 ? tokenBAmount : tokenAmount,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        lpPositions.push(id);
    }

    // ============================================================
    // AUTO COMPOUND 
    // ============================================================
    function autoCompound(uint256 tokenId, uint24 fee) external onlyOwner validFee(fee) {
        (uint256 amount0, uint256 amount1) = pm.collect(
            ISurpSwapV3PositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        bool isToken0 = address(token) < address(weth);
        uint256 tokenAmt = isToken0 ? amount0 : amount1;
        uint256 wethAmt = isToken0 ? amount1 : amount0;

        token.approve(address(pm), 0);
        token.approve(address(pm), tokenAmt);
        
        weth.approve(address(pm), 0);
        weth.approve(address(pm), wethAmt);

        (int24 tickLower, int24 tickUpper) = _getTicks(fee);

        address t0 = isToken0 ? address(token) : address(weth);
        address t1 = isToken0 ? address(weth) : address(token);
        uint256 a0 = isToken0 ? tokenAmt : wethAmt;
        uint256 a1 = isToken0 ? wethAmt : tokenAmt;

        pm.mint(
            ISurpSwapV3PositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: a0,
                amount1Desired: a1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
    }

    function autoCompoundTokenB(uint256 tokenId, uint24 fee)
        external
        onlyOwner
        validFee(fee)
    {
        require(address(tokenB) != address(0), "Token B belum dikonfigurasi");
        (int24 tickLower, int24 tickUpper) = _getTicksForPool(
            fee,
            tokenBFeePools[fee]
        );
        (uint256 amount0, uint256 amount1) = pm.collect(
            ISurpSwapV3PositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        bool isToken0 = address(token) < address(tokenB);
        _mintTokenBLiquidity(
            isToken0 ? amount1 : amount0,
            isToken0 ? amount0 : amount1,
            fee,
            tickLower,
            tickUpper
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
    function sell(
        uint256 amount,
        uint24 fee,
        uint256 amountOutMinimum
    ) external nonReentrant validFee(fee) {
        _sell(amount, fee, amountOutMinimum);
    }

    function _sell(uint256 amount, uint24 fee, uint256 amountOutMinimum) internal {
        require(!sellPaused, "paused");
        require(amountOutMinimum > 0, "Minimum output nol");
        require(amount > 0, "Jumlah SRP nol");

        token.safeTransferFrom(msg.sender, address(this), amount);
        token.approve(address(router), 0);
        token.approve(address(router), amount);

        uint256 out = router.exactInputSingle(
            ISurpSwapV3SwapRouter.ExactInputSingleParams({
                tokenIn: address(token),
                tokenOut: address(weth),
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amount,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );

        weth.withdraw(out);
        payable(msg.sender).transfer(out);
    }

    function sellForTokenB(
        uint256 amount,
        uint24 fee,
        uint256 amountOutMinimum
    )     external nonReentrant validFee(fee) {
        _sellForTokenB(amount, fee, amountOutMinimum);
    }

    function _sellForTokenB(
        uint256 amount,
        uint24 fee,
        uint256 amountOutMinimum
    ) internal {
    require(!sellPaused, "paused");
    require(address(tokenB) != address(0), "Token B belum dikonfigurasi");
        require(amount > 0, "Jumlah SRP nol");

        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 quoted = _getQuote(address(token), address(tokenB), amount, fee);
        uint256 minOut = (quoted * (10000 - BUY_SLIPPAGE_BPS)) / 10000;
        if (amountOutMinimum > minOut) {
            minOut = amountOutMinimum;
        }

        token.safeApprove(address(router), 0);
        token.safeApprove(address(router), amount);
        uint256 out = router.exactInputSingle(
            ISurpSwapV3SwapRouter.ExactInputSingleParams({
                tokenIn: address(token),
                tokenOut: address(tokenB),
                fee: fee,
                recipient: msg.sender,
                deadline: block.timestamp,
                amountIn: amount,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        _validatePrice(quoted, out);
    }

    // ============================================================
    // FITUR INTERNAL KEAMANAN
    // ============================================================
    function _validateTWAP(uint24 fee) internal view {
        ISurpSwapV3Pool targetPool = feePools[fee];
        require(address(targetPool).code.length > 0, "TWAP pool not configured");

        address expectedToken0 = address(token) < address(weth)
            ? address(token)
            : address(weth);
        address expectedToken1 = address(token) < address(weth)
            ? address(weth)
            : address(token);
        require(targetPool.token0() == expectedToken0, "TWAP pool token0 mismatch");
        require(targetPool.token1() == expectedToken1, "TWAP pool token1 mismatch");
        require(targetPool.fee() == fee, "TWAP pool fee mismatch");

        _validateTWAPForPool(targetPool, twapInterval, maxTwapDeviation);
    }

    function _validateTWAPForPool(
        ISurpSwapV3Pool targetPool,
        uint32 interval,
        uint24 maxDeviation
    ) internal view {
        require(address(targetPool) != address(0), "TWAP pool not configured");
        require(interval > 0, "TWAP interval nol");

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = interval;
        secondsAgos[1] = 0;

        int56[] memory tickCumulatives;
        try targetPool.observe(secondsAgos) returns (
            int56[] memory observedTickCumulatives,
            uint160[] memory
        ) {
            tickCumulatives = observedTickCumulatives;
        } catch {
            revert("TWAP observation failed");
        }

        require(tickCumulatives.length >= 2, "Invalid TWAP observations");
        int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
        int24 timeWeightedTick = int24(tickCumulativesDelta / int56(uint56(interval)));
        (, int24 currentTick,,,,,) = targetPool.slot0();
        int24 tickDeviation = currentTick > timeWeightedTick
            ? currentTick - timeWeightedTick
            : timeWeightedTick - currentTick;
        require(uint24(tickDeviation) < maxDeviation, "TWAP Deviation too high! Potential MEV");
    }

    function _checkAndUpdateSubsidy(uint256 amount) internal {
        require(amount <= maxSubsidyPerTx, "Exceeds max subsidy per tx");

        if (block.timestamp >= lastReset + 1 days) {
            lastReset = block.timestamp;
            usedToday = 0;
        }

        require(usedToday + amount <= dailySubsidyLimit, "Exceeds daily subsidy limit");
        usedToday += amount;
    }

    // ============================================================
    // ADMIN
    // ============================================================
    function setBuyModeEnabled(BuyMode mode, bool enabled) external onlyOwner {
        enabledBuyModes[mode] = enabled;
    }

    function setSellPaused(bool b) external onlyOwner {
        sellPaused = b;
    }

    function triggerEmergency() external onlyOwner {
        emergencyStop = true;
    }

    function rescueToken(address t, uint256 a) external onlyOwner {
        require(t != address(0), "Token address nol");
        IERC20(t).safeTransfer(msg.sender, a);
    }

    function rescueNative(uint256 amount) external onlyOwner {
        uint256 balance = address(this).balance;
        uint256 withdrawAmount = amount > balance ? balance : amount;
        require(withdrawAmount > 0, "Tidak ada saldo native");
        
        (bool success, ) = payable(msg.sender).call{value: withdrawAmount}("");
        require(success, "Gagal menarik Native Asset");
    }

    receive() external payable {}

    // FIXED: Menambahkan _quoterV2 ke parameter
    function setCoreAddresses(address _router, address _pm, address _quoter, address _quoterV2, address _lp) external onlyOwnerOrConfigTimelock {
        if (msg.sender != address(configTimelock)) {
            _scheduleConfigOperation(msg.data);
            return;
        }

        _validateSurpSwapCore(_router, _pm, _quoter, _quoterV2);
        router = ISurpSwapV3SwapRouter(_router);
        pm = ISurpSwapV3PositionManager(_pm);
        quoter = ISurpSwapV3Quoter(_quoter);
        quoterV2 = ISurpSwapV3QuoterV2(_quoterV2);
        lpManager = ILPManager(_lp);
    }

    // FIXED: Menambahkan _quoterV2 ke parameter
    function initializeConfig(address _router, address _pm, address _quoter, address _quoterV2, address _lp) external onlyOwnerOrConfigTimelock {
        if (msg.sender != address(configTimelock)) {
            _scheduleConfigOperation(msg.data);
            return;
        }

        _validateSurpSwapCore(_router, _pm, _quoter, _quoterV2);
        router = ISurpSwapV3SwapRouter(_router);
        pm = ISurpSwapV3PositionManager(_pm);
        quoter = ISurpSwapV3Quoter(_quoter);
        quoterV2 = ISurpSwapV3QuoterV2(_quoterV2);
        lpManager = ILPManager(_lp);
    }

    function setLPManager(address _lp) external onlyOwnerOrConfigTimelock {
        if (msg.sender != address(configTimelock)) {
            _scheduleConfigOperation(msg.data);
            return;
        }

        require(_lp != address(0), "Invalid address");
        lpManager = ILPManager(_lp);
    }

    function setPoolAndTwap(uint24 _fee, address _pool, uint32 _interval, uint24 _deviation) external onlyOwnerOrConfigTimelock validFee(_fee) {
        if (msg.sender != address(configTimelock)) {
            _scheduleConfigOperation(msg.data);
            return;
        }

        require(_pool != address(0) && _pool.code.length > 0, "Invalid TWAP pool");
        require(_interval > 0 && _deviation > 0, "TWAP config nol");
        ISurpSwapV3Pool targetPool = ISurpSwapV3Pool(_pool);
        require(targetPool.factory() == router.factory(), "Pool factory mismatch");
        address expectedToken0 = address(token) < address(weth)
            ? address(token)
            : address(weth);
        address expectedToken1 = address(token) < address(weth)
            ? address(weth)
            : address(token);
        require(targetPool.token0() == expectedToken0, "Pool token0 tidak cocok");
        require(targetPool.token1() == expectedToken1, "Pool token1 tidak cocok");
        require(targetPool.fee() == _fee, "Pool fee tidak cocok");

        feePools[_fee] = targetPool;
        twapInterval = _interval;
        maxTwapDeviation = _deviation;
    }

    function setSubsidyLimits(uint256 _maxPerTx, uint256 _dailyLimit) external onlyOwnerOrConfigTimelock {
        if (msg.sender != address(configTimelock)) {
            _scheduleConfigOperation(msg.data);
            return;
        }

        maxSubsidyPerTx = _maxPerTx;
        dailySubsidyLimit = _dailyLimit;
    }

    function setTokenB(address _tokenB) external onlyOwnerOrConfigTimelock {
        if (msg.sender != address(configTimelock)) {
            _scheduleConfigOperation(msg.data);
            return;
        }

        require(_tokenB != address(0), "Token B nol");
        require(_tokenB.code.length > 0, "Token B bukan kontrak");
        require(_tokenB != address(token) && _tokenB != address(weth), "Token B duplikat");
        tokenB = IERC20(_tokenB);
        delete tokenBFeePools[3000];
        delete tokenBFeePools[10000];
    }

    function setTokenBPoolAndTwap(
        uint24 _fee,
        address _pool,
        uint32 _interval,
        uint24 _deviation
    ) external onlyOwnerOrConfigTimelock validFee(_fee) {
        if (msg.sender != address(configTimelock)) {
            _scheduleConfigOperation(msg.data);
            return;
        }

        require(address(tokenB) != address(0), "Token B belum dikonfigurasi");
        require(_pool != address(0), "Pool token B nol");
        require(_interval > 0 && _deviation > 0, "TWAP config nol");

        ISurpSwapV3Pool targetPool = ISurpSwapV3Pool(_pool);
        require(targetPool.factory() == router.factory(), "Pool factory mismatch");
        address expectedToken0 = address(token) < address(tokenB)
            ? address(token)
            : address(tokenB);
        address expectedToken1 = address(token) < address(tokenB)
            ? address(tokenB)
            : address(token);
        require(targetPool.token0() == expectedToken0, "Pool token0 tidak cocok");
        require(targetPool.token1() == expectedToken1, "Pool token1 tidak cocok");
        require(targetPool.fee() == _fee, "Pool fee tidak cocok");

        tokenBFeePools[_fee] = targetPool;
        tokenBTwapInterval = _interval;
        tokenBMaxTwapDeviation = _deviation;
    }

    function executeConfig(uint256 nonce, bytes calldata data) external {
        configTimelock.execute(
            address(this),
            0,
            data,
            bytes32(0),
            bytes32(nonce)
        );
    }

    function cancelConfig(uint256 nonce, bytes calldata data) external onlyOwner {
        configTimelock.cancel(
            configTimelock.hashOperation(
                address(this),
                0,
                data,
                bytes32(0),
                bytes32(nonce)
            )
        );
    }

    function _scheduleConfigOperation(bytes calldata data) internal {
        uint256 nonce = ++configOperationNonce;
        bytes32 salt = bytes32(nonce);
        uint256 readyAt = block.timestamp + configTimelock.getMinDelay();

        configTimelock.schedule(
            address(this),
            0,
            data,
            bytes32(0),
            salt,
            configTimelock.getMinDelay()
        );

        bytes32 operationId = configTimelock.hashOperation(
            address(this),
            0,
            data,
            bytes32(0),
            salt
        );
        emit ConfigOperationScheduled(operationId, nonce, readyAt, data);
    }

    event ConfigOperationScheduled(
        bytes32 indexed operationId,
        uint256 indexed nonce,
        uint256 readyAt,
        bytes data
    );
    // ============================================================
    // ERC721 RECEIVER HANDLER
    // ============================================================
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return bytes4(keccak256("onERC721Received(address,address,uint256,bytes)"));
    }
}