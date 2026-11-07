// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface INFTContract {
    // Menambahkan parameter uint256 xp di akhir fungsi
    function updateStatsFromShop(uint256 tokenId, uint8 stamina, uint8 durability, uint256 bank, uint256 xp) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract SRP_Shop is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public token;

    uint256 public staminaPrice;
    uint256 public durabilityPrice;
    uint256 public bankPrice;
    address public salesTreasury;

    uint8 public staminaStep = 1;
    uint8 public durabilityStep = 1;
    uint256 public bankStep = 10; // Nilai input 10 murni dari owner

    mapping(address => bool) public isWhitelistedNFT;

    event UpgradeBought(address indexed user, address indexed nftContract, uint256 indexed tokenId, string upgradeType, uint256 cost);
    event PricesUpdated(uint256 staminaPrice, uint256 durabilityPrice, uint256 bankPrice);
    event StepsUpdated(uint8 staminaStep, uint8 durabilityStep, uint256 bankStep);
    event SalesTreasuryUpdated(address indexed treasury);

    // KEMBALI KE GAYA KODE LU: Constructor kosongan mengikuti standar OpenZeppelin v4
    constructor(address _token) {
        require(_token != address(0) && _token.code.length > 0, "Invalid payment token");
        token = IERC20(_token);
    }

    function setNFTWhitelist(address _nftContract, bool _status) external onlyOwner {
        require(_nftContract != address(0), "Invalid NFT contract");
        if (_status) {
            require(_nftContract.code.length > 0, "NFT contract has no code");
        }
        isWhitelistedNFT[_nftContract] = _status;
    }

    function setPrices(uint256 _staminaPrice, uint256 _durabilityPrice, uint256 _bankPrice) external onlyOwner {
        staminaPrice = _staminaPrice;
        durabilityPrice = _durabilityPrice;
        bankPrice = _bankPrice;
        emit PricesUpdated(_staminaPrice, _durabilityPrice, _bankPrice);
    }

    function setSteps(uint8 _staminaStep, uint8 _durabilityStep, uint256 _bankStep) external onlyOwner {
        staminaStep = _staminaStep;
        durabilityStep = _durabilityStep;
        bankStep = _bankStep;
        emit StepsUpdated(_staminaStep, _durabilityStep, _bankStep);
    }

    function setSalesTreasury(address treasury) external onlyOwner {
        salesTreasury = treasury;
        emit SalesTreasuryUpdated(treasury);
    }

    // Tetap menjaga fitur volume kuantitas banyak sekaligus
    function buyStamina(address nftContract, uint256 tokenId, uint256 volume) external {
        require(volume > 0, "Kuantitas minimal 1");
        require(isWhitelistedNFT[nftContract], "NFT tidak terdaftar di shop");
        require(INFTContract(nftContract).ownerOf(tokenId) == msg.sender, "Bukan pemilik NFT");
        require(staminaPrice > 0, "Harga stamina belum diset");

        uint256 totalCost = staminaPrice * volume;
        uint256 requestedStep = uint256(staminaStep) * volume;
        uint8 totalStep = requestedStep > type(uint8).max
            ? type(uint8).max
            : uint8(requestedStep);

        token.safeTransferFrom(
            msg.sender,
            salesTreasury == address(0) ? address(this) : salesTreasury,
            totalCost
        );
        // Mengirimkan angka 1 untuk parameter XP
        INFTContract(nftContract).updateStatsFromShop(tokenId, totalStep, 0, 0, 1);

        emit UpgradeBought(msg.sender, nftContract, tokenId, "STAMINA", totalCost);
    }

    // Tetap menjaga fitur volume kuantitas banyak sekaligus
    function buyDurability(address nftContract, uint256 tokenId, uint256 volume) external {
        require(volume > 0, "Kuantitas minimal 1");
        require(isWhitelistedNFT[nftContract], "NFT tidak terdaftar di shop");
        require(INFTContract(nftContract).ownerOf(tokenId) == msg.sender, "Bukan pemilik NFT");
        require(durabilityPrice > 0, "Harga durability belum diset");

        uint256 totalCost = durabilityPrice * volume;
        uint256 requestedStep = uint256(durabilityStep) * volume;
        uint8 totalStep = requestedStep > type(uint8).max
            ? type(uint8).max
            : uint8(requestedStep);

        token.safeTransferFrom(
            msg.sender,
            salesTreasury == address(0) ? address(this) : salesTreasury,
            totalCost
        );
        // Mengirimkan angka 1 untuk parameter XP
        INFTContract(nftContract).updateStatsFromShop(tokenId, 0, totalStep, 0, 1);

        emit UpgradeBought(msg.sender, nftContract, tokenId, "DURABILITY", totalCost);
    }

    // Tetap menjaga fitur volume kuantitas banyak sekaligus
    function buyBank(address nftContract, uint256 tokenId, uint256 volume) external {
        require(volume > 0, "Kuantitas minimal 1");
        require(isWhitelistedNFT[nftContract], "NFT tidak terdaftar di shop");
        require(INFTContract(nftContract).ownerOf(tokenId) == msg.sender, "Bukan pemilik NFT");
        require(bankPrice > 0, "Harga bank belum diset");

        uint256 totalCost = bankPrice * volume;
        uint256 totalStep = (bankStep * 10**18) * volume;

        token.safeTransferFrom(
            msg.sender,
            salesTreasury == address(0) ? address(this) : salesTreasury,
            totalCost
        );
        // Mengirimkan angka 1 untuk parameter XP
        INFTContract(nftContract).updateStatsFromShop(tokenId, 0, 0, totalStep, 1);

        emit UpgradeBought(msg.sender, nftContract, tokenId, "BANK", totalCost);
    }

    function withdrawShopTokens(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid address");
        token.safeTransfer(to, amount);
    }
}