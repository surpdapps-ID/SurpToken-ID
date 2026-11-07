// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract P2EManager is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public token;
    mapping(address => bool) public isMiningPool;
    address public payPalRelayer;
    uint256 public maxPayPalPayoutPerTransaction;
    uint256 public dailyPayPalPayoutLimit;
    uint256 public dailyPayPalPayoutDay;
    uint256 public dailyPayPalPayoutUsed;
    mapping(bytes32 => bool) public processedPayPalPayments;

    event PayoutExecuted(address indexed user, uint256 amount);
    event EmergencyWithdrawn(address indexed owner, address indexed to, uint256 amount);
    event MiningPoolStatusUpdated(address indexed pool, bool status);
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

    constructor(address _token) {
        token = IERC20(_token);
    }

    function setMiningPoolStatus(address _pool, bool _status) external onlyOwner {
        isMiningPool[_pool] = _status;
        emit MiningPoolStatusUpdated(_pool, _status);
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

    function fund(uint256 amount) external onlyOwner {
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    function payout(address user, uint256 amount) external {
        require(isMiningPool[msg.sender], "Bukan pool resmi");
        require(token.balanceOf(address(this)) >= amount, "Dana vault P2E habis");

        token.safeTransfer(user, amount);
        emit PayoutExecuted(user, amount);
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
        require(token.balanceOf(address(this)) >= amount, "Dana vault P2E habis");

        dailyPayPalPayoutUsed += amount;
        processedPayPalPayments[paymentId] = true;
        token.safeTransfer(to, amount);
        emit PayPalPayoutReleased(paymentId, to, amount, currentDay);
    }

    function emergencyWithdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid address");
        require(token.balanceOf(address(this)) >= amount, "Exceeds balance");
        
        token.safeTransfer(to, amount);
        emit EmergencyWithdrawn(msg.sender, to, amount);
    }
}