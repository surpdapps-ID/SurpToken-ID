// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/SurpSwapV3Interfaces.sol";
import "./libraries/SurpSwapV3Twap.sol";

interface IP2EManager {
    function payout(address user, uint256 amount) external;
}

abstract contract SRP_NFTBase is ERC721, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    struct NFTStats {
        uint8 level;
        uint256 xp;
        uint8 currentDurability;
        uint8 maxDurability;
        uint8 currentStamina;
        uint8 maxStamina;
        uint256 currentBank; 
        uint256 maxBank;     
        uint256 power;
        uint256 efficiency;
        uint256 timestamp;   
    }

    uint256 public immutable MAX_SUPPLY;
    uint8 public constant BASE_STAMINA = 10;
    uint8 public constant BASE_DURABILITY = 10;
    uint256 public immutable BASE_POWER_EFF;
    uint256 public immutable DEFAULT_MAX_BANK;
    uint256 public immutable MAX_INVESTOR_SUPPLY;
    uint256 public immutable MAX_PUBLIC_SUPPLY;

    mapping(uint256 => NFTStats) public stats;
    mapping(uint256 => uint256) public nftPrice;

    uint256 public seriesVault;
    address public shopContract;
    address public p2eManager;

    address public tokenPoolAddress;
    address public quoteToken;
    uint32 public twapInterval = 1800;
    uint256 public baseTokenPrice = 1e18;

    uint256 private _tokenIdCounter;
    string private _baseTokenURI;

    uint256 public miningCooldown;
    IERC20 public customPaymentToken;
    address public investorContract;
    uint256 public investorMinted;
    uint256 public publicMinted;
    uint256 public publicPrice;
    address public salesTreasury;

    bool public isInvestorMintActive = true;
    bool public isPublicMintActive = false;

    event SalesTreasuryUpdated(address indexed treasury);

    constructor(
        string memory name_,
        string memory symbol_,
        address paymentToken_,
        uint256 investorSupply_,
        uint256 publicSupply_,
        uint256 basePower_,
        uint256 miningCooldown_,
        uint256 defaultMaxBank_
    ) ERC721(name_, symbol_) {
        require(paymentToken_ != address(0) && paymentToken_.code.length > 0, "Invalid payment token");
        require(investorSupply_ > 0 && publicSupply_ > 0, "Invalid supply");
        require(defaultMaxBank_ > 0, "Bank zero");
        customPaymentToken = IERC20(paymentToken_);
        MAX_INVESTOR_SUPPLY = investorSupply_;
        MAX_PUBLIC_SUPPLY = publicSupply_;
        MAX_SUPPLY = investorSupply_ + publicSupply_;
        BASE_POWER_EFF = basePower_;
        DEFAULT_MAX_BANK = defaultMaxBank_;
        miningCooldown = miningCooldown_;
    }

    // =========================================================================
    // SETTER FUNCTIONS (Kunci Pengaturan Setelah Deploy)
    // =========================================================================
    
    function setPaymentToken(address _newToken) external onlyOwner {
        require(_tokenIdCounter == 0, "Mint already started");
        require(investorContract == address(0), "Investor contract already set");
        require(_newToken != address(0) && _newToken.code.length > 0, "Invalid payment token");
        customPaymentToken = IERC20(_newToken);
    }

    function setTokenPool(address _pool, address _quoteToken, uint32 _interval) external onlyOwner {
        require(_pool.code.length > 0, "Invalid pool");
        require(
            _quoteToken != address(0) &&
                _quoteToken != address(customPaymentToken) &&
                _quoteToken.code.length > 0,
            "Invalid quote token"
        );
        require(_interval >= 1800, "TWAP interval too short");
        ISurpSwapV3Pool pool = ISurpSwapV3Pool(_pool);
        address token0 = pool.token0();
        address token1 = pool.token1();
        require(
            (token0 == address(customPaymentToken) && token1 == _quoteToken) ||
                (token1 == address(customPaymentToken) && token0 == _quoteToken),
            "Pool pair mismatch"
        );
        tokenPoolAddress = _pool;
        quoteToken = _quoteToken;
        twapInterval = _interval;
    }

    function setBaseTokenPrice(uint256 _basePrice) external onlyOwner {
        require(_basePrice > 0, "Price zero");
        baseTokenPrice = _basePrice;
    }

    function setCooldown(uint256 _duration) external onlyOwner {
        require(_duration > 0, "Cooldown zero");
        miningCooldown = _duration;
    }

    function setBaseURI(string memory baseURI) external onlyOwner {
        _baseTokenURI = baseURI;
    }

    function setShopContract(address _shop) external onlyOwner {
        require(_shop != address(0) && _shop.code.length > 0, "Invalid shop");
        shopContract = _shop;
    }

    function setP2EConfig(address _manager) external onlyOwner {
        require(_manager != address(0) && _manager.code.length > 0, "Invalid P2E manager");
        p2eManager = _manager;
    }

    function setPublicPrice(uint256 _price) external onlyOwner {
        require(_price > 0, "Price zero");
        publicPrice = _price;
    }

    function setSalesTreasury(address treasury) external onlyOwner {
        salesTreasury = treasury;
        emit SalesTreasuryUpdated(treasury);
    }

    function _salesRecipient() internal view returns (address) {
        return salesTreasury == address(0) ? owner() : salesTreasury;
    }

    function setInvestorContract(address _investorContract) external onlyOwner {
        require(investorContract == address(0), "Investor contract already set");
        require(
            _investorContract != address(0) && _investorContract.code.length > 0,
            "Invalid investor contract"
        );
        investorContract = _investorContract;
    }

    function setMintPhases(bool _investorActive, bool _publicActive) external onlyOwner {
        isInvestorMintActive = _investorActive;
        isPublicMintActive = _publicActive;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // =========================================================================
    // CORE LOGIC GAME
    // =========================================================================

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_exists(tokenId), "NFT tidak ada");
        return _baseTokenURI; 
    }

    function getTokenPrice() public view returns (uint256) {
        if (tokenPoolAddress == address(0)) {
            return baseTokenPrice;
        }
        return SurpSwapV3Twap.priceX18(
            tokenPoolAddress,
            address(customPaymentToken),
            quoteToken,
            twapInterval
        );
    }

    function updateStatsFromShop(uint256 tokenId, uint8 stamina, uint8 durability, uint256 bank, uint256 xp) external {
        require(msg.sender == shopContract, "Bukan shop contract resmi");
        require(_exists(tokenId), "NFT tidak ada");
        
        if (stamina > 0) {
            uint256 staminaAfterUpgrade = uint256(stats[tokenId].currentStamina) + stamina;
            stats[tokenId].currentStamina = uint8(
                Math.min(staminaAfterUpgrade, stats[tokenId].maxStamina)
            );
        }
        if (durability > 0) {
            uint256 durabilityAfterUpgrade = uint256(stats[tokenId].currentDurability) + durability;
            stats[tokenId].currentDurability = uint8(
                Math.min(durabilityAfterUpgrade, stats[tokenId].maxDurability)
            );
        }
        if (bank > 0) {
            stats[tokenId].maxBank += bank; 
        }

        if (xp > 0) {
            _addXP(tokenId, xp);
        }

        uint256 maxStaminaLvl = BASE_STAMINA + (uint256(stats[tokenId].level) - 1) * 5;
        uint256 maxPowerLvl = BASE_POWER_EFF + (uint256(stats[tokenId].level) - 1) * 5;

        stats[tokenId].power = (maxPowerLvl * stats[tokenId].currentStamina) / maxStaminaLvl;
        stats[tokenId].efficiency = (maxPowerLvl * stats[tokenId].currentStamina) / maxStaminaLvl;
    }

    function mintNFT(address to) external onlyOwner nonReentrant {
        require(publicMinted < MAX_PUBLIC_SUPPLY, "Public supply exhausted");
        publicMinted++;
        _mintWithStats(to);
    }

    function publicMint(uint256 amount) external nonReentrant {
        require(isPublicMintActive, "Public Mint belum dibuka");
        require(amount > 0 && amount <= 5, "Maksimal 5 NFT per transaksi");
        require(publicMinted + amount <= MAX_PUBLIC_SUPPLY, "Public Supply habis!");
        require(publicPrice > 0, "Harga public mint belum diset");

        uint256 totalCost = publicPrice * amount;
        customPaymentToken.safeTransferFrom(msg.sender, _salesRecipient(), totalCost);
        for (uint256 i = 0; i < amount; i++) {
            publicMinted++;
            _mintWithStats(msg.sender);
        }
    }

    function mintWithVoucher(
        address payer,
        address recipient,
        uint16 discountBps
    ) external nonReentrant returns (uint256 tokenId) {
        require(msg.sender == investorContract && investorContract != address(0), "Not investor contract");
        require(isInvestorMintActive, "Voucher mint disabled");
        require(payer != address(0) && payer == recipient, "Invalid voucher recipient");
        require(discountBps == 9900 || discountBps == 5000, "Invalid voucher discount");
        require(investorMinted < MAX_INVESTOR_SUPPLY, "Investor supply exhausted");
        require(publicPrice > 0, "Harga public mint belum diset");

        investorMinted++;
        uint256 amountDue = Math.mulDiv(publicPrice, 10000 - discountBps, 10000);
        require(amountDue > 0, "Discounted price rounds to zero");
        customPaymentToken.safeTransferFrom(payer, _salesRecipient(), amountDue);
        tokenId = _mintWithStats(recipient);
    }

    function remainingVoucherSupply() external view returns (uint256) {
        return MAX_INVESTOR_SUPPLY - investorMinted;
    }

    function _mintWithStats(address recipient) internal returns (uint256 id) {
        require(recipient != address(0), "Invalid recipient");
        require(_tokenIdCounter < MAX_SUPPLY, "Total supply exhausted");
        id = ++_tokenIdCounter;
        _safeMint(recipient, id);
        stats[id] = NFTStats({
            level: 1,
            xp: 0,
            currentDurability: BASE_DURABILITY,
            maxDurability: BASE_DURABILITY,
            currentStamina: BASE_STAMINA,
            maxStamina: BASE_STAMINA,
            currentBank: 0,
            maxBank: DEFAULT_MAX_BANK,
            power: BASE_POWER_EFF,
            efficiency: BASE_POWER_EFF,
            timestamp: 0
        });
    }

    function startMining(uint256 id) external whenNotPaused {
        require(ownerOf(id) == msg.sender, "Bukan owner");
        require(stats[id].currentStamina > 0, "Stamina habis, wajib beli di shop");
        require(stats[id].currentDurability > 0, "Durability habis, wajib beli di shop");
        require(stats[id].timestamp == 0, "NFT sedang menambang");

        stats[id].timestamp = block.timestamp; 
        _addXP(id, 5);
    }

    function getLiveBank(uint256 id) public view returns (uint256) {
        if (stats[id].timestamp == 0) return 0;
        uint256 timePassed = block.timestamp - stats[id].timestamp;
        
        uint256 currentPowerEff = stats[id].power + stats[id].efficiency;
        uint256 basePowerEffTotal = BASE_POWER_EFF * 2; 
        
        uint256 effectiveTime = (timePassed * currentPowerEff) / basePowerEffTotal;
        if (effectiveTime >= miningCooldown) {
            return stats[id].maxBank;
        }
        
        return (stats[id].maxBank * effectiveTime) / miningCooldown;
    }

    function claim(uint256 id) external nonReentrant {
        require(ownerOf(id) == msg.sender, "Bukan owner");
        require(stats[id].timestamp > 0, "Klik Start Mining dulu");
        
        uint256 currentTampungan = getLiveBank(id);
        require(currentTampungan >= stats[id].maxBank, "Bank belum penuh");
        
        require(stats[id].currentStamina >= 1, "Stamina habis, wajib beli di shop");
        require(stats[id].currentDurability >= 1, "Durability habis, wajib beli di shop");
        require(p2eManager != address(0), "P2EManager belum diset");

        stats[id].currentStamina -= 1;
        stats[id].currentDurability -= 1;

        uint256 maxStaminaLvl = BASE_STAMINA + (uint256(stats[id].level) - 1) * 5;
        uint256 maxPowerLvl = BASE_POWER_EFF + (uint256(stats[id].level) - 1) * 5;

        stats[id].power = (maxPowerLvl * stats[id].currentStamina) / maxStaminaLvl;
        stats[id].efficiency = (maxPowerLvl * stats[id].currentStamina) / maxStaminaLvl;

        stats[id].timestamp = 0; 
        _addXP(id, 5);

        IP2EManager(p2eManager).payout(msg.sender, currentTampungan);
    }

    function _addXP(uint256 id, uint256 amount) internal {
        stats[id].xp += amount;
        while (stats[id].level < 10 && stats[id].xp >= uint256(stats[id].level) * 10000) {
            stats[id].level += 1;

            uint256 maxStaminaBaru = BASE_STAMINA + (uint256(stats[id].level) - 1) * 5;
            uint256 maxStatusBaru = BASE_POWER_EFF + (uint256(stats[id].level) - 1) * 5;

            stats[id].maxStamina = uint8(maxStaminaBaru);
            stats[id].currentDurability = stats[id].maxDurability; 
            stats[id].power = maxStatusBaru;
            stats[id].efficiency = maxStatusBaru;
        }
    }

    function listNFTForSale(uint256 tokenId, uint256 price) external {
        require(ownerOf(tokenId) == msg.sender, "Bukan owner");
        require(price > 0, "Harga must be > 0");
        nftPrice[tokenId] = price;
    }

    function cancelNFTListing(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "Bukan owner");
        require(nftPrice[tokenId] > 0, "NFT tidak sedang dijual");
        delete nftPrice[tokenId];
    }

    function tradeNFT(uint256 tokenId) external payable nonReentrant {
        uint256 price = nftPrice[tokenId];
        require(price > 0, "NFT tidak sedang dijual");
        require(msg.value >= price, "Dana kurang");
        address seller = ownerOf(tokenId);
        require(seller != msg.sender, "Tidak bisa membeli milik sendiri");
        nftPrice[tokenId] = 0;
        if (salesTreasury == address(0)) {
            uint256 royalty = (price * 5) / 100;
            seriesVault += royalty;
            (bool sellerPaid, ) = payable(seller).call{value: price - royalty}("");
            require(sellerPaid, "Pembayaran seller gagal");
        } else {
            (bool treasuryPaid, ) = payable(salesTreasury).call{value: price}("");
            require(treasuryPaid, "Pembayaran treasury gagal");
        }
        _transfer(seller, msg.sender, tokenId);
        if (msg.value > price) {
            (bool refunded, ) = payable(msg.sender).call{value: msg.value - price}("");
            require(refunded, "Refund gagal");
        }
    }

    function withdrawBySeries() external onlyOwner nonReentrant {
        uint256 amount = seriesVault;
        require(amount > 0, "Vault kosong");
        seriesVault = 0;
        (bool success, ) = payable(_salesRecipient()).call{value: amount}("");
        require(success, "Withdrawal gagal");
    }

    function withdrawCustomTokens() external onlyOwner nonReentrant {
        uint256 balance = customPaymentToken.balanceOf(address(this));
        require(balance > 0, "Saldo token di kontrak kosong");
        customPaymentToken.safeTransfer(owner(), balance);
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 firstTokenId,
        uint256 batchSize
    ) internal override {
        super._beforeTokenTransfer(from, to, firstTokenId, batchSize);
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < batchSize; i++) {
                delete nftPrice[firstTokenId + i];
            }
        }
    }
}