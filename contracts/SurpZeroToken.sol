// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract SurpZeroToken is ERC20, Ownable2Step {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_SUPPLY = 271_000_000_000_000 * 1e18;

    address public lpManager;
    address public p2eManager;

    bool public distributed;

    event VaultsSet(address lpManager, address p2eManager);
    event Distributed(uint256 lpAmount, uint256 p2eAmount);
    
    // Event tambahan buat tracking fitur rescue
    event EmergencyWithdrawNative(address indexed owner, uint256 amount);
    event EmergencyRescueToken(address indexed token, address indexed owner, uint256 amount);

    // Pastikan pakai Ownable(msg.sender) kalau lu pakai OpenZeppelin v5
    constructor() ERC20("Standard Units Rupol", "SRP") {}

    // ============================================================
    // SET VAULT (CUMA SEKALI)
    // ============================================================

    function setVaults(address _lpManager, address _p2eManager) external onlyOwner {
        require(!distributed, "locked");
        require(_lpManager != address(0) && _p2eManager != address(0), "zero");
        require(_lpManager != _p2eManager, "same");

        lpManager = _lpManager;
        p2eManager = _p2eManager;

        emit VaultsSet(_lpManager, _p2eManager);
    }

    // ============================================================
    // DISTRIBUTE SUPPLY
    // ============================================================

    function distribute() external onlyOwner {
        require(!distributed, "already");
        require(lpManager != address(0) && p2eManager != address(0), "vault missing");

        distributed = true;

        uint256 lpAmount = (MAX_SUPPLY * 60) / 100;
        uint256 p2eAmount = MAX_SUPPLY - lpAmount;

        _mint(lpManager, lpAmount);
        _mint(p2eManager, p2eAmount);

        emit Distributed(lpAmount, p2eAmount);
    }

    // ============================================================
    // RESCUE FITUR (Tarik Koin/Token Nyangkut)
    // ============================================================

    /**
     * @dev Wajib ada biar smart contract ini bisa nerima transfer koin native (ETH/BNB/MATIC dll).
     */
    receive() external payable {}

    /**
     * @dev Tarik saldo koin native yang masuk ke kontrak ini. Dikirim langsung ke wallet Owner.
     */
    function withdrawNative() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "Saldo koin native kosong");
        
        (bool success, ) = payable(owner()).call{value: balance}("");
        require(success, "Gagal menarik koin native");
        
        emit EmergencyWithdrawNative(owner(), balance);
    }

    /**
     * @dev Tarik token ERC-20 lain (misal USDT) yang nyangkut di kontrak ini ke wallet Owner.
     */
    function rescueToken(address tokenAddress) external onlyOwner {
        // Biar lu gak gak sengaja narik supply token lu sendiri dari kontrak
        require(tokenAddress != address(this), "Tidak bisa menarik SRP lewat fungsi ini");
        
        uint256 balance = IERC20(tokenAddress).balanceOf(address(this));
        require(balance > 0, "Saldo token tersebut kosong");
        
        IERC20(tokenAddress).safeTransfer(owner(), balance);
        
        emit EmergencyRescueToken(tokenAddress, owner(), balance);
    }
}