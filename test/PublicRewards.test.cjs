const { strict: assert } = require("node:assert");
const { ethers, network } = require("hardhat");

describe("SRP reward programs", function () {
  async function deploySharedP2E() {
    const [admin, alice, bob, outsider] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockRewardToken")).deploy();
    await token.waitForDeployment();
    const quote = await (await ethers.getContractFactory("MockRewardToken")).deploy();
    await quote.waitForDeployment();
    const pool = await (
      await ethers.getContractFactory("MockSurpSwapV3TwapPool")
    ).deploy(await token.getAddress(), await quote.getAddress());
    await pool.waitForDeployment();
    const p2e = await (
      await ethers.getContractFactory("P2EManager")
    ).deploy(await token.getAddress());
    await p2e.waitForDeployment();
    return { admin, alice, bob, outsider, token, quote, pool, p2e };
  }

  async function deployStaking(context) {
    const { admin, token, quote, pool, p2e } = context;
    const staking = await (
      await ethers.getContractFactory("PublicStaking")
    ).deploy(
      await token.getAddress(),
      await p2e.getAddress(),
      await pool.getAddress(),
      await quote.getAddress(),
      1800,
      admin.address,
    );
    await staking.waitForDeployment();
    await (await p2e.setMiningPoolStatus(await staking.getAddress(), true)).wait();
    await (
      await staking.setAprParameters(
        ethers.parseEther("1"),
        1,
        0,
        40_000,
      )
    ).wait();
    return staking;
  }

  async function advanceTime(seconds) {
    await network.provider.send("evm_increaseTime", [seconds]);
    await network.provider.send("evm_mine");
  }

  describe("PublicStaking", function () {
    it("stops new staking while preserving existing reward claims and principal withdrawals", async function () {
      const context = await deploySharedP2E();
      const { admin, alice, token, p2e } = context;
      const staking = await deployStaking(context);
      const amount = ethers.parseEther("10");
      await (await token.mint(alice.address, amount)).wait();
      await (await token.connect(alice).approve(await staking.getAddress(), amount)).wait();
      await (await token.mint(await p2e.getAddress(), ethers.parseEther("10"))).wait();
      await (await staking.connect(alice).stake(amount)).wait();
      await (await staking.connect(admin).pause()).wait();

      await assert.rejects(staking.connect(alice).stake(amount), /Pausable: paused/);
      await advanceTime(90 * 24 * 60 * 60);
      await (await staking.connect(alice).claimReward()).wait();
      await (await staking.connect(alice).withdrawPrincipal()).wait();

      assert.equal(await staking.paused(), true);
      assert((await token.balanceOf(alice.address)) > amount);
      await (await staking.connect(admin).unpause()).wait();
    });

    it("updates APR from TWAP price and active wallet count, and accrues each rate period", async function () {
      const context = await deploySharedP2E();
      const { alice, token, pool, p2e } = context;
      const staking = await deployStaking(context);
      await (await token.mint(alice.address, ethers.parseEther("100"))).wait();
      await (
        await token.connect(alice).approve(await staking.getAddress(), ethers.parseEther("100"))
      ).wait();
      await (await token.mint(await p2e.getAddress(), ethers.parseEther("1000"))).wait();
      const stakeTx = await staking.connect(alice).stake(ethers.parseEther("100"));
      const stakeReceipt = await stakeTx.wait();

      assert.equal(await staking.currentAprBps(), 20_000n);
      await assert.rejects(staking.connect(alice).claimReward(), /Stake is locked/);
      const stake = await staking.stakes(alice.address);
      const start = Number(stake.stakedAt);

      await advanceTime(30 * 24 * 60 * 60);
      await (await pool.setTick(6931)).wait();
      const checkpointTx = await staking.checkpointApr();
      const checkpointReceipt = await checkpointTx.wait();
      const increasedAprBps = await staking.currentAprBps();
      assert(increasedAprBps > 20_000n);

      await advanceTime(59 * 24 * 60 * 60);
      await assert.rejects(staking.connect(alice).withdrawPrincipal(), /Stake is locked/);
      await advanceTime(24 * 60 * 60 + 10);
      await (await staking.connect(alice).claimReward()).wait();
      await (await staking.connect(alice).withdrawPrincipal()).wait();

      const stakeBlock = await ethers.provider.getBlock(stakeReceipt.blockNumber);
      const checkpointBlock = await ethers.provider.getBlock(checkpointReceipt.blockNumber);
      const unlockAt = start + 90 * 24 * 60 * 60;
      const elapsedAtStart = checkpointBlock.timestamp - start;
      const elapsedAtHighRate = unlockAt - checkpointBlock.timestamp;
      const expected = ethers.parseEther("100") * (
        20_000n * BigInt(elapsedAtStart) + increasedAprBps * BigInt(elapsedAtHighRate)
      ) / (10_000n * 365n * 24n * 60n * 60n);
      const balance = await token.balanceOf(alice.address);
      assert.equal(balance, ethers.parseEther("100") + expected);
      assert(stakeBlock.timestamp > 0);
      assert.equal(await staking.activeStakerCount(), 0n);
    });

    it("limits new staking commitments to the current P2E balance", async function () {
      const context = await deploySharedP2E();
      const { alice, bob, token, p2e } = context;
      const staking = await deployStaking(context);
      const amount = ethers.parseEther("10");
      await (await token.mint(alice.address, amount)).wait();
      await (await token.connect(alice).approve(await staking.getAddress(), amount)).wait();

      await assert.rejects(
        staking.connect(alice).stake(amount),
        /Insufficient P2E balance for reward commitments/,
      );
      await (await token.mint(await p2e.getAddress(), ethers.parseEther("10"))).wait();
      await (await staking.connect(alice).stake(amount)).wait();
      const available = await staking.availableRewardBalance();
      assert.equal(
        available,
        ethers.parseEther("10") - (await staking.committedRewards()),
      );

      await (await p2e.emergencyWithdraw(alice.address, available)).wait();
      assert.equal(await staking.availableRewardBalance(), 0n);
      await (await token.mint(bob.address, amount)).wait();
      await (await token.connect(bob).approve(await staking.getAddress(), amount)).wait();
      await assert.rejects(
        staking.connect(bob).stake(amount),
        /Insufficient P2E balance for reward commitments/,
      );
    });

    it("reduces APR when active staking wallets increase and preserves reward claims if P2E is drained", async function () {
      const context = await deploySharedP2E();
      const { alice, bob, outsider, token, p2e } = context;
      const staking = await deployStaking(context);
      await (await token.mint(await p2e.getAddress(), ethers.parseEther("100"))).wait();
      const amount = ethers.parseEther("10");
      for (const account of [alice, bob]) {
        await (await token.mint(account.address, amount)).wait();
        await (await token.connect(account).approve(await staking.getAddress(), amount)).wait();
      }
      await (await staking.connect(alice).stake(amount)).wait();
      await (await staking.connect(bob).stake(amount)).wait();
      assert.equal(await staking.currentAprBps(), 10_000n);

      await advanceTime(90 * 24 * 60 * 60);
      await (await p2e.emergencyWithdraw(outsider.address, ethers.parseEther("100"))).wait();
      await assert.rejects(staking.connect(alice).claimReward(), /Dana vault P2E habis/);
      await (await staking.connect(alice).withdrawPrincipal()).wait();
      assert.equal(await token.balanceOf(alice.address), amount);
    });
  });

  describe("InvestorDividend", function () {
    it("stops new dividend stakes while preserving existing reward claims and principal withdrawals", async function () {
      const { admin, alice, token, p2e } = await deploySharedP2E();
      const sale = await (
        await ethers.getContractFactory("MockInvestorEligibility")
      ).deploy();
      await sale.waitForDeployment();
      await (await sale.setInvestor(alice.address, true)).wait();
      const dividends = await (
        await ethers.getContractFactory("InvestorDividend")
      ).deploy(
        await token.getAddress(),
        await p2e.getAddress(),
        await sale.getAddress(),
        admin.address,
      );
      await dividends.waitForDeployment();
      await (await p2e.setMiningPoolStatus(await dividends.getAddress(), true)).wait();
      const principal = ethers.parseEther("10");
      await (await token.mint(alice.address, principal)).wait();
      await (await token.connect(alice).approve(await dividends.getAddress(), principal)).wait();
      await (await token.mint(await p2e.getAddress(), ethers.parseEther("100"))).wait();
      await (await dividends.connect(alice).stakeDividend(principal)).wait();
      await (await dividends.connect(admin).pause()).wait();

      await assert.rejects(
        dividends.connect(alice).stakeDividend(principal),
        /Pausable: paused/,
      );
      await advanceTime(30 * 24 * 60 * 60);
      await (await dividends.connect(alice).claimMonthlyReward()).wait();
      await advanceTime(335 * 24 * 60 * 60);
      await (await dividends.connect(alice).withdrawPrincipal()).wait();

      assert.equal(await dividends.paused(), true);
      assert.equal(await token.balanceOf(alice.address), ethers.parseEther("10.125"));
      await (await dividends.connect(admin).unpause()).wait();
    });

    it("locks investor principal for one year and pays a simple 15% APR monthly", async function () {
      const { admin, alice, token, p2e } = await deploySharedP2E();
      const sale = await (
        await ethers.getContractFactory("MockInvestorEligibility")
      ).deploy();
      await sale.waitForDeployment();
      await (await sale.setInvestor(alice.address, true)).wait();

      const dividends = await (
        await ethers.getContractFactory("InvestorDividend")
      ).deploy(
        await token.getAddress(),
        await p2e.getAddress(),
        await sale.getAddress(),
        admin.address,
      );
      await dividends.waitForDeployment();
      await (await p2e.setMiningPoolStatus(await dividends.getAddress(), true)).wait();

      const principal = ethers.parseEther("10");
      await (await token.mint(alice.address, principal)).wait();
      await (await token.connect(alice).approve(await dividends.getAddress(), principal)).wait();
      await (await token.mint(await p2e.getAddress(), ethers.parseEther("100"))).wait();
      await (await dividends.connect(alice).stakeDividend(principal)).wait();

      await assert.rejects(dividends.connect(alice).claimMonthlyReward(), /Monthly reward not due/);
      await assert.rejects(dividends.connect(alice).withdrawPrincipal(), /Dividend stake is locked/);

      await advanceTime(30 * 24 * 60 * 60);
      await (await dividends.connect(alice).claimMonthlyReward()).wait();
      assert.equal(await token.balanceOf(alice.address), ethers.parseEther("0.125"));
      assert.equal(await dividends.outstandingRewardLiability(), ethers.parseEther("1.375"));

      await advanceTime(60 * 24 * 60 * 60);
      await (await dividends.connect(alice).claimMonthlyReward()).wait();
      assert.equal(await token.balanceOf(alice.address), ethers.parseEther("0.375"));
      await assert.rejects(dividends.connect(alice).withdrawPrincipal(), /Dividend stake is locked/);

      await advanceTime(275 * 24 * 60 * 60);
      await (await dividends.connect(alice).claimMonthlyReward()).wait();
      assert.equal(await token.balanceOf(alice.address), ethers.parseEther("1.5"));
      assert.equal(await dividends.outstandingRewardLiability(), 0n);
      await (await dividends.connect(alice).withdrawPrincipal()).wait();
      assert.equal(await token.balanceOf(alice.address), ethers.parseEther("11.5"));
      const position = await dividends.positions(alice.address);
      assert.equal(position.monthsClaimed, 12n);
      assert.equal(position.principalWithdrawn, true);
    });

    it("requires InvestorSale participation and checks P2E reward funding before accepting a lock", async function () {
      const { admin, alice, outsider, token, p2e } = await deploySharedP2E();
      const sale = await (
        await ethers.getContractFactory("MockInvestorEligibility")
      ).deploy();
      await sale.waitForDeployment();
      const dividends = await (
        await ethers.getContractFactory("InvestorDividend")
      ).deploy(
        await token.getAddress(),
        await p2e.getAddress(),
        await sale.getAddress(),
        admin.address,
      );
      await dividends.waitForDeployment();
      await (await token.mint(alice.address, ethers.parseEther("10"))).wait();
      await (await token.connect(alice).approve(await dividends.getAddress(), ethers.parseEther("10"))).wait();
      await assert.rejects(
        dividends.connect(alice).stakeDividend(ethers.parseEther("10")),
        /InvestorSale participant only/,
      );
      await (await sale.setInvestor(alice.address, true)).wait();
      await assert.rejects(
        dividends.connect(alice).stakeDividend(ethers.parseEther("10")),
        /P2E balance below dividend commitments/,
      );
      await assert.rejects(
        dividends.connect(outsider).stakeDividend(ethers.parseEther("1")),
        /InvestorSale participant only/,
      );
    });
  });
});
