// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

interface ILPLockableNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

contract LPNFTLocker is Ownable2Step, ReentrancyGuard, EIP712 {
    uint64 public constant DEFAULT_LOCK_DURATION = 10 * 365 days;
    uint64 public lockDuration = DEFAULT_LOCK_DURATION;
    bytes32 private constant UNLOCK_TYPEHASH =
        keccak256(
            "Unlock(address nftContract,uint256 tokenId,address beneficiary,uint256 nonce,uint256 deadline)"
        );

    address public unlockSigner;

    struct Lock {
        address beneficiary;
        uint64 unlockTime;
    }

    mapping(address => mapping(uint256 => Lock)) public locks;
    mapping(address => mapping(uint256 => uint256)) public unlockNonces;

    event LockDurationUpdated(uint64 previousDuration, uint64 newDuration);
    event UnlockSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event LPNFTLocked(
        address indexed nftContract,
        uint256 indexed tokenId,
        address indexed beneficiary,
        uint64 unlockTime
    );
    event LPNFTUnlocked(
        address indexed nftContract,
        uint256 indexed tokenId,
        address indexed beneficiary,
        uint256 nonce
    );

    constructor() EIP712("SurpZero LP NFT Locker", "1") {}

    function setLockDuration(uint64 newDuration) external onlyOwner {
        require(newDuration > 0, "Lock duration is zero");
        uint64 previousDuration = lockDuration;
        lockDuration = newDuration;
        emit LockDurationUpdated(previousDuration, newDuration);
    }

    function setUnlockSigner(address newSigner) external onlyOwner {
        require(newSigner != address(0), "Unlock signer is zero");
        address previousSigner = unlockSigner;
        unlockSigner = newSigner;
        emit UnlockSignerUpdated(previousSigner, newSigner);
    }

    function lock(address nftContract, uint256 tokenId) external nonReentrant {
        require(nftContract.code.length > 0, "Invalid NFT contract");
        require(unlockSigner != address(0), "Unlock signer not configured");
        require(locks[nftContract][tokenId].beneficiary == address(0), "NFT already locked");

        ILPLockableNFT nft = ILPLockableNFT(nftContract);
        require(nft.ownerOf(tokenId) == msg.sender, "Caller does not own NFT");

        uint256 unlockTimestamp = block.timestamp + lockDuration;
        require(unlockTimestamp <= type(uint64).max, "Unlock time overflow");

        nft.transferFrom(msg.sender, address(this), tokenId);
        require(nft.ownerOf(tokenId) == address(this), "NFT transfer failed");

        uint64 unlockTime = uint64(unlockTimestamp);
        locks[nftContract][tokenId] = Lock({
            beneficiary: msg.sender,
            unlockTime: unlockTime
        });
        emit LPNFTLocked(nftContract, tokenId, msg.sender, unlockTime);
    }

    function unlock(
        address nftContract,
        uint256 tokenId,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        Lock memory nftLock = locks[nftContract][tokenId];
        require(nftLock.beneficiary == msg.sender, "Caller is not beneficiary");
        require(block.timestamp >= nftLock.unlockTime, "NFT is still locked");
        require(block.timestamp <= deadline, "Unlock signature expired");

        uint256 nonce = unlockNonces[nftContract][tokenId];
        bytes32 structHash = keccak256(
            abi.encode(
                UNLOCK_TYPEHASH,
                nftContract,
                tokenId,
                msg.sender,
                nonce,
                deadline
            )
        );
        require(
            ECDSA.recover(_hashTypedDataV4(structHash), signature) == unlockSigner,
            "Invalid unlock signature"
        );

        delete locks[nftContract][tokenId];
        unlockNonces[nftContract][tokenId] = nonce + 1;
        ILPLockableNFT(nftContract).safeTransferFrom(address(this), msg.sender, tokenId);
        emit LPNFTUnlocked(nftContract, tokenId, msg.sender, nonce);
    }
}
