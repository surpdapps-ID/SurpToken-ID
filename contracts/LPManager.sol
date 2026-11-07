
// pragma solidity ^0.8.20;

// import "@openzeppelin/contracts/access/Ownable2Step.sol";

// interface IERC20 {
//     function transfer(address to, uint256 amount) external returns (bool);
// }

// contract LPManager is Ownable2Step {

//     IERC20 public token;
//     address public subsidizer;

//     constructor(address _token) {
//         token = IERC20(_token);
//     }

//     function setSubsidizer(address s) external onlyOwner {
//         subsidizer = s;
//     }

//     function useForLP(uint256 amount) external returns (uint256) {
//         require(msg.sender == subsidizer, "not allowed");
//         token.transfer(msg.sender, amount);
//         return amount;
//     }
// }

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/SurpSwapV3Interfaces.sol";

interface IWETH {
    function withdraw(uint256) external;
    function transfer(address to, uint256 amount) external returns (bool);
}

contract LPManager is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public token;
    IWETH public weth;

    address public subsidizer;
    address public investorSale;
    address public liquidityPositionManager;
    address public liquidityPairToken;
    address public payPalRelayer;
    uint256 public maxPayPalPayoutPerTransaction;
    uint256 public dailyPayPalPayoutLimit;
    uint256 public dailyPayPalPayoutDay;
    uint256 public dailyPayPalPayoutUsed;
    mapping(bytes32 => bool) public processedPayPalPayments;

    event PayPalPayoutConfigUpdated(
        address indexed relayer,
        uint256 maxPerTransaction,
        uint256 dailyLimit
    );
    event PayPalPayoutReleased(
        bytes32 indexed paymentId,
        address indexed to,
        uint256 amount,
        uint256 day
    );
    event LiquidityConfigUpdated(address indexed positionManager, address indexed pairToken);
    event LiquidityAddedByRelayer(
        address indexed relayer,
        uint256 indexed tokenId,
        uint128 liquidity,
        uint256 amountSRP,
        uint256 amountPairToken
    );

    constructor(address _token, address _weth) {
        token = IERC20(_token);
        weth = IWETH(_weth);
    }

    // =========================================================
    // SET SUBSIDIZER
    // =========================================================
    function setSubsidizer(address s) external onlyOwner {
        subsidizer = s;
    }

    function setInvestorSale(address sale) external onlyOwner {
        require(sale != address(0) && sale.code.length > 0, "invalid investor sale");
        investorSale = sale;
    }

    function setPayPalPayoutConfig(
        address relayer,
        uint256 maxPerTransaction,
        uint256 dailyLimit
    ) external onlyOwner {
        bool disabled = relayer == address(0) &&
            maxPerTransaction == 0 &&
            dailyLimit == 0;
        require(
            disabled ||
                (relayer != address(0) &&
                    maxPerTransaction > 0 &&
                    dailyLimit >= maxPerTransaction),
            "invalid payout config"
        );

        payPalRelayer = relayer;
        maxPayPalPayoutPerTransaction = maxPerTransaction;
        dailyPayPalPayoutLimit = dailyLimit;
        emit PayPalPayoutConfigUpdated(relayer, maxPerTransaction, dailyLimit);
    }

    function setLiquidityConfig(address positionManager, address pairToken) external onlyOwner {
        require(positionManager != address(0) && positionManager.code.length > 0, "invalid position manager");
        require(pairToken != address(0) && pairToken.code.length > 0, "invalid pair token");
        require(address(token) != pairToken, "pair token is SRP");

        liquidityPositionManager = positionManager;
        liquidityPairToken = pairToken;
        emit LiquidityConfigUpdated(positionManager, pairToken);
    }

    // =========================================================
    // SUBSIDY FLOW (INTERNAL SYSTEM)
    // =========================================================
    function useForLP(uint256 amount) external returns (uint256) {
        require(msg.sender == subsidizer, "not allowed");
        token.transfer(msg.sender, amount);
        return amount;
    }

    // =========================================================
    // LP WITHDRAW TOKEN (SRP)
    // =========================================================
    function releaseForLP(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero address");
        token.transfer(to, amount);
    }

    function releaseForInvestorSale(address to, uint256 amount) external {
        require(msg.sender == investorSale, "not investor sale");
        require(to != address(0), "zero address");
        require(token.transfer(to, amount), "token transfer failed");
    }

    function releaseForPayPal(bytes32 paymentId, address to, uint256 amount) external {
        require(msg.sender == payPalRelayer && payPalRelayer != address(0), "not PayPal relayer");
        require(paymentId != bytes32(0), "zero payment id");
        require(!processedPayPalPayments[paymentId], "payment already processed");
        require(to != address(0), "zero address");
        require(amount > 0, "zero amount");
        require(amount <= maxPayPalPayoutPerTransaction, "exceeds transaction limit");

        uint256 currentDay = block.timestamp / 1 days;
        if (dailyPayPalPayoutDay != currentDay) {
            dailyPayPalPayoutDay = currentDay;
            dailyPayPalPayoutUsed = 0;
        }
        require(
            dailyPayPalPayoutUsed + amount <= dailyPayPalPayoutLimit,
            "exceeds daily limit"
        );
        dailyPayPalPayoutUsed += amount;
        processedPayPalPayments[paymentId] = true;

        require(token.transfer(to, amount), "token transfer failed");
        emit PayPalPayoutReleased(paymentId, to, amount, currentDay);
    }

    function addLiquidityForRelayer(
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 amountSRPDesired,
        uint256 amountPairDesired,
        uint256 amountSRPMin,
        uint256 amountPairMin,
        uint256 deadline
    )
        external
        nonReentrant
        returns (uint256 tokenId, uint128 liquidity, uint256 amountSRP, uint256 amountPair)
    {
        require(msg.sender == payPalRelayer && payPalRelayer != address(0), "not PayPal relayer");
        require(liquidityPositionManager != address(0) && liquidityPairToken != address(0), "liquidity not configured");
        require(fee == 100 || fee == 500 || fee == 3000 || fee == 10000, "invalid fee");
        require(tickLower < tickUpper, "invalid tick range");
        require(amountSRPDesired > 0 && amountPairDesired > 0, "zero desired amount");
        require(amountSRPMin <= amountSRPDesired && amountPairMin <= amountPairDesired, "minimum exceeds desired");
        require(deadline >= block.timestamp, "deadline expired");
        token.safeTransferFrom(msg.sender, address(this), amountSRPDesired);
        IERC20 pairToken = IERC20(liquidityPairToken);
        pairToken.safeTransferFrom(owner(), address(this), amountPairDesired);

        bool srpIsToken0 = address(token) < liquidityPairToken;
        address token0 = srpIsToken0 ? address(token) : liquidityPairToken;
        address token1 = srpIsToken0 ? liquidityPairToken : address(token);
        uint256 amount0Desired = srpIsToken0 ? amountSRPDesired : amountPairDesired;
        uint256 amount1Desired = srpIsToken0 ? amountPairDesired : amountSRPDesired;
        uint256 amount0Min = srpIsToken0 ? amountSRPMin : amountPairMin;
        uint256 amount1Min = srpIsToken0 ? amountPairMin : amountSRPMin;

        token.safeApprove(liquidityPositionManager, 0);
        pairToken.safeApprove(liquidityPositionManager, 0);
        token.safeApprove(liquidityPositionManager, amountSRPDesired);
        pairToken.safeApprove(liquidityPositionManager, amountPairDesired);

        uint256 amount0;
        uint256 amount1;
        (tokenId, liquidity, amount0, amount1) = ISurpSwapV3PositionManager(
            liquidityPositionManager
        ).mint(
            ISurpSwapV3PositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: owner(),
                deadline: deadline
            })
        );

        token.safeApprove(liquidityPositionManager, 0);
        pairToken.safeApprove(liquidityPositionManager, 0);
        amountSRP = srpIsToken0 ? amount0 : amount1;
        amountPair = srpIsToken0 ? amount1 : amount0;
        uint256 unusedSRP = amountSRPDesired - amountSRP;
        uint256 unusedPair = amountPairDesired - amountPair;
        if (unusedSRP > 0) token.safeTransfer(msg.sender, unusedSRP);
        if (unusedPair > 0) pairToken.safeTransfer(owner(), unusedPair);

        emit LiquidityAddedByRelayer(msg.sender, tokenId, liquidity, amountSRP, amountPair);
    }

    // =========================================================
    // WITHDRAW WETH
    // =========================================================
    function releaseWETH(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero address");
        weth.transfer(to, amount);
    }

    // =========================================================
    // WITHDRAW NATIVE POL / ETH
    // =========================================================
    function releaseETH(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero address");
        weth.withdraw(amount);
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    // =========================================================
    // OPTIONAL: DIRECT FUNDING
    // =========================================================
    function pullFromSubsidizer(address from, uint256 amount) external onlyOwner {
        require(from == subsidizer, "not subsidizer");
        token.transferFrom(from, address(this), amount);
    }

    receive() external payable {}
}