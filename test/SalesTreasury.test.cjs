const { strict: assert } = require("node:assert");
const { ethers } = require("hardhat");

describe("Sales treasury routing", function () {
  it("sends InvestorSale native proceeds to the configured treasury", async function () {
    const [owner, buyer, treasury] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockRewardToken")).deploy();
    await token.waitForDeployment();
    const sale = await (
      await ethers.getContractFactory("InvestorSale")
    ).deploy(
      await token.getAddress(),
      await token.getAddress(),
      owner.address,
      Array(5).fill(ethers.parseEther("2")),
    );
    await sale.waitForDeployment();
    await (await sale.setManualPrice(ethers.parseEther("1"))).wait();
    await (await sale.setSalesTreasury(treasury.address)).wait();
    await (await token.mint(await sale.getAddress(), ethers.parseEther("10"))).wait();
    await (await sale.setSaleActive(true)).wait();

    const balanceBefore = await ethers.provider.getBalance(treasury.address);
    await (await sale.connect(buyer).invest(1, 0, { value: ethers.parseEther("2") })).wait();

    assert.equal(
      (await ethers.provider.getBalance(treasury.address)) - balanceBefore,
      ethers.parseEther("2"),
    );
  });

  it("sends Shop SRP proceeds directly to the configured treasury", async function () {
    const [owner, buyer, treasury] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockRewardToken")).deploy();
    await token.waitForDeployment();
    const shop = await (
      await ethers.getContractFactory("SRP_Shop")
    ).deploy(await token.getAddress());
    await shop.waitForDeployment();
    const nft = await (
      await ethers.getContractFactory("SRP_Common")
    ).deploy(await token.getAddress());
    await nft.waitForDeployment();
    await (await nft.setShopContract(await shop.getAddress())).wait();
    await (await shop.setNFTWhitelist(await nft.getAddress(), true)).wait();
    await (await shop.setPrices(ethers.parseEther("2"), 0, 0)).wait();
    await (await shop.setSalesTreasury(treasury.address)).wait();
    await (await nft.mintNFT(buyer.address)).wait();
    await (await token.mint(buyer.address, ethers.parseEther("2"))).wait();
    await (await token.connect(buyer).approve(await shop.getAddress(), ethers.parseEther("2"))).wait();

    await (await shop.connect(buyer).buyStamina(await nft.getAddress(), 1, 1)).wait();

    assert.equal(await token.balanceOf(treasury.address), ethers.parseEther("2"));
    assert.equal(await token.balanceOf(await shop.getAddress()), 0n);
    assert.equal(await shop.owner(), owner.address);
  });

  it("routes NFT mint payments and all resale proceeds to the treasury", async function () {
    const [owner, seller, buyer, treasury] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockRewardToken")).deploy();
    await token.waitForDeployment();
    const nft = await (
      await ethers.getContractFactory("SRP_Common")
    ).deploy(await token.getAddress());
    await nft.waitForDeployment();
    await (await nft.setSalesTreasury(treasury.address)).wait();
    await (await nft.setPublicPrice(ethers.parseEther("3"))).wait();
    await (await nft.setMintPhases(true, true)).wait();

    await (await token.mint(buyer.address, ethers.parseEther("3"))).wait();
    await (await token.connect(buyer).approve(await nft.getAddress(), ethers.parseEther("3"))).wait();
    await (await nft.connect(buyer).publicMint(1)).wait();
    assert.equal(await token.balanceOf(treasury.address), ethers.parseEther("3"));

    await (await nft.mintNFT(seller.address)).wait();
    await (await nft.connect(seller).listNFTForSale(2, ethers.parseEther("2"))).wait();
    const nativeBefore = await ethers.provider.getBalance(treasury.address);
    await (await nft.connect(buyer).tradeNFT(2, { value: ethers.parseEther("2") })).wait();
    assert.equal(
      (await ethers.provider.getBalance(treasury.address)) - nativeBefore,
      ethers.parseEther("2"),
    );
    assert.equal(await nft.seriesVault(), 0n);
    assert.equal(await ethers.provider.getBalance(await nft.getAddress()), 0n);
    assert.equal(await nft.ownerOf(2), buyer.address);
    assert.equal(await nft.owner(), owner.address);
  });
});
