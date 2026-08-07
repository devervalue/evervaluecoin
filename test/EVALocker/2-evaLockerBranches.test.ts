import { ethers } from "hardhat";
import { expect } from "chai";
import { EVALocker, EverValueCoin, Token, EVABurnVault } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86400;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

const WEIGHTS = [1n, 2n, 4n, 0n];
const DURATIONS = [10 * DAY, 20 * DAY, 40 * DAY, 80 * DAY];
const CURVES = [0, 0, 0, 0];
const TRANSFERABLES = [true, true, true, false];

async function increase(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}
async function now(): Promise<number> {
  return (await ethers.provider.getBlock("latest"))!.timestamp;
}

describe("EVALocker - remaining branch coverage", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let coreVault: EVABurnVault;
  let locker: EVALocker;
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
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
    await locker.setDistributor(owner.address);
    await wbtc.approve(await locker.getAddress(), ethers.MaxUint256);
    await eva.transfer(alice.address, E18("1000"));
    await eva.connect(alice).approve(await locker.getAddress(), ethers.MaxUint256);
  });

  // ---- constructor reverts (lines 148, 155) ----
  it("constructor reverts on empty tier arrays", async () => {
    const F = await ethers.getContractFactory("EVALocker");
    await expect(
      F.deploy(await eva.getAddress(), await wbtc.getAddress(), await coreVault.getAddress(), [], [], [], [])
    ).to.be.revertedWith("no tiers");
  });

  it("constructor reverts on zero duration", async () => {
    const F = await ethers.getContractFactory("EVALocker");
    await expect(
      F.deploy(await eva.getAddress(), await wbtc.getAddress(), await coreVault.getAddress(), [1], [0], [0], [true])
    ).to.be.revertedWith("duration zero");
  });

  // ---- withdraw not-owner (line 220) ----
  it("withdraw reverts for non-owner", async () => {
    await locker.connect(alice).lock(0, E18("100"));
    await increase(11 * DAY);
    await expect(locker.connect(bob).withdraw(0)).to.be.revertedWith("not owner");
  });

  // ---- proposeRenewal OR operand sub-branches (line 327) ----
  it("proposeRenewal accepts each single non-empty field (OR operands)", async () => {
    await locker.connect(alice).lock(0, E18("100")); // id 0
    await locker.connect(alice).lock(0, E18("100")); // id 1
    await locker.connect(alice).lock(0, E18("100")); // id 2
    const future = (await now()) + 10000;
    // only extraDuration
    await locker.proposeRenewal(0, 10 * DAY, true, 0, 0, future);
    // only rewardEva (extra = 0)
    await eva.approve(await locker.getAddress(), E18("10"));
    await locker.proposeRenewal(1, 0, true, E18("10"), 0, future);
    // only rewardWbtc (extra = 0, eva = 0)
    await wbtc.approve(await locker.getAddress(), E8("1"));
    await locker.proposeRenewal(2, 0, true, 0, E8("1"), future);
    expect((await locker.offers(0)).active).to.equal(true);
    expect((await locker.offers(1)).active).to.equal(true);
    expect((await locker.offers(2)).active).to.equal(true);
  });

  // ---- cancelRenewal: non-owner (351) + zero-reward branches (356, 360) ----
  it("cancelRenewal reverts for non-owner", async () => {
    await locker.connect(alice).lock(0, E18("100"));
    await locker.proposeRenewal(0, 10 * DAY, true, 0, 0, (await now()) + 10000);
    await expect(locker.connect(alice).cancelRenewal(0)).to.be.revertedWithCustomError(
      locker,
      "OwnableUnauthorizedAccount"
    );
  });

  it("cancelRenewal works when there is no reward escrow", async () => {
    await locker.connect(alice).lock(0, E18("100"));
    await locker.proposeRenewal(0, 10 * DAY, true, 0, 0, (await now()) + 10000); // no rewards
    await locker.cancelRenewal(0);
    expect((await locker.offers(0)).active).to.equal(false);
  });

  // ---- acceptRenewal "must extend future" (line 385) ----
  it("acceptRenewal reverts if keepRemaining cannot reach the future", async () => {
    await locker.connect(alice).lock(0, E18("100")); // ends in 10d
    await increase(100 * DAY); // long matured
    // keepRemaining: newEnd = oldEnd + 1d, still far in the past
    await locker.proposeRenewal(0, 1 * DAY, true, 0, 0, (await now()) + 10000);
    await expect(locker.connect(alice).acceptRenewal(0)).to.be.revertedWith("must extend future");
  });

  // ---- project-tier (weight 0) renewal: newShares == 0 (402) + _removeShares shares==0 (505) ----
  it("renews a project-tier (weight 0) position with zero shares", async () => {
    await locker.connect(alice).lock(3, E18("100")); // weight 0
    await locker.proposeRenewal(0, 10 * DAY, true, 0, 0, (await now()) + 10000);
    await locker.connect(alice).acceptRenewal(0);
    expect((await locker.positions(0)).shares).to.equal(0);
    expect(await locker.totalShares()).to.equal(0);
  });

  it("early-exits a project-tier (weight 0) position", async () => {
    await locker.connect(alice).lock(3, E18("100")); // weight 0, shares 0
    await increase(40 * DAY); // half of 80d
    const before = await eva.balanceOf(alice.address);
    await locker.connect(alice).earlyExit(0); // _removeShares hits shares==0 early return
    expect((await eva.balanceOf(alice.address)) - before).to.be.closeTo(E18("50"), E18("0.1"));
  });

  // ---- admin onlyOwner guards (428, 434, 447, 456) ----
  it("admin setters revert for non-owner", async () => {
    await expect(locker.connect(alice).setTierEnabled(0, false)).to.be.revertedWithCustomError(
      locker,
      "OwnableUnauthorizedAccount"
    );
    await expect(locker.connect(alice).setDistributor(bob.address)).to.be.revertedWithCustomError(
      locker,
      "OwnableUnauthorizedAccount"
    );
    await expect(locker.connect(alice).sweepWbtc(bob.address)).to.be.revertedWithCustomError(
      locker,
      "OwnableUnauthorizedAccount"
    );
    await expect(locker.connect(alice).sweepEva(bob.address)).to.be.revertedWithCustomError(
      locker,
      "OwnableUnauthorizedAccount"
    );
  });

  // ---- sweep zero-address guards (448, 457) ----
  it("sweeps revert on zero recipient", async () => {
    await expect(locker.sweepWbtc(ethers.ZeroAddress)).to.be.revertedWith("zero address");
    await expect(locker.sweepEva(ethers.ZeroAddress)).to.be.revertedWith("zero address");
  });
});
