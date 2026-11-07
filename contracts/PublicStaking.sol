// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./libraries/SurpSwapV3Twap.sol";

interface IP2ERewardManager {
    function payout(address user, uint256 amount) external;
}

contract PublicStaking is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BASE_APR_BPS = 20_000;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant LOCK_DURATION = 90 days;
    uint32 public constant MAX_APR_BPS = 100_000;

    IERC20 public immutable token;
    IP2ERewardManager public immutable p2eManager;
    address public immutable pricePool;
    address public immutable quoteToken;
    uint32 public immutable twapInterval;

    uint256 public committedRewards;
    uint256 public referencePriceX18;
    uint256 public referenceStakerCount;
    uint32 public minAprBps;
    uint32 public maxAprBps;
    uint32 public currentAprBps;
    uint256 public activeStakerCount;
    uint256 public cumulativeAprSeconds;
    uint64 public lastRateUpdateAt;
    bool public aprConfigured;

    struct Stake {
        uint256 amount;
        uint256 reservedReward;
        uint64 stakedAt;
        bool principalWithdrawn;
        bool rewardClaimed;
    }

    struct AprCheckpoint {
        uint64 timestamp;
        uint32 aprBps;
        uint256 cumulativeAprSeconds;
    }

    mapping(address => Stake) public stakes;
    AprCheckpoint[] private aprCheckpoints;

    event AprParametersUpdated(
        uint256 referencePriceX18,
        uint256 referenceStakerCount,
        uint32 minAprBps,
        uint32 maxAprBps
    );
    event AprCheckpointed(uint32 aprBps, uint256 priceX18, uint256 activeWallets);
    event Staked(address indexed account, uint256 amount, uint256 reservedReward, uint64 unlockAt);
    event PrincipalWithdrawn(address indexed account, uint256 amount);
    event RewardClaimed(address indexed account, uint256 amount);

    constructor(
        address token_,
        address p2eManager_,
        address pricePool_,
        address quoteToken_,
        uint32 twapInterval_,
        address admin_
    ) {
        require(token_ != address(0) && token_.code.length > 0, "Invalid token");
        require(p2eManager_ != address(0) && p2eManager_.code.length > 0, "Invalid P2E manager");
        require(pricePool_ != address(0) && pricePool_.code.length > 0, "Invalid price pool");
        require(quoteToken_ != address(0) && quoteToken_.code.length > 0, "Invalid quote token");
        require(token_ != quoteToken_, "Price tokens must differ");
        require(twapInterval_ > 0, "TWAP interval zero");
        require(admin_ != address(0), "Invalid admin");
        require(IERC20Metadata(token_).decimals() == 18, "Stake token must use 18 decimals");
        require(IERC20Metadata(quoteToken_).decimals() == 18, "Quote token must use 18 decimals");

        token = IERC20(token_);
        p2eManager = IP2ERewardManager(p2eManager_);
        pricePool = pricePool_;
        quoteToken = quoteToken_;
        twapInterval = twapInterval_;
        lastRateUpdateAt = uint64(block.timestamp);
        aprCheckpoints.push(
            AprCheckpoint({
                timestamp: uint64(block.timestamp),
                aprBps: 0,
                cumulativeAprSeconds: 0
            })
        );
        _transferOwnership(admin_);
    }

    function setAprParameters(
        uint256 referencePriceX18_,
        uint256 referenceStakerCount_,
        uint32 minAprBps_,
        uint32 maxAprBps_
    ) external onlyOwner {
        require(activeStakerCount == 0, "Cannot change parameters with active stakes");
        require(referencePriceX18_ > 0, "Reference price zero");
        require(referenceStakerCount_ > 0, "Reference wallet count zero");
        require(minAprBps_ <= maxAprBps_, "Invalid APR range");
        require(maxAprBps_ <= MAX_APR_BPS, "Maximum APR too high");
        require(
            SurpSwapV3Twap.priceX18(pricePool, address(token), quoteToken, twapInterval) > 0,
            "Invalid TWAP price"
        );

        _accrueCurrentRate();
        referencePriceX18 = referencePriceX18_;
        referenceStakerCount = referenceStakerCount_;
        minAprBps = minAprBps_;
        maxAprBps = maxAprBps_;
        aprConfigured = true;
        _setCurrentApr(_calculateApr());
        emit AprParametersUpdated(
            referencePriceX18_,
            referenceStakerCount_,
            minAprBps_,
            maxAprBps_
        );
    }

    function currentPriceX18() external view returns (uint256) {
        return SurpSwapV3Twap.priceX18(pricePool, address(token), quoteToken, twapInterval);
    }

    function checkpointApr() external whenNotPaused {
        require(aprConfigured, "APR parameters not configured");
        _accrueCurrentRate();
        _setCurrentApr(_calculateApr());
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function stake(uint256 amount) external nonReentrant whenNotPaused {
        require(aprConfigured, "APR parameters not configured");
        require(amount > 0, "Stake amount zero");
        Stake storage position = stakes[msg.sender];
        require(
            position.amount == 0 || (position.principalWithdrawn && position.rewardClaimed),
            "Existing stake not settled"
        );

        _accrueCurrentRate();
        uint256 reservedReward = Math.mulDiv(
            amount,
            uint256(maxAprBps) * LOCK_DURATION,
            BPS_DENOMINATOR * SECONDS_PER_YEAR
        );
        require(reservedReward > 0, "Stake too small for reward");
        require(
            committedRewards + reservedReward <= token.balanceOf(address(p2eManager)),
            "Insufficient P2E balance for reward commitments"
        );

        if (position.amount != 0) delete stakes[msg.sender];
        position.amount = amount;
        position.reservedReward = reservedReward;
        position.stakedAt = uint64(block.timestamp);
        committedRewards += reservedReward;
        token.safeTransferFrom(msg.sender, address(this), amount);
        activeStakerCount++;
        _setCurrentApr(_calculateApr());

        emit Staked(
            msg.sender,
            amount,
            reservedReward,
            uint64(block.timestamp + LOCK_DURATION)
        );
    }

    function earnedReward(address account) public view returns (uint256) {
        Stake storage position = stakes[account];
        if (position.amount == 0 || position.rewardClaimed) return 0;

        uint256 unlockAt = uint256(position.stakedAt) + LOCK_DURATION;
        uint256 endAt = block.timestamp < unlockAt ? block.timestamp : unlockAt;
        if (endAt <= position.stakedAt) return 0;
        uint256 accruedAprSeconds = _cumulativeAprAt(endAt) -
            _cumulativeAprAt(position.stakedAt);
        uint256 reward = Math.mulDiv(
            position.amount,
            accruedAprSeconds,
            BPS_DENOMINATOR * SECONDS_PER_YEAR
        );
        return reward < position.reservedReward ? reward : position.reservedReward;
    }

    function withdrawPrincipal() external nonReentrant {
        Stake storage position = stakes[msg.sender];
        require(position.amount > 0, "No active stake");
        require(block.timestamp >= uint256(position.stakedAt) + LOCK_DURATION, "Stake is locked");
        require(!position.principalWithdrawn, "Principal already withdrawn");

        _accrueCurrentRate();
        position.principalWithdrawn = true;
        uint256 amount = position.amount;
        token.safeTransfer(msg.sender, amount);
        activeStakerCount--;
        _setCurrentApr(_calculateApr());
        _clearSettledStake(msg.sender, position);
        emit PrincipalWithdrawn(msg.sender, amount);
    }

    function claimReward() external nonReentrant {
        Stake storage position = stakes[msg.sender];
        require(position.amount > 0, "No active stake");
        require(block.timestamp >= uint256(position.stakedAt) + LOCK_DURATION, "Stake is locked");
        require(!position.rewardClaimed, "Reward already claimed");

        _accrueCurrentRate();
        uint256 reward = earnedReward(msg.sender);
        position.rewardClaimed = true;
        committedRewards -= position.reservedReward;
        p2eManager.payout(msg.sender, reward);
        _clearSettledStake(msg.sender, position);
        emit RewardClaimed(msg.sender, reward);
    }

    function aprCheckpointCount() external view returns (uint256) {
        return aprCheckpoints.length;
    }

    function availableRewardBalance() external view returns (uint256) {
        uint256 p2eBalance = token.balanceOf(address(p2eManager));
        return p2eBalance > committedRewards ? p2eBalance - committedRewards : 0;
    }

    function _calculateApr() private view returns (uint32) {
        if (activeStakerCount == 0) return 0;
        uint256 priceX18 = SurpSwapV3Twap.priceX18(
            pricePool,
            address(token),
            quoteToken,
            twapInterval
        );
        uint256 apr = Math.mulDiv(BASE_APR_BPS, priceX18, referencePriceX18);
        apr = Math.mulDiv(apr, referenceStakerCount, activeStakerCount);
        if (apr < minAprBps) apr = minAprBps;
        if (apr > maxAprBps) apr = maxAprBps;
        return uint32(apr);
    }

    function _accrueCurrentRate() private {
        uint64 now_ = uint64(block.timestamp);
        uint256 elapsed = now_ - lastRateUpdateAt;
        if (elapsed > 0) {
            cumulativeAprSeconds += uint256(currentAprBps) * elapsed;
            lastRateUpdateAt = now_;
        }
        _storeAprCheckpoint(now_);
    }

    function _setCurrentApr(uint32 newAprBps) private {
        currentAprBps = newAprBps;
        lastRateUpdateAt = uint64(block.timestamp);
        _storeAprCheckpoint(uint64(block.timestamp));
        uint256 priceX18 = activeStakerCount == 0
            ? 0
            : SurpSwapV3Twap.priceX18(pricePool, address(token), quoteToken, twapInterval);
        emit AprCheckpointed(newAprBps, priceX18, activeStakerCount);
    }

    function _storeAprCheckpoint(uint64 timestamp) private {
        uint256 length = aprCheckpoints.length;
        AprCheckpoint memory checkpoint = AprCheckpoint({
            timestamp: timestamp,
            aprBps: currentAprBps,
            cumulativeAprSeconds: cumulativeAprSeconds
        });
        if (aprCheckpoints[length - 1].timestamp == timestamp) {
            aprCheckpoints[length - 1] = checkpoint;
        } else {
            aprCheckpoints.push(checkpoint);
        }
    }

    function _cumulativeAprAt(uint256 timestamp) private view returns (uint256) {
        uint256 low;
        uint256 high = aprCheckpoints.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (aprCheckpoints[mid].timestamp <= timestamp) low = mid + 1;
            else high = mid;
        }
        require(low > 0, "APR checkpoint missing");

        AprCheckpoint storage checkpoint = aprCheckpoints[low - 1];
        return
            checkpoint.cumulativeAprSeconds +
            uint256(checkpoint.aprBps) * (timestamp - checkpoint.timestamp);
    }

    function _clearSettledStake(address account, Stake storage position) private {
        if (position.principalWithdrawn && position.rewardClaimed) delete stakes[account];
    }
}
