import { ethers } from "hardhat";
import { expect } from "chai";
import { PositionMarket, EVALocker, EverValueCoin, Token, EVABurnVault } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86400;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

const WEIGHTS = [1n, 2n, 4n, 0n];
const DURATIONS = [10 * DAY, 20 * DAY, 40 * DAY, 80 * DAY];
const CURVES = [0, 0, 0, 0];
const TRANSFERABLES = [true, true, true, false]; // tier 3 soulbound
const MIN_LIST = E18("10");

describe("PositionMarket", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let coreVault: EVABurnVault;
  let locker: EVALocker;
  let market: PositionMarket;

  let owner: SignerWithAddress;
  let seller: SignerWithAddress;
  let buyer: SignerWithAddress;

  beforeEach(async function () {
    [owner, seller, buyer] = await ethers.getSigners();

    eva = await (await ethers.getContractFactory("EverValueCoin")).deploy();
    wbtc = await (await ethers.getContractFactory("Token")).deploy(E8("21000000"), "WBTC", "WBTC", 8);
    coreVault = await (await ethers.getContractFactory("EVABurnVault")).deploy(
      await eva.getAddress(),
      await wbtc.getAddress()
    );
    await wbtc.transfer(await coreVault.getAddress(), E8("1000"));
    locker = await (await ethers.getContractFactory("EVALocker")).deploy(
      await eva.getAddress(),
      await wbtc.getAddress(),
      await coreVault.getAddress(),
      WEIGHTS,
      DURATIONS,
      CURVES,
      TRANSFERABLES
    );
    await locker.setDistributor(owner.address);
    await wbtc.approve(await locker.getAddress(), ethers.MaxUint256);

    market = await (await ethers.getContractFactory("PositionMarket")).deploy(
      await locker.getAddress(),
      await wbtc.getAddress(),
      MIN_LIST
    );

    // seller funds: EVA to lock
    await eva.transfer(seller.address, E18("10000"));
    await eva.connect(seller).approve(await locker.getAddress(), ethers.MaxUint256);
    // buyer funds: WBTC to pay, approved to the market
    await wbtc.transfer(buyer.address, E8("100"));
    await wbtc.connect(buyer).approve(await market.getAddress(), ethers.MaxUint256);
    // seller approves the market to move their positions
    await locker.connect(seller).setApprovalForAll(await market.getAddress(), true);
  });

  async function sellerLocks(tier: number, amount: bigint): Promise<number> {
    await locker.connect(seller).lock(tier, amount);
    return Number((await locker.nextPositionId()) - 1n);
  }

  describe("list", () => {
    it("lists a position and tracks it on-chain", async () => {
      const id = await sellerLocks(0, E18("100"));
      await market.connect(seller).list(id, E8("0.5"));

      const l = await market.listings(id);
      expect(l.seller).to.equal(seller.address);
      expect(l.price).to.equal(E8("0.5"));
      expect(await market.activeListingCount()).to.equal(1);
      expect((await market.getActiveListingsDetailed()).ids.map((x) => Number(x))).to.deep.equal([id]);
    });

    it("rejects positions below the minimum size", async () => {
      const id = await sellerLocks(0, E18("9")); // < 10 EVA
      await expect(market.connect(seller).list(id, E8("0.5"))).to.be.revertedWith("position below min size");
    });

    it("rejects soulbound tiers", async () => {
      const id = await sellerLocks(3, E18("100")); // tier 3 soulbound
      await expect(market.connect(seller).list(id, E8("0.5"))).to.be.revertedWith("tier soulbound");
    });

    it("rejects non-owner and zero price", async () => {
      const id = await sellerLocks(0, E18("100"));
      await expect(market.connect(buyer).list(id, E8("0.5"))).to.be.revertedWith("not owner");
      await expect(market.connect(seller).list(id, 0)).to.be.revertedWith("price is zero");
    });

    it("re-listing the same position updates it in place (no duplicate entry)", async () => {
      const id = await sellerLocks(0, E18("100"));
      await market.connect(seller).list(id, E8("0.5"));
      await market.connect(seller).list(id, E8("0.6")); // re-list, not a revert
      expect(await market.activeListingCount()).to.equal(1); // not duplicated
      expect((await market.listings(id)).price).to.equal(E8("0.6"));
    });
  });

  describe("updatePrice & cancel", () => {
    it("seller can re-price", async () => {
      const id = await sellerLocks(0, E18("100"));
      await market.connect(seller).list(id, E8("0.5"));
      await market.connect(seller).updatePrice(id, E8("0.7"));
      expect((await market.listings(id)).price).to.equal(E8("0.7"));
    });

    it("seller can cancel and it leaves the active set", async () => {
      const id = await sellerLocks(0, E18("100"));
      await market.connect(seller).list(id, E8("0.5"));
      await market.connect(seller).cancel(id);
      expect(await market.activeListingCount()).to.equal(0);
      expect((await market.listings(id)).seller).to.equal(ethers.ZeroAddress);
    });

    it("only the seller can re-price or cancel", async () => {
      const id = await sellerLocks(0, E18("100"));
      await market.connect(seller).list(id, E8("0.5"));
      await expect(market.connect(buyer).updatePrice(id, E8("1"))).to.be.revertedWith("not seller");
      await expect(market.connect(buyer).cancel(id)).to.be.revertedWith("not seller");
    });
  });

  describe("buy", () => {
    it("transfers the NFT to the buyer and WBTC to the seller", async () => {
      const id = await sellerLocks(0, E18("100"));
      await market.connect(seller).list(id, E8("0.5"));

      const sellerWbtc = await wbtc.balanceOf(seller.address);
      await market.connect(buyer).buy(id, E8("0.5"));

      expect(await locker.ownerOf(id)).to.equal(buyer.address);
      expect(await wbtc.balanceOf(seller.address)).to.equal(sellerWbtc + E8("0.5"));
      expect(await market.activeListingCount()).to.equal(0);
      expect((await market.listings(id)).seller).to.equal(ethers.ZeroAddress);
    });

    it("settles the position's accrued rewards to the seller on sale", async () => {
      const id = await sellerLocks(0, E18("100"));
      await locker.distribute(E8("3")); // position accrues 3 WBTC to the seller
      await market.connect(seller).list(id, E8("0.5"));

      const sellerWbtc = await wbtc.balanceOf(seller.address);
      await market.connect(buyer).buy(id, E8("0.5"));
      // seller gets sale price (0.5) + settled rewards (3)
      expect(await wbtc.balanceOf(seller.address)).to.equal(sellerWbtc + E8("3.5"));
      // buyer owns a clean position
      expect(await locker.pending(id)).to.equal(0);
    });

    it("reverts on an unlisted token", async () => {
      await expect(market.connect(buyer).buy(999, E8("1"))).to.be.revertedWith("not buyable");
    });

    it("reverts if the seller no longer owns the position (stale listing)", async () => {
      const id = await sellerLocks(0, E18("100"));
      await market.connect(seller).list(id, E8("0.5"));
      // seller transfers the NFT away outside the market
      await locker.connect(seller).transferFrom(seller.address, owner.address, id);
      await expect(market.connect(buyer).buy(id, E8("0.5"))).to.be.revertedWith("not buyable");
    });

    it("is atomic: buyer keeps WBTC if the market is not approved", async () => {
      const id = await sellerLocks(0, E18("100"));
      await market.connect(seller).list(id, E8("0.5"));
      await locker.connect(seller).setApprovalForAll(await market.getAddress(), false);

      const buyerWbtc = await wbtc.balanceOf(buyer.address);
      await expect(market.connect(buyer).buy(id, E8("0.5"))).to.be.reverted; // NFT transfer fails -> whole tx reverts
      expect(await wbtc.balanceOf(buyer.address)).to.equal(buyerWbtc); // refunded by revert
    });
  });

  describe("buy price bound (maxPrice)", () => {
    it("reverts when the seller raised the ask above the buyer's maxPrice", async () => {
      const id = await sellerLocks(0, E18("100"));
      await market.connect(seller).list(id, E8("0.5"));
      await market.connect(seller).updatePrice(id, E8("50"));

      const buyerWbtc = await wbtc.balanceOf(buyer.address);
      await expect(market.connect(buyer).buy(id, E8("0.5"))).to.be.revertedWith("price above max");
      expect(await wbtc.balanceOf(buyer.address)).to.equal(buyerWbtc); // nothing pulled
      expect(await locker.ownerOf(id)).to.equal(seller.address);
      expect(await market.isFulfillable(id)).to.equal(true); // listing itself is still live
    });

    it("succeeds when maxPrice equals the stored ask", async () => {
      const id = await sellerLocks(0, E18("100"));
      await market.connect(seller).list(id, E8("0.5"));
      await expect(market.connect(buyer).buy(id, E8("0.5"))).to.not.be.reverted;
      expect(await locker.ownerOf(id)).to.equal(buyer.address);
    });

    it("pays the lower stored ask when the seller reduced the price below maxPrice", async () => {
      const id = await sellerLocks(0, E18("100"));
      await market.connect(seller).list(id, E8("0.5"));
      await market.connect(seller).updatePrice(id, E8("0.3"));

      const buyerWbtc = await wbtc.balanceOf(buyer.address);
      const sellerWbtc = await wbtc.balanceOf(seller.address);
      await expect(market.connect(buyer).buy(id, E8("0.5")))
        .to.emit(market, "Sold")
        .withArgs(id, seller.address, buyer.address, E8("0.3"));
      expect(await wbtc.balanceOf(buyer.address)).to.equal(buyerWbtc - E8("0.3"));
      expect(await wbtc.balanceOf(seller.address)).to.equal(sellerWbtc + E8("0.3"));
    });

    it("blocks the audit scenario: list + updatePrice in the same block, buy at the quoted price", async () => {
      const id = await sellerLocks(0, E18("100"));

      // Seller lists cheap and raises the ask in the same block (the buyer has unlimited approval).
      // Explicit nonces + identical gas price make the in-block ordering deterministic (list first).
      const nonce = await ethers.provider.getTransactionCount(seller.address);
      const gas = { gasLimit: 300_000, gasPrice: ethers.parseUnits("10", "gwei") };
      await ethers.provider.send("evm_setAutomine", [false]);
      const tx1 = await market.connect(seller).list(id, E8("0.5"), { ...gas, nonce });
      const tx2 = await market.connect(seller).updatePrice(id, E8("90"), { ...gas, nonce: nonce + 1 });
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_setAutomine", [true]);
      const [r1, r2] = await Promise.all([tx1.wait(), tx2.wait()]);
      expect(r1!.blockNumber).to.equal(r2!.blockNumber); // same block
      expect(r1!.status).to.equal(1);
      expect(r2!.status).to.equal(1);
      expect((await market.listings(id)).price).to.equal(E8("90"));

      // Buyer submits with the price they were quoted: bounded, so the raised ask cannot be pulled.
      const buyerWbtc = await wbtc.balanceOf(buyer.address);
      await expect(market.connect(buyer).buy(id, E8("0.5"))).to.be.revertedWith("price above max");
      expect(await wbtc.balanceOf(buyer.address)).to.equal(buyerWbtc);
    });

    it("re-listing at a higher price is bounded the same way", async () => {
      const id = await sellerLocks(0, E18("100"));
      await market.connect(seller).list(id, E8("0.5"));
      await market.connect(seller).list(id, E8("60")); // overwrite path, not updatePrice
      await expect(market.connect(buyer).buy(id, E8("0.5"))).to.be.revertedWith("price above max");
    });
  });

  describe("enumeration integrity", () => {
    it("swap-removes from the middle correctly", async () => {
      const a = await sellerLocks(0, E18("100"));
      const b = await sellerLocks(0, E18("100"));
      const c = await sellerLocks(0, E18("100"));
      await market.connect(seller).list(a, E8("0.1"));
      await market.connect(seller).list(b, E8("0.2"));
      await market.connect(seller).list(c, E8("0.3"));
      expect(await market.activeListingCount()).to.equal(3);

      await market.connect(seller).cancel(b); // remove the middle one
      const ids = (await market.getActiveListingsDetailed()).ids.map((x) => Number(x)).sort((x, y) => x - y);
      expect(ids).to.deep.equal([a, c]);

      // detailed view stays consistent
      const detailed = await market.getActiveListingsDetailed();
      expect(detailed.ids.length).to.equal(2);
    });
  });

  describe("admin", () => {
    it("only owner can set the minimum, and it takes effect", async () => {
      await expect(market.connect(seller).setMinListAmount(E18("1"))).to.be.revertedWithCustomError(
        market,
        "OwnableUnauthorizedAccount"
      );
      await market.setMinListAmount(E18("5"));
      expect(await market.minListAmount()).to.equal(E18("5"));
      const id = await sellerLocks(0, E18("6")); // now allowed at 5 min
      await expect(market.connect(seller).list(id, E8("0.5"))).to.not.be.reverted;
    });
  });
});
