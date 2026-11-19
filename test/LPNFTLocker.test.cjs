const { strict: assert } = require("node:assert");
const { ethers } = require("hardhat");

async function signUnlock(backend, locker, nft, tokenId, beneficiary, nonce, deadline) {
  const { chainId } = await ethers.provider.getNetwork();
  return backend.signTypedData(
    {
      name: "SurpZero LP NFT Locker",
      version: "1",
      chainId,
      verifyingContract: await locker.getAddress(),
    },
    {
      Unlock: [
        { name: "nftContract", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "beneficiary", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    {
      nftContract: await nft.getAddress(),
      tokenId,
      beneficiary,
      nonce,
      deadline,
    },
  );
}

describe("LPNFTLocker", function () {
  async function deployLocker() {
    const [owner, beneficiary, other, backend] = await ethers.getSigners();
    const nft = await (await ethers.getContractFactory("MockLockableNFT")).deploy();
    await nft.waitForDeployment();
    const locker = await (await ethers.getContractFactory("LPNFTLocker")).deploy();
    await locker.waitForDeployment();
    await (await locker.setUnlockSigner(backend.address)).wait();
    return { owner, beneficiary, other, backend, nft, locker };
  }

  it("requires a backend signature to unlock after the ten-year lock expires", async function () {
    const { beneficiary, backend, nft, locker } = await deployLocker();
    const tokenId = 1n;
    await (await nft.mint(beneficiary.address, tokenId)).wait();

    await (await nft.connect(beneficiary).approve(await locker.getAddress(), tokenId)).wait();
    const lockTx = await locker.connect(beneficiary).lock(await nft.getAddress(), tokenId);
    const lockReceipt = await lockTx.wait();
    const lockBlock = await ethers.provider.getBlock(lockReceipt.blockNumber);
    const expectedUnlockTime = BigInt(lockBlock.timestamp) + 10n * 365n * 24n * 60n * 60n;

    assert.equal(await locker.lockDuration(), 10n * 365n * 24n * 60n * 60n);
    assert.equal(await nft.ownerOf(tokenId), await locker.getAddress());
    const lockInfo = await locker.locks(await nft.getAddress(), tokenId);
    assert.equal(lockInfo.beneficiary, beneficiary.address);
    assert.equal(lockInfo.unlockTime, expectedUnlockTime);

    const deadline = lockInfo.unlockTime + 3600n;
    const signature = await signUnlock(
      backend,
      locker,
      nft,
      tokenId,
      beneficiary.address,
      0n,
      deadline,
    );
    await assert.rejects(
      locker.connect(beneficiary).unlock(await nft.getAddress(), tokenId, deadline, signature),
    );
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(lockInfo.unlockTime)]);
    await assert.rejects(
      locker.connect(beneficiary).unlock(await nft.getAddress(), tokenId, deadline, "0x"),
    );
    await (
      await locker.connect(beneficiary).unlock(
        await nft.getAddress(),
        tokenId,
        deadline,
        signature,
      )
    ).wait();
    assert.equal(await nft.ownerOf(tokenId), beneficiary.address);
    assert.equal(await locker.unlockNonces(await nft.getAddress(), tokenId), 1n);
  });

  it("lets only the owner change the duration for future locks", async function () {
    const { owner, beneficiary, other, nft, locker } = await deployLocker();
    await assert.rejects(locker.connect(other).setLockDuration(30 * 24 * 60 * 60));
    await assert.rejects(locker.setLockDuration(0));

    await (await nft.mint(beneficiary.address, 1)).wait();
    await (await nft.mint(beneficiary.address, 2)).wait();
    await (await nft.connect(beneficiary).setApprovalForAll(await locker.getAddress(), true)).wait();
    const firstLockTx = await locker.connect(beneficiary).lock(await nft.getAddress(), 1);
    const firstLockReceipt = await firstLockTx.wait();
    const firstLockBlock = await ethers.provider.getBlock(firstLockReceipt.blockNumber);
    const originalLock = await locker.locks(await nft.getAddress(), 1);

    const newDuration = 30n * 24n * 60n * 60n;
    await (await locker.connect(owner).setLockDuration(newDuration)).wait();
    const secondLockTx = await locker.connect(beneficiary).lock(await nft.getAddress(), 2);
    const secondLockReceipt = await secondLockTx.wait();
    const secondLockBlock = await ethers.provider.getBlock(secondLockReceipt.blockNumber);
    const newLock = await locker.locks(await nft.getAddress(), 2);

    assert.equal(
      newLock.unlockTime - originalLock.unlockTime,
      BigInt(secondLockBlock.timestamp - firstLockBlock.timestamp) +
        newDuration - 10n * 365n * 24n * 60n * 60n,
    );
    assert.equal((await locker.locks(await nft.getAddress(), 1)).unlockTime, originalLock.unlockTime);
  });

  it("rejects locks by non-owners and duplicate lock attempts", async function () {
    const { beneficiary, other, nft, locker } = await deployLocker();
    await (await nft.mint(beneficiary.address, 3)).wait();
    await assert.rejects(locker.connect(other).lock(await nft.getAddress(), 3));

    await (await nft.connect(beneficiary).approve(await locker.getAddress(), 3)).wait();
    await (await locker.connect(beneficiary).lock(await nft.getAddress(), 3)).wait();
    await assert.rejects(locker.connect(beneficiary).lock(await nft.getAddress(), 3));
    await assert.rejects(
      locker.connect(other).unlock(await nft.getAddress(), 3, 0, "0x"),
    );
  });

  it("requires the owner to configure a backend signer before accepting locks", async function () {
    const [, beneficiary] = await ethers.getSigners();
    const nft = await (await ethers.getContractFactory("MockLockableNFT")).deploy();
    await nft.waitForDeployment();
    const locker = await (await ethers.getContractFactory("LPNFTLocker")).deploy();
    await locker.waitForDeployment();
    await (await nft.mint(beneficiary.address, 4)).wait();
    await (await nft.connect(beneficiary).approve(await locker.getAddress(), 4)).wait();

    await assert.rejects(locker.connect(beneficiary).lock(await nft.getAddress(), 4));
  });
});
