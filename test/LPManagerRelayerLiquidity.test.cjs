const { strict: assert } = require("node:assert");
const { ethers } = require("hardhat");

describe("LPManager relayer add liquidity", function () {
  async function deploy() {
    const [owner, relayer, other] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockRewardToken")).deploy();
    const pairToken = await (await ethers.getContractFactory("MockRewardToken")).deploy();
    await Promise.all([token.waitForDeployment(), pairToken.waitForDeployment()]);
    const positionManager = await (
      await ethers.getContractFactory("MockLPPositionManager")
    ).deploy();
    await positionManager.waitForDeployment();
    const manager = await (
      await ethers.getContractFactory("LPManager")
    ).deploy(await token.getAddress(), await pairToken.getAddress());
    await manager.waitForDeployment();
    await (
      await manager.setPayPalPayoutConfig(
        relayer.address,
        ethers.parseEther("1"),
        ethers.parseEther("2"),
      )
    ).wait();
    await (
      await manager.setLiquidityConfig(
        await positionManager.getAddress(),
        await pairToken.getAddress(),
      )
    ).wait();
    await (
      await token.mint(relayer.address, ethers.parseEther("10"))
    ).wait();
    await (
      await pairToken.mint(owner.address, ethers.parseEther("10"))
    ).wait();
    return { owner, relayer, other, token, pairToken, positionManager, manager };
  }

  it("uses SRP from relayer and pair tokens from owner, then mints LP to owner", async function () {
    const { owner, relayer, token, pairToken, positionManager, manager } = await deploy();
    const amountSRP = ethers.parseEther("5");
    const amountPair = ethers.parseEther("10");
    await (await token.connect(relayer).approve(await manager.getAddress(), amountSRP)).wait();
    await (await pairToken.connect(owner).approve(await manager.getAddress(), amountPair)).wait();

    const latestBlock = await ethers.provider.getBlock("latest");
    const args = [
      3000,
      -887220,
      887220,
      amountSRP,
      amountPair,
      ethers.parseEther("4"),
      ethers.parseEther("8"),
      latestBlock.timestamp + 600,
    ];
    await (await manager.connect(relayer).addLiquidityForRelayer(...args)).wait();

    assert.equal(await positionManager.lastRecipient(), owner.address);
    assert.equal(await token.balanceOf(relayer.address), ethers.parseEther("5.5"));
    assert.equal(await pairToken.balanceOf(owner.address), ethers.parseEther("1"));
    assert.equal(await pairToken.balanceOf(await manager.getAddress()), 0n);
    assert.equal(await token.balanceOf(await manager.getAddress()), 0n);
    assert.equal(await pairToken.allowance(await manager.getAddress(), await positionManager.getAddress()), 0n);
  });

  it("rejects non-relayers, missing owner approval, invalid minimums, and expired deadlines", async function () {
    const { owner, relayer, other, token, pairToken, manager } = await deploy();
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const baseArgs = [
      3000,
      -887220,
      887220,
      ethers.parseEther("1"),
      ethers.parseEther("1"),
      0,
      0,
      now + 600,
    ];
    await assert.rejects(manager.connect(other).addLiquidityForRelayer(...baseArgs));
    await assert.rejects(manager.connect(relayer).addLiquidityForRelayer(...baseArgs));

    await (await token.connect(relayer).approve(await manager.getAddress(), ethers.parseEther("1"))).wait();
    await (await pairToken.connect(owner).approve(await manager.getAddress(), ethers.parseEther("1"))).wait();
    await assert.rejects(
      manager.connect(relayer).addLiquidityForRelayer(...baseArgs.slice(0, 6), ethers.parseEther("2"), baseArgs[7]),
    );
    await assert.rejects(
      manager.connect(relayer).addLiquidityForRelayer(...baseArgs.slice(0, 7), now - 1),
    );
    assert.equal(await manager.owner(), owner.address);
  });
});
