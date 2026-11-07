// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/SurpSwapV3Interfaces.sol";
import "./libraries/SurpSwapV3Twap.sol";

interface IInvestorNFT {
    function customPaymentToken() external view returns (address);
    function investorContract() external view returns (address);
    function isInvestorMintActive() external view returns (bool);
    function remainingVoucherSupply() external view returns (uint256);
    function symbol() external view returns (string memory);
    function mintWithVoucher(
        address payer,
        address recipient,
        uint16 discountBps
    ) external returns (uint256 tokenId);
}

interface IInvestorSaleLPManager {
    function token() external view returns (address);
    function releaseForInvestorSale(address to, uint256 amount) external;
}

contract InvestorSale is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_INVESTORS_PER_LEVEL = 5000;
    uint16 public constant DISCOUNT_99_BPS = 9900;
    uint16 public constant DISCOUNT_50_BPS = 5000;
    uint32 public constant MIN_TWAP_INTERVAL = 1800;

    IERC20 public immutable investmentToken;
    address public immutable wrappedNativeToken;
    uint256[5] public investmentAmounts;
    uint256 public investorCount;
    mapping(uint8 => uint256) public investorCountByLevel;
    address public lpManager;
    address public salesTreasury;

    address[6] public nftContracts;
    mapping(address => bool) public hasInvested;
    mapping(address => uint8) public investmentLevel;
    mapping(address => mapping(uint8 => mapping(uint16 => uint8))) public voucherBalance;
    mapping(uint8 => uint256) public reservedVoucherCount;

    uint256 public manualPriceX18;
    address public dexPool;
    uint32 public twapInterval;
    bool public dexPricingEnabled;
    bool public saleActive;

    event ManualPriceUpdated(uint256 priceX18);
    event InvestmentAmountsUpdated(
        uint256 level1,
        uint256 level2,
        uint256 level3,
        uint256 level4,
        uint256 level5
    );
    event LPManagerConfigured(address indexed lpManager);
    event SalesTreasuryUpdated(address indexed treasury);
    event DEXPricingEnabled(address indexed pool, uint32 twapInterval);
    event DEXPoolUpdated(address indexed pool, uint32 twapInterval);
    event NFTContractsConfigured();
    event SaleStatusUpdated(bool active);
    event InvestmentReceived(
        address indexed investor,
        uint8 indexed level,
        uint256 nativeAmount,
        uint256 tokenAmount,
        uint256 tokenPriceX18
    );
    event VoucherIssued(address indexed investor, uint8 indexed nftTier, uint16 discountBps);
    event VoucherRedeemed(
        address indexed investor,
        uint8 indexed nftTier,
        uint16 discountBps,
        uint256 tokenId
    );

    constructor(
        address token_,
        address wrappedNativeToken_,
        address admin_,
        uint256[5] memory investmentAmounts_
    ) {
        require(token_ != address(0) && token_.code.length > 0, "Invalid investment token");
        require(
            wrappedNativeToken_ != address(0) && wrappedNativeToken_.code.length > 0,
            "Invalid wrapped native token"
        );
        require(admin_ != address(0), "Invalid admin");
        for (uint8 i = 0; i < investmentAmounts_.length; i++) {
            require(investmentAmounts_[i] > 0, "Investment amount zero");
            investmentAmounts[i] = investmentAmounts_[i];
        }
        investmentToken = IERC20(token_);
        wrappedNativeToken = wrappedNativeToken_;
        _transferOwnership(admin_);
    }

    function setNFTContracts(address[6] calldata contracts_) external onlyOwner {
        require(nftContracts[0] == address(0), "NFT contracts already configured");
        for (uint8 i = 0; i < contracts_.length; i++) {
            address nft = contracts_[i];
            require(nft != address(0) && nft.code.length > 0, "Invalid NFT contract");
            for (uint8 j = 0; j < i; j++) {
                require(contracts_[j] != nft, "Duplicate NFT contract");
            }
            IInvestorNFT nftContract = IInvestorNFT(nft);
            require(
                nftContract.customPaymentToken() == address(investmentToken),
                "NFT payment token mismatch"
            );
            require(nftContract.investorContract() == address(this), "NFT investor contract mismatch");
            require(nftContract.isInvestorMintActive(), "Voucher mint is paused");
            require(
                nftContract.remainingVoucherSupply() >= reservedVoucherCount[i],
                "Reserved vouchers exceed NFT supply"
            );
            require(
                keccak256(bytes(nftContract.symbol())) == _expectedSymbol(i),
                "NFT tier order mismatch"
            );
            nftContracts[i] = nft;
        }
        emit NFTContractsConfigured();
    }

    function setLPManager(address lpManager_) external onlyOwner {
        require(!saleActive, "Pause sale before changing LP manager");
        require(lpManager_.code.length > 0, "Invalid LP manager");
        require(
            IInvestorSaleLPManager(lpManager_).token() == address(investmentToken),
            "LP manager token mismatch"
        );
        lpManager = lpManager_;
        emit LPManagerConfigured(lpManager_);
    }

    function setSalesTreasury(address treasury) external onlyOwner {
        salesTreasury = treasury;
        emit SalesTreasuryUpdated(treasury);
    }

    function _salesRecipient() internal view returns (address) {
        return salesTreasury == address(0) ? owner() : salesTreasury;
    }

    function setManualPrice(uint256 priceX18) external onlyOwner {
        require(!saleActive, "Pause sale before changing price");
        require(!dexPricingEnabled, "DEX pricing is locked");
        require(priceX18 > 0, "Price zero");
        manualPriceX18 = priceX18;
        emit ManualPriceUpdated(priceX18);
    }

    function setInvestmentAmounts(uint256[5] calldata amounts_) external onlyOwner {
        require(!saleActive, "Pause sale before changing investment amounts");
        for (uint8 i = 0; i < amounts_.length; i++) {
            require(amounts_[i] > 0, "Investment amount zero");
            investmentAmounts[i] = amounts_[i];
        }
        emit InvestmentAmountsUpdated(
            amounts_[0],
            amounts_[1],
            amounts_[2],
            amounts_[3],
            amounts_[4]
        );
    }

    function enableDEXPricing(address pool, uint32 interval) external onlyOwner {
        require(!saleActive, "Pause sale before DEX activation");
        require(!dexPricingEnabled, "DEX pricing already enabled");
        _setDEXPool(pool, interval);
        dexPricingEnabled = true;
        emit DEXPricingEnabled(pool, interval);
    }

    function updateDEXPool(address pool, uint32 interval) external onlyOwner {
        require(dexPricingEnabled, "DEX pricing not enabled");
        require(!saleActive, "Pause sale before changing DEX pool");
        _setDEXPool(pool, interval);
        emit DEXPoolUpdated(pool, interval);
    }

    function _setDEXPool(address pool, uint32 interval) private {
        require(interval >= MIN_TWAP_INTERVAL, "TWAP interval too short");
        require(pool.code.length > 0, "Invalid DEX pool");
        ISurpSwapV3Pool targetPool = ISurpSwapV3Pool(pool);
        address token0 = targetPool.token0();
        address token1 = targetPool.token1();
        require(
            (token0 == address(investmentToken) && token1 == wrappedNativeToken) ||
                (token1 == address(investmentToken) && token0 == wrappedNativeToken),
            "DEX pool pair mismatch"
        );

        dexPool = pool;
        twapInterval = interval;
    }

    function setSaleActive(bool active) external onlyOwner {
        if (active) {
            require(dexPricingEnabled || manualPriceX18 > 0, "Token price not configured");
            if (dexPricingEnabled) {
                require(_currentPriceX18() > 0, "Invalid DEX price");
            }
        }
        saleActive = active;
        emit SaleStatusUpdated(active);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function fundInventory(uint256 amount) external {
        require(amount > 0, "Funding amount zero");
        investmentToken.safeTransferFrom(msg.sender, address(this), amount);
    }

    function invest(
        uint8 level,
        uint256 minTokenAmount
    ) external payable nonReentrant whenNotPaused {
        require(saleActive, "Sale inactive");
        require(!hasInvested[msg.sender], "Wallet already invested");
        require(level >= 1 && level <= 5, "Invalid investment level");
        require(investorCountByLevel[level] < MAX_INVESTORS_PER_LEVEL, "Investment level is full");
        require(msg.value == investmentAmount(level), "Incorrect investment amount");

        (uint8 tierA, uint16 discountA, uint8 tierB, uint16 discountB) = _rewardsForLevel(level);
        _requireVoucherCapacity(tierA);
        _requireVoucherCapacity(tierB);

        uint256 priceX18 = _currentPriceX18();
        uint256 tokenAmount = Math.mulDiv(msg.value / 2, 1e18, priceX18);
        require(tokenAmount > 0, "Token allocation rounds to zero");
        require(tokenAmount >= minTokenAmount, "Token amount below minimum");
        uint256 currentReserve = investmentToken.balanceOf(address(this));
        if (currentReserve < tokenAmount && lpManager != address(0)) {
            IInvestorSaleLPManager(lpManager).releaseForInvestorSale(
                address(this),
                tokenAmount - currentReserve
            );
        }
        require(investmentToken.balanceOf(address(this)) >= tokenAmount, "Insufficient token reserve");

        hasInvested[msg.sender] = true;
        investmentLevel[msg.sender] = level;
        investorCount++;
        investorCountByLevel[level]++;
        voucherBalance[msg.sender][tierA][discountA]++;
        voucherBalance[msg.sender][tierB][discountB]++;
        reservedVoucherCount[tierA]++;
        reservedVoucherCount[tierB]++;
        emit VoucherIssued(msg.sender, tierA, discountA);
        emit VoucherIssued(msg.sender, tierB, discountB);

        investmentToken.safeTransfer(msg.sender, tokenAmount);
        (bool sent, ) = payable(_salesRecipient()).call{value: msg.value}("");
        require(sent, "Treasury transfer failed");

        emit InvestmentReceived(msg.sender, level, msg.value, tokenAmount, priceX18);
    }

    function redeemVoucher(uint8 nftTier, uint16 discountBps) external nonReentrant whenNotPaused {
        require(nftTier < nftContracts.length, "Invalid NFT tier");
        require(nftContracts[nftTier] != address(0), "NFT contracts not configured");
        require(
            discountBps == DISCOUNT_99_BPS || discountBps == DISCOUNT_50_BPS,
            "Invalid discount"
        );
        require(voucherBalance[msg.sender][nftTier][discountBps] > 0, "Voucher unavailable");

        voucherBalance[msg.sender][nftTier][discountBps]--;
        reservedVoucherCount[nftTier]--;
        IInvestorNFT nftContract = IInvestorNFT(nftContracts[nftTier]);
        uint256 tokenId = nftContract.mintWithVoucher(msg.sender, msg.sender, discountBps);
        emit VoucherRedeemed(msg.sender, nftTier, discountBps, tokenId);
    }

    function investmentAmount(uint8 level) public view returns (uint256) {
        require(level >= 1 && level <= 5, "Invalid investment level");
        return investmentAmounts[level - 1];
    }

    function currentPriceX18() external view returns (uint256) {
        return _currentPriceX18();
    }

    function expectedTokenAmount(uint256 nativeAmount) external view returns (uint256) {
        return Math.mulDiv(nativeAmount / 2, 1e18, _currentPriceX18());
    }

    function _currentPriceX18() internal view returns (uint256) {
        if (!dexPricingEnabled) {
            require(manualPriceX18 > 0, "Manual price not configured");
            return manualPriceX18;
        }
        return SurpSwapV3Twap.priceX18(
            dexPool,
            address(investmentToken),
            wrappedNativeToken,
            twapInterval
        );
    }

    function _requireVoucherCapacity(uint8 tier) private view {
        address nftAddress = nftContracts[tier];
        if (nftAddress == address(0)) {
            require(
                reservedVoucherCount[tier] < _maxInvestorSupply(tier),
                "NFT voucher supply exhausted"
            );
            return;
        }

        IInvestorNFT nftContract = IInvestorNFT(nftAddress);
        require(nftContract.isInvestorMintActive(), "Voucher mint is paused");
        require(nftContract.remainingVoucherSupply() > reservedVoucherCount[tier], "NFT voucher supply exhausted");
    }

    function _maxInvestorSupply(uint8 tier) private pure returns (uint256) {
        // Keep these caps aligned with the fixed investor supplies in the six NFT constructors.
        if (tier == 0) return 50000;
        if (tier == 1) return 40000;
        if (tier == 2) return 30000;
        if (tier == 3) return 20000;
        if (tier == 4) return 10000;
        return 5000;
    }

    function _expectedSymbol(uint8 tier) private pure returns (bytes32) {
        if (tier == 0) return keccak256(bytes("ZCN"));
        if (tier == 1) return keccak256(bytes("ZRE"));
        if (tier == 2) return keccak256(bytes("ZEC"));
        if (tier == 3) return keccak256(bytes("ZFH"));
        if (tier == 4) return keccak256(bytes("ZSY"));
        return keccak256(bytes("ZBV"));
    }

    function _rewardsForLevel(
        uint8 level
    ) private pure returns (uint8 tierA, uint16 discountA, uint8 tierB, uint16 discountB) {
        tierA = level - 1;
        tierB = level;
        discountA = DISCOUNT_99_BPS;
        discountB = DISCOUNT_50_BPS;
    }
}
