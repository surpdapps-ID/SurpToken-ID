const { strict: assert } = require("node:assert");
const { ethers } = require("hardhat");

describe("SRP NFT collection bank defaults", function () {
  it("initializes each collection with its configured bank capacity", async function () {
    const [owner] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockRewardToken")).deploy();
    await token.waitForDeployment();

    const expectedBanks = [
      ["SRP_Common", "5000"],
      ["SRP_Rare", "6000"],
      ["SRP_Epic", "7000"],
      ["SRP_Flash", "8000"],
      ["SRP_Scattery", "9000"],
      ["SRP_BrushViolet", "10000"],
    ];

    for (const [contractName, expectedBank] of expectedBanks) {
      const nft = await (await ethers.getContractFactory(contractName)).deploy(
        await token.getAddress(),
      );
      await nft.waitForDeployment();
      await (await nft.mintNFT(owner.address)).wait();

      const expected = ethers.parseEther(expectedBank);
      assert.equal(await nft.DEFAULT_MAX_BANK(), expected);
      assert.equal((await nft.stats(1)).maxBank, expected);
    }
  });

  it("calculates mining progress from cooldown without applying a price multiplier", async function () {
    const [owner] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("SurpZeroToken")).deploy();
    await token.waitForDeployment();
    const nft = await (await ethers.getContractFactory("SRP_Common")).deploy(
      await token.getAddress(),
    );
    await nft.waitForDeployment();
    await (await nft.setCooldown(200)).wait();
    await (await nft.setBaseTokenPrice(ethers.parseEther("2"))).wait();
    await (await nft.mintNFT(owner.address)).wait();
    await (await nft.startMining(1)).wait();

    await ethers.provider.send("evm_increaseTime", [100]);
    await ethers.provider.send("evm_mine", []);

    assert.equal(
      await nft.getLiveBank(1),
      (await nft.stats(1)).maxBank / 2n,
    );
  });

  it("stops new mining starts while allowing an active mining run to be claimed", async function () {
    const [owner] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockRewardToken")).deploy();
    await token.waitForDeployment();
    const nft = await (await ethers.getContractFactory("SRP_Common")).deploy(
      await token.getAddress(),
    );
    await nft.waitForDeployment();
    const p2e = await (
      await ethers.getContractFactory("P2EManager")
    ).deploy(await token.getAddress());
    await p2e.waitForDeployment();
    await (await p2e.setMiningPoolStatus(await nft.getAddress(), true)).wait();
    await (await nft.setP2EConfig(await p2e.getAddress())).wait();
    await (await token.mint(await p2e.getAddress(), ethers.parseEther("10000"))).wait();
    await (await nft.mintNFT(owner.address)).wait();
    await (await nft.startMining(1)).wait();

    await (await nft.pause()).wait();
    await assert.rejects(nft.startMining(1), /Pausable: paused/);
    await ethers.provider.send("evm_increaseTime", [60]);
    await ethers.provider.send("evm_mine", []);
    await (await nft.claim(1)).wait();
    assert.equal(await token.balanceOf(owner.address), ethers.parseEther("5000"));

    await (await nft.unpause()).wait();
    await (await nft.startMining(1)).wait();
  });
});
