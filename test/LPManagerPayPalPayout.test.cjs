const { strict: assert } = require("node:assert");
const { ethers } = require("hardhat");

describe("LPManager PayPal payouts", function () {
  async function deployManager() {
    const [owner, relayer, recipient, other, p2e] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("SurpZeroToken")).deploy();
    await token.waitForDeployment();

    const manager = await (
      await ethers.getContractFactory("LPManager")
    ).deploy(await token.getAddress(), await token.getAddress());
    await manager.waitForDeployment();

    await (await token.setVaults(await manager.getAddress(), p2e.address)).wait();
    await (await token.distribute()).wait();

    return { owner, relayer, recipient, other, token, manager };
  }

  it("allows only the configured relayer and enforces transaction and daily limits", async function () {
    const { relayer, recipient, other, token, manager } = await deployManager();
    const perTransaction = ethers.parseEther("10");
    const dailyLimit = ethers.parseEther("25");
    await (
      await manager.setPayPalPayoutConfig(
        relayer.address,
        perTransaction,
        dailyLimit,
      )
    ).wait();

    const firstPayment = ethers.id("paypal-capture-1");
    await assert.rejects(
      manager.connect(other).releaseForPayPal(firstPayment, recipient.address, perTransaction),
    );
    await assert.rejects(
      manager.connect(relayer).releaseForPayPal(
        ethers.id("paypal-capture-too-large"),
        recipient.address,
        perTransaction + 1n,
      ),
    );

    const recipientBalanceBefore = await token.balanceOf(recipient.address);
    await (
      await manager.connect(relayer).releaseForPayPal(
        firstPayment,
        recipient.address,
        perTransaction,
      )
    ).wait();
    await (
      await manager.connect(relayer).releaseForPayPal(
        ethers.id("paypal-capture-2"),
        recipient.address,
        perTransaction,
      )
    ).wait();
    await assert.rejects(
      manager.connect(relayer).releaseForPayPal(
        ethers.id("paypal-capture-3"),
        recipient.address,
        perTransaction,
      ),
    );
    await assert.rejects(
      manager.connect(relayer).releaseForPayPal(firstPayment, recipient.address, 1n),
    );

    assert.equal(
      (await token.balanceOf(recipient.address)) - recipientBalanceBefore,
      perTransaction * 2n,
    );
    assert.equal(await manager.dailyPayPalPayoutUsed(), perTransaction * 2n);
    assert.equal(await manager.processedPayPalPayments(firstPayment), true);

    const latestBlock = await ethers.provider.getBlock("latest");
    const nextDay = (Math.floor(latestBlock.timestamp / 86400) + 1) * 86400;
    await ethers.provider.send("evm_setNextBlockTimestamp", [nextDay]);
    await ethers.provider.send("evm_mine", []);
    await (
      await manager.connect(relayer).releaseForPayPal(
        ethers.id("paypal-capture-next-day"),
        recipient.address,
        perTransaction,
      )
    ).wait();
    assert.equal(await manager.dailyPayPalPayoutUsed(), perTransaction);
  });

  it("lets the owner disable payouts and rejects invalid payout configuration", async function () {
    const { owner, relayer, recipient, other, manager } = await deployManager();
    await assert.rejects(
      manager.connect(other).setPayPalPayoutConfig(
        relayer.address,
        ethers.parseEther("1"),
        ethers.parseEther("2"),
      ),
    );
    await assert.rejects(
      manager.setPayPalPayoutConfig(
        relayer.address,
        ethers.parseEther("2"),
        ethers.parseEther("1"),
      ),
    );

    await (
      await manager.setPayPalPayoutConfig(
        relayer.address,
        ethers.parseEther("1"),
        ethers.parseEther("2"),
      )
    ).wait();
    await (
      await manager.setPayPalPayoutConfig(ethers.ZeroAddress, 0, 0)
    ).wait();
    await assert.rejects(
      manager.connect(relayer).releaseForPayPal(
        ethers.id("paypal-capture-disabled"),
        recipient.address,
        1n,
      ),
    );
    assert.equal(await manager.owner(), owner.address);
  });
});
