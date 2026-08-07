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
const TRANSFERABLES = [true, true, true, false];
const MIN_LIST = E18("10");

async function now(): Promise<number> {
  return (await ethers.provider.getBlock("latest"))!.timestamp;
}

describe("PositionMarket - staleness, prune & fulfillability", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let coreVault: EVABurnVault;
  let locker: EVALocker;
  let market: PositionMarket;
  let owner: SignerWithAddress; // locker owner (can propose renewals) + distributor
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

    await eva.transfer(seller.address, E18("10000"));
    await eva.connect(seller).approve(await locker.getAddress(), ethers.MaxUint256);
    await wbtc.transfer(buyer.address, E8("100"));
    await wbtc.connect(buyer).approve(await market.getAddress(), ethers.MaxUint256);
    await locker.connect(seller).setApprovalForAll(await market.getAddress(), true);
  });

  async function sellerLocksAndLists(price = E8("0.5")): Promise<number> {
    await locker.connect(seller).lock(0, E18("100"));
    const id = Number((await locker.nextPositionId()) - 1n);
    await market.connect(seller).list(id, price);
    return id;
  }

  describe("overwrite-on-list (no lockout)", () => {
    it("a new owner can list a position that still has a prior owner's stale entry", async () => {
      const id = await sellerLocksAndLists();
      // seller transfers the position to buyer directly (outside the market)
      await locker.connect(seller).transferFrom(seller.address, buyer.address, id);
      expect(await market.isFulfillable(id)).to.equal(false); // stale (seller no longer owns)

      // buyer (new owner) can list it, overwriting the stale entry
      await locker.connect(buyer).setApprovalForAll(await market.getAddress(), true);
      await market.connect(buyer).list(id, E8("0.7"));
      expect((await market.listings(id)).seller).to.equal(buyer.address);
      expect(await market.activeListingCount()).to.equal(1); // not duplicated
      expect(await market.isFulfillable(id)).to.equal(true);
    });
  });

  describe("isFulfillable", () => {
    it("true when fresh, false after transfer / burn / renewal", async () => {
      // fresh
      const id1 = await sellerLocksAndLists();
      expect(await market.isFulfillable(id1)).to.equal(true);

      // transferred away
      const id2 = await sellerLocksAndLists();
      await locker.connect(seller).transferFrom(seller.address, buyer.address, id2);
      expect(await market.isFulfillable(id2)).to.equal(false);

      // burned (early-exit)
      const id3 = await sellerLocksAndLists();
      await locker.connect(seller).earlyExit(id3);
      expect(await market.isFulfillable(id3)).to.equal(false);

      // renewed since listing
      const id4 = await sellerLocksAndLists();
      await locker.proposeRenewal(id4, 10 * DAY, true, 0, 0, (await now()) + 1000);
      await locker.connect(seller).acceptRenewal(id4);
      expect(await market.isFulfillable(id4)).to.equal(false);

      // unlisted
      expect(await market.isFulfillable(99999)).to.equal(false);
    });

    it("false when the seller has revoked the market's NFT approval", async () => {
      const id = await sellerLocksAndLists();
      expect(await market.isFulfillable(id)).to.equal(true);
      await locker.connect(seller).setApprovalForAll(await market.getAddress(), false);
      expect(await market.isFulfillable(id)).to.equal(false);
      // and it becomes prunable
      await market.pruneStale(id);
      expect(await market.activeListingCount()).to.equal(0);
    });
  });

  describe("renewal invalidates the listing", () => {
    it("buy reverts after a renewal, and the seller can re-list to revive it", async () => {
      const id = await sellerLocksAndLists();
      await locker.proposeRenewal(id, 10 * DAY, true, 0, 0, (await now()) + 1000);
      await locker.connect(seller).acceptRenewal(id);

      await expect(market.connect(buyer).buy(id)).to.be.revertedWith("not buyable");

      // seller re-lists -> re-snapshots startTime -> buyable again
      await market.connect(seller).list(id, E8("0.5"));
      expect(await market.isFulfillable(id)).to.equal(true);
      await expect(market.connect(buyer).buy(id)).to.not.be.reverted;
      expect(await locker.ownerOf(id)).to.equal(buyer.address);
    });
  });

  describe("pruneStale", () => {
    it("anyone can prune a transferred-away listing", async () => {
      const id = await sellerLocksAndLists();
      await locker.connect(seller).transferFrom(seller.address, buyer.address, id);
      await market.connect(buyer).pruneStale(id); // buyer (or anyone) prunes
      expect(await market.activeListingCount()).to.equal(0);
    });

    it("anyone can prune a burned-position listing", async () => {
      const id = await sellerLocksAndLists();
      await locker.connect(seller).earlyExit(id);
      await market.connect(owner).pruneStale(id);
      expect(await market.activeListingCount()).to.equal(0);
    });

    it("anyone can prune a renewed listing", async () => {
      const id = await sellerLocksAndLists();
      await locker.proposeRenewal(id, 10 * DAY, true, 0, 0, (await now()) + 1000);
      await locker.connect(seller).acceptRenewal(id);
      await market.connect(buyer).pruneStale(id);
      expect(await market.activeListingCount()).to.equal(0);
    });

    it("reverts when the listing is still valid or not listed", async () => {
      const id = await sellerLocksAndLists();
      await expect(market.pruneStale(id)).to.be.revertedWith("listing still valid");
      await expect(market.pruneStale(99999)).to.be.revertedWith("not listed");
    });
  });

  describe("getActiveListingsDetailed validity flags", () => {
    it("flags valid vs stale entries for the client to filter", async () => {
      const good = await sellerLocksAndLists();
      const stale = await sellerLocksAndLists();
      await locker.connect(seller).transferFrom(seller.address, buyer.address, stale);

      const d = await market.getActiveListingsDetailed();
      const map = new Map<number, boolean>();
      d.ids.forEach((x, i) => map.set(Number(x), d.valid[i]));
      expect(map.get(good)).to.equal(true);
      expect(map.get(stale)).to.equal(false);
    });
  });
});
