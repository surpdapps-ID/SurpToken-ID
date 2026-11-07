const { strict: assert } = require("node:assert");
const { ethers } = require("hardhat");

describe("InvestorSale investment amounts", function () {
  async function deploySale() {
    const [owner, other] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockRewardToken")).deploy();
    await token.waitForDeployment();
    const initialAmounts = Array.from({ length: 5 }, (_, index) =>
      ethers.parseEther(String(index + 1)),
    );
    const sale = await (
      await ethers.getContractFactory("InvestorSale")
    ).deploy(await token.getAddress(), await token.getAddress(), owner.address, initialAmounts);
    await sale.waitForDeployment();
    return { owner, other, sale };
  }

  it("allows the owner to update all levels while the sale is inactive", async function () {
    const { sale } = await deploySale();
    const newAmounts = Array.from({ length: 5 }, (_, index) =>
      ethers.parseEther(String((index + 1) * 10)),
    );

    await (await sale.setInvestmentAmounts(newAmounts)).wait();

    for (let index = 0; index < newAmounts.length; index++) {
      assert.equal(await sale.investmentAmounts(index), newAmounts[index]);
    }
  });

  it("rejects updates from non-owners, while active, or with a zero amount", async function () {
    const { other, sale } = await deploySale();
    const amounts = Array.from({ length: 5 }, () => ethers.parseEther("1"));

    await assert.rejects(sale.connect(other).setInvestmentAmounts(amounts));
    await assert.rejects(sale.setInvestmentAmounts([amounts[0], 0n, ...amounts.slice(2)]));

    await (await sale.setManualPrice(ethers.parseEther("1"))).wait();
    await (await sale.setSaleActive(true)).wait();
    await assert.rejects(sale.setInvestmentAmounts(amounts));
  });
});
