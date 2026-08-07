import { ethers } from "hardhat";
import { expect } from "chai";
import { EVALocker, EverValueCoin, Token, EVABurnVault, PositionMarket } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86400;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

const LINEAR = 0;
const WEIGHTS = [1n, 2n, 3n, 4n, 0n];
const DURATIONS = [10 * DAY, 20 * DAY, 40 * DAY, 80 * DAY, 80 * DAY];
const CURVES = [LINEAR, LINEAR, LINEAR, LINEAR, LINEAR];
const TRANSFERABLES = [true, true, true, true, false];

async function increase(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

/**
 * Liveness invariant: nothing the market (or its participants) does can ever block the owner of a
 * position from claiming, transferring, withdrawing or early-exiting. A listing is a revocable,
 * custody-free offer — the owner always wins the race, and the market is left with a stale entry
 * that anyone can prune.
 */
describe("PositionMarket — owner liveness while listed", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let coreVault: EVABurnVault;
  let locker: EVALocker;
  let market: PositionMarket;

  let owner: SignerWithAddress; // admin + distributor
  let seller: SignerWithAddress;
  let buyer: SignerWithAddress;
  let friend: SignerWithAddress;

  let lockerAddr: string;
  let marketAddr: string;

  beforeEach(async function () {
    [owner, seller, buyer, friend] = await ethers.getSigners();

    eva = await (await ethers.getContractFactory("EverValueCoin")).deploy();
    wbtc = await (await ethers.getContractFactory("Token")).deploy(E8("21000000"), "WBTC", "WBTC", 8);
    coreVault = await (await ethers.getContractFactory("EVABurnVault")).deploy(
      await eva.getAddress(),
      await wbtc.getAddress()
    );
    await wbtc.transfer(await coreVault.getAddress(), E8("100"));

    locker = await (await ethers.getContractFactory("EVALocker")).deploy(
      await eva.getAddress(),
      await wbtc.getAddress(),
      await coreVault.getAddress(),
      WEIGHTS,
      DURATIONS,
      CURVES,
      TRANSFERABLES
    );
    lockerAddr = await locker.getAddress();
    await locker.setDistributor(owner.address);
    await wbtc.approve(lockerAddr, ethers.MaxUint256);

    market = await (await ethers.getContractFactory("PositionMarket")).deploy(
      lockerAddr,
      await wbtc.getAddress(),
      E18("1") // min list size
    );
    marketAddr = await market.getAddress();

    await eva.transfer(seller.address, E18("1000"));
    await eva.connect(seller).approve(lockerAddr, ethers.MaxUint256);
    await wbtc.transfer(buyer.address, E8("10"));
    await wbtc.connect(buyer).approve(marketAddr, ethers.MaxUint256);
  });

  /** Lock 100 EVA in tier 0 for `seller`, list it, approve the market. Returns the position id. */
  async function lockAndList(): Promise<number> {
    await locker.connect(seller).lock(0, E18("100"));
    const id = Number((await locker.nextPositionId()) - 1n);
    await locker.connect(seller).setApprovalForAll(marketAddr, true);
    await market.connect(seller).list(id, E8("1"));
    expect(await market.isFulfillable(id)).to.equal(true);
    return id;
  }

  it("claiming stays open while listed — and the listing stays valid", async () => {
    const id = await lockAndList();
    await locker.distribute(E8("5"));

    const before = await wbtc.balanceOf(seller.address);
    await locker.connect(seller).claim(id); // must not be blocked by the listing
    expect(await wbtc.balanceOf(seller.address)).to.be.greaterThan(before);

    // claiming does not invalidate the sale offer
    expect(await market.isFulfillable(id)).to.equal(true);
    await market.connect(buyer).buy(id);
    expect(await locker.ownerOf(id)).to.equal(buyer.address);
  });

  it("transferring away wins over the listing; stale entry is prunable and buy reverts", async () => {
    const id = await lockAndList();

    // the owner can always move the NFT — the listing cannot hold it
    await locker.connect(seller).transferFrom(seller.address, friend.address, id);
    expect(await locker.ownerOf(id)).to.equal(friend.address);

    // the market is left with a dead entry: not buyable, prunable by anyone
    expect(await market.isFulfillable(id)).to.equal(false);
    await expect(market.connect(buyer).buy(id)).to.be.revertedWith("not buyable");
    await market.connect(buyer).pruneStale(id);
    expect(await market.activeListingCount()).to.equal(0);
  });

  it("withdraw (maturity) wins over the listing", async () => {
    const id = await lockAndList();
    await increase(10 * DAY + 1);

    const before = await eva.balanceOf(seller.address);
    await locker.connect(seller).withdraw(id); // burns the NFT
    expect((await eva.balanceOf(seller.address)) - before).to.equal(E18("100"));

    expect(await market.isFulfillable(id)).to.equal(false); // ownerOf reverts -> caught -> false
    await expect(market.connect(buyer).buy(id)).to.be.revertedWith("not buyable");
    await market.connect(friend).pruneStale(id);
  });

  it("early exit wins over the listing", async () => {
    const id = await lockAndList();
    await increase(5 * DAY); // mid-term

    await locker.connect(seller).earlyExit(id); // burns the NFT
    expect(await market.isFulfillable(id)).to.equal(false);
    await expect(market.connect(buyer).buy(id)).to.be.revertedWith("not buyable");
  });

  it("revoking approval or cancelling instantly de-fangs the listing", async () => {
    const id = await lockAndList();

    // revoke the operator approval: no longer buyable, position untouched
    await locker.connect(seller).setApprovalForAll(marketAddr, false);
    expect(await market.isFulfillable(id)).to.equal(false);
    await expect(market.connect(buyer).buy(id)).to.be.revertedWith("not buyable");

    // re-approve: buyable again (the offer stands until cancelled)
    await locker.connect(seller).setApprovalForAll(marketAddr, true);
    expect(await market.isFulfillable(id)).to.equal(true);

    // cancel: gone for good, and the seller still owns and controls the position
    await market.connect(seller).cancel(id);
    expect(await market.isFulfillable(id)).to.equal(false);
    expect(await locker.ownerOf(id)).to.equal(seller.address);
    await locker.distribute(E8("1"));
    await locker.connect(seller).claim(id); // still fully operational
  });
});
