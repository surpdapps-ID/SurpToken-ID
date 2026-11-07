// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

interface IUniswapV3Pool {
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationMax,
        uint16 observationNext,
        uint8 feeProtocol,
        bool unlocked
    );
    function token0() external view returns (address);
}

interface IP2EManager {
    function payout(address user, uint256 amount) external;
}

contract SRP_Rare is ERC721, Ownable, ReentrancyGuard {
    using Strings for uint256;

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

    uint256 public constant MAX_SUPPLY = 900; 

    // CONFIG VALUE DASAR LEVEL 1
    uint8 public constant BASE_STAMINA = 10;
    uint8 public constant BASE_DURABILITY = 10;
    uint256 public constant BASE_POWER_EFF = 60;

    mapping(uint256 => NFTStats) public stats;
    mapping(uint256 => uint256) public nftPrice;

    uint256 public seriesVault;
    address public shopContract;
    address public p2eManager;

    // CONFIGURATION ORACLE HARGA V3 (Bisa di-setting setelah deploy)
    address public tokenPoolAddress; 
    uint256 public baseTokenPrice = 1 * 10**18; 

    uint256 private _tokenIdCounter;
    string private _baseTokenURI;

    uint256 public miningCooldown = 2 days; 

    constructor() ERC721("Zeroic Rare", "ZRE") {}

    // =========================================================================
    // SETTER FUNCTIONS (Kunci Pengaturan Setelah Deploy)
    // =========================================================================
    
    function setTokenPool(address _pool) external onlyOwner {
        tokenPoolAddress = _pool;
    }

    function setBaseTokenPrice(uint256 _basePrice) external onlyOwner {
        baseTokenPrice = _basePrice;
    }

    function setCooldown(uint256 _duration) external onlyOwner {
        miningCooldown = _duration;
    }

    function setBaseURI(string memory baseURI) external onlyOwner {
        _baseTokenURI = baseURI;
    }

    function setShopContract(address _shop) external onlyOwner {
        shopContract = _shop;
    }

    function setP2EConfig(address _manager) external onlyOwner {
        p2eManager = _manager;
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

        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(tokenPoolAddress).slot0();
        if (sqrtPriceX96 == 0) return baseTokenPrice;

        address token0 = IUniswapV3Pool(tokenPoolAddress).token0();
        uint256 priceX96 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        
        uint256 price;
        if (token0 == address(this)) {
            price = (1 * 10**18 * (1 << 192)) / priceX96;
        } else {
            price = (priceX96 * 10**18) / (1 << 192);
        }

        return price;
    }

    // Menambahkan parameter uint256 xp di akhir fungsi agar sinkron dengan kontrak Shop
    function updateStatsFromShop(uint256 tokenId, uint8 stamina, uint8 durability, uint256 bank, uint256 xp) external {
        require(msg.sender == shopContract, "Bukan shop contract resmi");
        
        if (stamina > 0) {
            stats[tokenId].currentStamina += stamina;
            if (stats[tokenId].currentStamina > stats[tokenId].maxStamina) {
                stats[tokenId].currentStamina = stats[tokenId].maxStamina;
            }
        }
        if (durability > 0) {
            stats[tokenId].currentDurability += durability;
            if (stats[tokenId].currentDurability > stats[tokenId].maxDurability) {
                stats[tokenId].currentDurability = stats[tokenId].maxDurability;
            }
        }
        if (bank > 0) {
            stats[tokenId].maxBank += bank; 
        }

        // Akumulasikan XP yang didapat dari aktivitas belanja di shop
        if (xp > 0) {
            _addXP(tokenId, xp);
        }

        uint256 maxStaminaLvl = BASE_STAMINA + (uint256(stats[tokenId].level) - 1) * 5;
        uint256 maxPowerLvl = BASE_POWER_EFF + (uint256(stats[tokenId].level) - 1) * 5;

        stats[tokenId].power = (maxPowerLvl * stats[tokenId].currentStamina) / maxStaminaLvl;
        stats[tokenId].efficiency = (maxPowerLvl * stats[tokenId].currentStamina) / maxStaminaLvl;
    }

    function mintNFT(address to) external onlyOwner {
        require(_tokenIdCounter < MAX_SUPPLY, "Supply sudah habis");
        uint256 id = ++_tokenIdCounter;
        _safeMint(to, id);
        
        stats[id] = NFTStats({
            level: 1,
            xp: 0,
            currentDurability: BASE_DURABILITY,
            maxDurability: BASE_DURABILITY,
            currentStamina: BASE_STAMINA,
            maxStamina: BASE_STAMINA,
            currentBank: 0, 
            maxBank: 6000 * 10**18, 
            power: BASE_POWER_EFF,
            efficiency: BASE_POWER_EFF,
            timestamp: 0 
        });
    }

    function startMining(uint256 id) external {
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
        uint256 currentPrice = getTokenPrice();
        
        uint256 dynamicCooldown = miningCooldown;
        if (currentPrice > baseTokenPrice) {
            dynamicCooldown = (miningCooldown * currentPrice) / baseTokenPrice;
        }

        if (effectiveTime >= dynamicCooldown) {
            return stats[id].maxBank;
        }
        
        return (stats[id].maxBank * effectiveTime) / dynamicCooldown;
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
        while (stats[id].level < 10 && stats[id].xp >= uint256(stats[id].level) * 1500) {
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

    function tradeNFT(uint256 tokenId) external payable nonReentrant {
        uint256 price = nftPrice[tokenId];
        require(price > 0, "NFT tidak sedang dijual");
        require(msg.value >= price, "Dana kurang");
        address seller = ownerOf(tokenId);
        require(seller != msg.sender, "Tidak bisa membeli milik sendiri");
        nftPrice[tokenId] = 0;
        uint256 royalty = (price * 5) / 100;
        uint256 sellerProceeds = price - royalty;
        seriesVault += royalty;
        payable(seller).transfer(sellerProceeds);
        _transfer(seller, msg.sender, tokenId);
        if (msg.value > price) { payable(msg.sender).transfer(msg.value - price); }
    }

    function withdrawBySeries() external onlyOwner nonReentrant {
        uint256 amount = seriesVault;
        require(amount > 0, "Vault kosong");
        seriesVault = 0;
        payable(owner()).transfer(amount);
    }
}