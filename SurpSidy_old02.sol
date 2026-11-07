// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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

interface ISwapRouter {
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
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

interface INonfungiblePositionManager {
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
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    function mint(MintParams calldata params) external payable returns (uint256, uint128, uint256, uint256);
    function collect(CollectParams calldata params) external returns (uint256, uint256);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params) external returns (uint256, uint256);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface IQuoter {
    function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256);
}


interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96;
    }
    function quoteExactInputSingle(QuoteExactInputSingleParams calldata params) external returns (uint256,uint160,uint32,uint256);
}
interface ILPManager {
    function useForLP(uint256 amount) external returns (uint256);
}

interface IUniswapV3Pool {
    function observe(uint32[] calldata secondsAgos) external view returns (
        int56[] memory tickCumulatives,
        uint160[] memory secondsPerLiquidityCumulativeX156
    );
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint160 observationIndex,
        uint160 observationCardinality,
        uint160 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    );
}

contract SurpSidy is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    IERC20 public token;
    IWETH public weth;
    ISwapRouter public router;
    INonfungiblePositionManager public pm;
    IQuoter public quoter;
    IQuoterV2 public quoterV2;
    ILPManager public lpManager;
    
    // FITUR KEAMANAN: Mapping Baru untuk Mendukung Multi-Pool TWAP Oracle (0.3% & 1%)
    mapping(uint24 => IUniswapV3Pool) public feePools;
    uint32 public twapInterval = 180;     
    uint24 public maxTwapDeviation = 200; 

    enum BuyMode { LP_FIRST, SWAP_FIRST, PURE_SWAP }
    BuyMode public buyMode;

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

    // MODIFIER: Membatasi agar hanya fee pool 0.3% (3000) dan 1% (10000) yang bisa dieksekusi
    modifier validFee(uint24 fee) {
        require(fee == 3000 || fee == 10000, "Invalid fee tier. Only 0.3% or 1% allowed");
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
        router = ISwapRouter(_router);
        pm = INonfungiblePositionManager(_pm);
        quoter = IQuoter(_quoter);
        quoterV2 = IQuoterV2(_quoterV2);
        lpManager = ILPManager(_lp);
        lastReset = block.timestamp;
    }

    // ============================================================
    // BUY (Menerima input fee dinamis dari frontend)
    // ============================================================
    function buy(uint24 fee) external payable nonReentrant notStopped validFee(fee) {
        require(msg.value > 0, "no ETH");
        require(block.timestamp > lastBuy[msg.sender] + 10, "cooldown");

        // Validasi TWAP pool spesifik yang dipilih user
        _validateTWAP(fee);

        lastBuy[msg.sender] = block.timestamp;

        // Ambil tick terupdate secara dinamis dari pool pasaran saat eksekusi buy dilakukan
        (int24 tickLower, int24 tickUpper) = _getTicks(fee);

        if (buyMode == BuyMode.LP_FIRST) {
            _buyLpFirst(msg.value, fee, tickLower, tickUpper);
        } else if (buyMode == BuyMode.SWAP_FIRST) {
            _buySwapFirst(msg.value, fee, tickLower, tickUpper);
        } else {
            _buyPure(msg.value, fee);
        }
    }

    function _buyLpFirst(uint256 eth, uint24 fee, int24 tickLower, int24 tickUpper) internal {
        uint256 lpEth = eth / 2;
        uint256 swapEth = eth - lpEth;

        uint256 totalMarketValue = _getExactMarketPrice(eth, fee); 

        uint256 tokenValueForLP = _getMinOut(lpEth, fee); 
        uint256 srpLP = lpManager.useForLP(tokenValueForLP);             

        _addLiquidity(lpEth, srpLP, fee, tickLower, tickUpper); 

        uint256 out = _swapETH(swapEth, fee); 

        uint256 finalTransferAmount = out;
        if (totalMarketValue > out) {
            uint256 deficit = totalMarketValue - out;
            
            _checkAndUpdateSubsidy(deficit);

            uint256 exactSubsidy = lpManager.useForLP(deficit);
            finalTransferAmount += exactSubsidy;
        }

        token.safeTransfer(msg.sender, finalTransferAmount);
    }

    function _buySwapFirst(uint256 eth, uint24 fee, int24 tickLower, int24 tickUpper) internal {
        uint256 swapEth = eth / 2;
        uint256 lpEth = eth - swapEth;

        uint256 totalMarketValue = _getExactMarketPrice(eth, fee);

        uint256 out = _swapETH(swapEth, fee);
        
        uint256 tokenValueForLP = _getMinOut(lpEth, fee);
        uint256 srpLP = lpManager.useForLP(tokenValueForLP);             
        _addLiquidity(lpEth, srpLP, fee, tickLower, tickUpper);

        uint256 finalTransferAmount = out;
        if (totalMarketValue > out) {
            uint256 deficit = totalMarketValue - out;
            
            _checkAndUpdateSubsidy(deficit);

            uint256 exactSubsidy = lpManager.useForLP(deficit);
            finalTransferAmount += exactSubsidy;
        }

        token.safeTransfer(msg.sender, finalTransferAmount);
    }

    function _buyPure(uint256 eth, uint24 fee) internal {
        uint256 out = _swapETH(eth, fee);
        token.safeTransfer(msg.sender, out); 
    }

    // ============================================================
    // SWAP
    // ============================================================
    function _swapETH(uint256 amount, uint24 fee) internal returns (uint256) {
        uint256 quoted = _getExactMarketPrice(amount, fee);
        uint256 minOut = (quoted * 98) / 100; // Slippage tolerance 2%

        weth.deposit{value: amount}();
        weth.approve(address(router), 0);
        weth.approve(address(router), amount);

        uint256 out = router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(weth),
                tokenOut: address(token),
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amount,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        // OPTIMASI: Validasi deviasi langsung menggunakan perbandingan harga asli pasaran vs output asli
        _validatePrice(quoted, out);
        return out;
    }

    function _getMinOut(uint256 amount, uint24 fee) internal returns (uint256) {
        uint256 quoted = _getExactMarketPrice(amount, fee);
        return (quoted * 98) / 100;
    }

    function _getExactMarketPrice(uint256 amount, uint24 fee) internal returns (uint256) {
        uint256 quoted = 0;
        try quoter.quoteExactInputSingle(
            address(weth),
            address(token),
            fee,
            amount,
            0
        ) returns (uint256 amountOut) {
            quoted = amountOut;
        } catch (bytes memory reason) {
            if (reason.length == 32) {
                quoted = abi.decode(reason, (uint256));
            } else {
                revert("Quoter Uniswap gagal");
            }
        }
        return quoted;
    }

    function _validatePrice(uint256 quoted, uint256 actual) internal view {
        uint256 diff = quoted > actual ? quoted - actual : actual - quoted;
        require((diff * 10000) / quoted < maxDeviationBps, "manipulated");
    }

    // ============================================================
    // LP
    // ============================================================
    function _addLiquidity(uint256 ethAmount, uint256 tokenAmount, uint24 fee, int24 tickLower, int24 tickUpper) internal returns (uint256) {
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
            INonfungiblePositionManager.MintParams({
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
        lpPositions.push(id);

        uint256 usedToken = isToken0 ? amount0 : amount1;
        return usedToken; 
    }

    // PERBAIKAN: Menyesuaikan Tick Spacing Dinamis Berdasarkan Tingkat Fee Pool Uniswap V3
    function _getTicks(uint24 fee) internal view returns (int24, int24) {
        IUniswapV3Pool targetPool = feePools[fee];
        require(address(targetPool) != address(0), "Pool belum di-set");
        
        (, int24 currentTick,,,,,) = targetPool.slot0();
        int24 spacing = fee == 3000 ? int24(60) : int24(200);
        
        int24 lower = (currentTick / spacing) * spacing - (spacing * 100);
        int24 upper = (currentTick / spacing) * spacing + (spacing * 100);
        return (lower, upper);
    }

    // ============================================================
    // AUTO COMPOUND 
    // ============================================================
    function autoCompound(uint256 tokenId, uint24 fee) external onlyOwner validFee(fee) {
        (uint256 amount0, uint256 amount1) = pm.collect(
            INonfungiblePositionManager.CollectParams({
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
            INonfungiblePositionManager.MintParams({
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

    // ============================================================
    // LP CONTROL
    // ============================================================
    function withdrawLP(uint256 tokenId, address to) external onlyOwner {
        pm.safeTransferFrom(address(this), to, tokenId);
    }

    function decreaseLP(uint256 tokenId, uint128 liquidity) external onlyOwner {
        pm.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        );
    }

    // ============================================================
    // SELL (Menerima input fee dinamis dari frontend)
    // ============================================================
    function sell(uint256 amount, uint24 fee) external nonReentrant validFee(fee) {
        require(!sellPaused, "paused");

        token.safeTransferFrom(msg.sender, address(this), amount);
        token.approve(address(router), 0);
        token.approve(address(router), amount);

        uint256 out = router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(token),
                tokenOut: address(weth),
                fee: fee,
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
    // FITUR INTERNAL KEAMANAN
    // ============================================================
    function _validateTWAP(uint24 fee) internal view {
        IUniswapV3Pool targetPool = feePools[fee];
        if (address(targetPool) == address(0)) return; // Bypass jika pool fee tersebut belum di-set admin

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapInterval;
        secondsAgos[1] = 0;

        try targetPool.observe(secondsAgos) returns (int56[] memory tickCumulatives, uint160[] memory) {
            int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
            int24 timeWeightedTick = int24(tickCumulativesDelta / int56(int32(twapInterval)));

            (, int24 currentTick,,,,,) = targetPool.slot0();
            
            int24 tickDeviation = currentTick > timeWeightedTick ? currentTick - timeWeightedTick : timeWeightedTick - currentTick;
            
            require(uint24(tickDeviation) < maxTwapDeviation, "TWAP Deviation too high! Potential MEV");
        } catch {
            // Bypass jika data observasi history belum mencukupi 3 menit
        }
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
    // ADMIN (DIPERBARUI: Ditambahkan Fungsi Penyelamat Dana Nyangkut)
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

    // Perbaikan: Menggunakan standard IERC20 + SafeERC20 dari OpenZeppelin agar WETH / Token apapun bisa ditarik mulus
    function rescueToken(address t, uint256 a) external onlyOwner {
        require(t != address(0), "Token address nol");
        IERC20(t).safeTransfer(msg.sender, a);
    }

    // BARU: Fungsi penyelamat khusus Native Asset (POL / ETH) yang tertinggal di dalam balance balance kontrak
    function rescueNative(uint256 amount) external onlyOwner {
        uint256 balance = address(this).balance;
        uint256 withdrawAmount = amount > balance ? balance : amount;
        require(withdrawAmount > 0, "Tidak ada saldo native");
        
        (bool success, ) = payable(msg.sender).call{value: withdrawAmount}("");
        require(success, "Gagal menarik Native Asset");
    }

    receive() external payable {}

    // UPDATE: Menambahkan _lp ke fungsi setCoreAddresses
    function setCoreAddresses(address _router, address _pm, address _quoter, address _lp) external onlyOwner {
        router = ISwapRouter(_router);
        pm = INonfungiblePositionManager(_pm);
        quoter = IQuoter(_quoter);
        quoterV2 = IQuoterV2(_quoterV2);
        lpManager = ILPManager(_lp);
    }

    // UPDATE: Menambahkan _lp ke fungsi initializeConfig
    function initializeConfig(address _router, address _pm, address _quoter, address _lp) external onlyOwner {
        router = ISwapRouter(_router);
        pm = INonfungiblePositionManager(_pm);
        quoter = IQuoter(_quoter);
        quoterV2 = IQuoterV2(_quoterV2);
        lpManager = ILPManager(_lp);
    }

    // NEW SETTER: Fungsi mandiri khusus untuk mengubah alamat LP Manager saja
    function setLPManager(address _lp) external onlyOwner {
        require(_lp != address(0), "Invalid address");
        lpManager = ILPManager(_lp);
    }

    // SETTER: Mengatur Alamat Pool spesifik sesuai tingkat fee-nya (3000 atau 10000)
    function setPoolAndTwap(uint24 _fee, address _pool, uint32 _interval, uint24 _deviation) external onlyOwner validFee(_fee) {
        feePools[_fee] = IUniswapV3Pool(_pool);
        twapInterval = _interval;
        maxTwapDeviation = _deviation;
    }

    function setSubsidyLimits(uint256 _maxPerTx, uint256 _dailyLimit) external onlyOwner {
        maxSubsidyPerTx = _maxPerTx;
        dailySubsidyLimit = _dailyLimit;
    }

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