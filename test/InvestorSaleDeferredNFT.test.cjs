const { strict: assert } = require("node:assert");
const { ethers } = require("hardhat");

describe("InvestorSale deferred NFT deployment", function () {
  async function deploySale({ activate = true, fund = true } = {}) {
    const [owner, buyer, p2e] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("SurpZeroToken")).deploy();
    await token.waitForDeployment();
    assert.equal(await token.name(), "Standard Units Rupol");
    assert.equal(await token.symbol(), "SRP");
    await (await token.setVaults(owner.address, p2e.address)).wait();
    await (await token.distribute()).wait();

    const investmentAmounts = Array(5).fill(ethers.parseEther("2"));
    const sale = await (
      await ethers.getContractFactory("InvestorSale")
    ).deploy(await token.getAddress(), await token.getAddress(), owner.address, investmentAmounts);
    await sale.waitForDeployment();
    await (await sale.setManualPrice(ethers.parseEther("1"))).wait();
    if (fund) await (await token.transfer(await sale.getAddress(), ethers.parseEther("100"))).wait();
    if (activate) await (await sale.setSaleActive(true)).wait();

    return { owner, buyer, token, sale };
  }

  it("accepts investment and records vouchers before NFT contracts exist", async function () {
    const { buyer, sale } = await deploySale();

    assert.equal(await sale.saleActive(), true);
    assert.equal(await sale.nftContracts(0), ethers.ZeroAddress);
    await (await sale.connect(buyer).invest(1, 0, { value: ethers.parseEther("2") })).wait();

    assert.equal(await sale.voucherBalance(buyer.address, 0, 9900), 1n);
    assert.equal(await sale.voucherBalance(buyer.address, 1, 5000), 1n);
    assert.equal(await sale.reservedVoucherCount(0), 1n);
    assert.equal(await sale.reservedVoucherCount(1), 1n);
    await assert.rejects(sale.connect(buyer).redeemVoucher(0, 9900));
  });

  it("pulls exactly the required SRP from LPManager when an investment is made", async function () {
    const { buyer, token, sale } = await deploySale({ activate: false, fund: false });
    const lpManager = await (
      await ethers.getContractFactory("LPManager")
    ).deploy(await token.getAddress(), await token.getAddress());
    await lpManager.waitForDeployment();
    await (await token.transfer(await lpManager.getAddress(), ethers.parseEther("10"))).wait();
    await (await lpManager.setInvestorSale(await sale.getAddress())).wait();
    await (await sale.setLPManager(await lpManager.getAddress())).wait();
    await (await sale.setSaleActive(true)).wait();

    await (await sale.connect(buyer).invest(1, 0, { value: ethers.parseEther("2") })).wait();

    assert.equal(await token.balanceOf(await lpManager.getAddress()), ethers.parseEther("9"));
    assert.equal(await token.balanceOf(await sale.getAddress()), 0n);
    assert.equal(await token.balanceOf(buyer.address), ethers.parseEther("1"));
    await assert.rejects(
      lpManager.connect(buyer).releaseForInvestorSale(buyer.address, 1),
    );
  });

  it("allows already-recorded vouchers to be redeemed after all NFTs are linked", async function () {
    const { buyer, token, sale } = await deploySale();
    await (await sale.connect(buyer).invest(1, 0, { value: ethers.parseEther("2") })).wait();

    const nftNames = [
      "SRP_Common",
      "SRP_Rare",
      "SRP_Epic",
      "SRP_Flash",
      "SRP_Scattery",
      "SRP_BrushViolet",
    ];
    const nfts = [];
    for (const name of nftNames) {
      const nft = await (await ethers.getContractFactory(name)).deploy(await token.getAddress());
      await nft.waitForDeployment();
      await (await nft.setInvestorContract(await sale.getAddress())).wait();
      await (await nft.setPublicPrice(ethers.parseEther("1"))).wait();
      nfts.push(nft);
    }
    await (await sale.setNFTContracts(await Promise.all(nfts.map((nft) => nft.getAddress())))).wait();

    await (await token.transfer(buyer.address, ethers.parseEther("1"))).wait();
    await (await token.connect(buyer).approve(await nfts[0].getAddress(), ethers.parseEther("1"))).wait();
    await (await token.connect(buyer).approve(await nfts[1].getAddress(), ethers.parseEther("1"))).wait();
    await (await sale.connect(buyer).redeemVoucher(0, 9900)).wait();
    await (await sale.connect(buyer).redeemVoucher(1, 5000)).wait();

    assert.equal(await nfts[0].investorMinted(), 1n);
    assert.equal(await nfts[1].investorMinted(), 1n);
    assert.equal(await sale.voucherBalance(buyer.address, 0, 9900), 0n);
    assert.equal(await sale.voucherBalance(buyer.address, 1, 5000), 0n);
    assert.equal((await nfts[0].ownerOf(1)).toLowerCase(), buyer.address.toLowerCase());
    assert.equal((await nfts[1].ownerOf(1)).toLowerCase(), buyer.address.toLowerCase());
  });
});
