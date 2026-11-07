// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

interface IInvestorEligibility {
    function hasInvested(address investor) external view returns (bool);
}

interface IP2EDividendManager {
    function payout(address user, uint256 amount) external;
}

contract InvestorDividend is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant MONTHLY_REWARD_BPS = 125;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MONTH_DURATION = 30 days;
    uint256 public constant REWARD_MONTHS = 12;
    uint256 public constant LOCK_DURATION = 365 days;

    IERC20 public immutable token;
    IP2EDividendManager public immutable p2eManager;
    IInvestorEligibility public immutable investorSale;
    uint256 public outstandingRewardLiability;

    struct Position {
        uint256 principal;
        uint64 startedAt;
        uint8 monthsClaimed;
        bool principalWithdrawn;
    }

    mapping(address => Position) public positions;

    event DividendStaked(address indexed investor, uint256 principal, uint64 unlockAt);
    event MonthlyRewardClaimed(
        address indexed investor,
        uint8 monthsPaid,
        uint256 amount
    );
    event PrincipalWithdrawn(address indexed investor, uint256 amount);

    constructor(address token_, address p2eManager_, address investorSale_, address admin_) {
        require(token_ != address(0) && token_.code.length > 0, "Invalid token");
        require(p2eManager_ != address(0) && p2eManager_.code.length > 0, "Invalid P2E manager");
        require(investorSale_ != address(0) && investorSale_.code.length > 0, "Invalid investor sale");
        require(admin_ != address(0), "Invalid admin");
        token = IERC20(token_);
        p2eManager = IP2EDividendManager(p2eManager_);
        investorSale = IInvestorEligibility(investorSale_);
        _transferOwnership(admin_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function stakeDividend(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Stake amount zero");
        require(investorSale.hasInvested(msg.sender), "InvestorSale participant only");
        Position storage position = positions[msg.sender];
        require(
            position.principal == 0 ||
                (position.principalWithdrawn && position.monthsClaimed == REWARD_MONTHS),
            "Existing dividend stake not settled"
        );

        uint256 monthlyReward = Math.mulDiv(amount, MONTHLY_REWARD_BPS, BPS_DENOMINATOR);
        require(monthlyReward > 0, "Stake too small for monthly reward");
        uint256 totalReward = monthlyReward * REWARD_MONTHS;
        require(
            token.balanceOf(address(p2eManager)) >= outstandingRewardLiability + totalReward,
            "P2E balance below dividend commitments"
        );

        if (position.principal != 0) delete positions[msg.sender];
        position.principal = amount;
        position.startedAt = uint64(block.timestamp);
        position.monthsClaimed = 0;
        position.principalWithdrawn = false;
        outstandingRewardLiability += totalReward;
        token.safeTransferFrom(msg.sender, address(this), amount);

        emit DividendStaked(msg.sender, amount, uint64(block.timestamp + LOCK_DURATION));
    }

    function claimMonthlyReward() external nonReentrant {
        Position storage position = positions[msg.sender];
        require(position.principal > 0, "No active dividend stake");

        uint256 elapsedMonths = (block.timestamp - position.startedAt) / MONTH_DURATION;
        if (elapsedMonths > REWARD_MONTHS) elapsedMonths = REWARD_MONTHS;
        require(elapsedMonths > position.monthsClaimed, "Monthly reward not due");

        uint8 monthsPaid = uint8(elapsedMonths - position.monthsClaimed);
        uint256 monthlyReward = Math.mulDiv(
            position.principal,
            MONTHLY_REWARD_BPS,
            BPS_DENOMINATOR
        );
        uint256 reward = monthlyReward * monthsPaid;
        position.monthsClaimed = uint8(elapsedMonths);
        outstandingRewardLiability -= reward;
        p2eManager.payout(msg.sender, reward);

        emit MonthlyRewardClaimed(msg.sender, monthsPaid, reward);
    }

    function withdrawPrincipal() external nonReentrant {
        Position storage position = positions[msg.sender];
        require(position.principal > 0, "No active dividend stake");
        require(
            block.timestamp >= uint256(position.startedAt) + LOCK_DURATION,
            "Dividend stake is locked"
        );
        require(!position.principalWithdrawn, "Principal already withdrawn");

        position.principalWithdrawn = true;
        uint256 amount = position.principal;
        token.safeTransfer(msg.sender, amount);
        emit PrincipalWithdrawn(msg.sender, amount);
    }
}
