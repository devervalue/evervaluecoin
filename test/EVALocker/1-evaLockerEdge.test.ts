import { ethers } from "hardhat";
import { expect } from "chai";
import { EVALocker, EverValueCoin, Token, EVABurnVault } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86400;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

const LINEAR = 0;
const QUADRATIC = 1;
const SQRT = 2;

const WEIGHTS = [1n, 2n, 4n, 0n];
const DURATIONS = [10 * DAY, 20 * DAY, 40 * DAY, 80 * DAY];
const CURVES = [LINEAR, LINEAR, LINEAR, LINEAR];
const TRANSFERABLES = [true, true, true, false];

async function increase(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}
async function now(): Promise<number> {
  return (await ethers.provider.getBlock("latest"))!.timestamp;
}

describe("EVALocker - edge cases & branches", function () {
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
    await eva.transfer(bob.address, E18("1000"));
    await eva.connect(alice).approve(await locker.getAddress(), ethers.MaxUint256);
    await eva.connect(bob).approve(await locker.getAddress(), ethers.MaxUint256);
  });

  describe("early-exit curves", () => {
    it("QUADRATIC keeps ~25% at the midpoint", async () => {
      await locker.setTierCurve(0, QUADRATIC);
      await locker.connect(alice).lock(0, E18("100"));
      await increase(5 * DAY); // f = 0.5 -> kept = 0.25
      const before = await eva.balanceOf(alice.address);
      await locker.connect(alice).earlyExit(0);
      const gained = (await eva.balanceOf(alice.address)) - before;
      expect(gained).to.be.closeTo(E18("25"), E18("0.1"));
    });

    it("SQRT keeps ~70.7% at the midpoint", async () => {
      await locker.setTierCurve(0, SQRT);
      await locker.connect(alice).lock(0, E18("100"));
      await increase(5 * DAY); // f = 0.5 -> kept = sqrt(0.5) ~ 0.7071
      const before = await eva.balanceOf(alice.address);
      await locker.connect(alice).earlyExit(0);
      const gained = (await eva.balanceOf(alice.address)) - before;
      expect(gained).to.be.closeTo(E18("70.71"), E18("0.2"));
    });

    it("setTierCurve only affects future locks (snapshot)", async () => {
      await locker.connect(alice).lock(0, E18("100")); // snapshot LINEAR
      await locker.setTierCurve(0, QUADRATIC); // change after
      await increase(5 * DAY);
      const before = await eva.balanceOf(alice.address);
      await locker.connect(alice).earlyExit(0);
      const gained = (await eva.balanceOf(alice.address)) - before;
      // still LINEAR -> ~50, not QUADRATIC's 25
      expect(gained).to.be.closeTo(E18("50"), E18("0.1"));
    });

    it("cannot earlyExit a matured position", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await increase(11 * DAY);
      await expect(locker.connect(alice).earlyExit(0)).to.be.revertedWith("matured; use withdraw");
    });

    it("earlyExit reverts for non-owner", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await expect(locker.connect(bob).earlyExit(0)).to.be.revertedWith("not owner");
    });
  });

  describe("input validations", () => {
    it("lock rejects zero amount", async () => {
      await expect(locker.connect(alice).lock(0, 0)).to.be.revertedWith("amount zero");
    });

    it("distribute rejects zero amount", async () => {
      await expect(locker.distribute(0)).to.be.revertedWith("amount zero");
    });

    it("setDistributor rejects zero address", async () => {
      await expect(locker.setDistributor(ethers.ZeroAddress)).to.be.revertedWith("zero address");
    });

    it("non-owner cannot call admin setters", async () => {
      await expect(locker.connect(alice).setLocksPaused(true)).to.be.revertedWithCustomError(
        locker,
        "OwnableUnauthorizedAccount"
      );
      await expect(locker.connect(alice).setTierCurve(0, QUADRATIC)).to.be.revertedWithCustomError(
        locker,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("renewal validations", () => {
    it("proposeRenewal rejects unknown position / empty offer / bad expiry / duplicate", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      const future = (await now()) + 1000;
      await expect(locker.proposeRenewal(999, 10 * DAY, true, 0, 0, future)).to.be.revertedWith("no position");
      await expect(locker.proposeRenewal(0, 0, true, 0, 0, future)).to.be.revertedWith("empty offer");
      await expect(locker.proposeRenewal(0, 10 * DAY, true, 0, 0, (await now()) - 1)).to.be.revertedWith(
        "bad expiry"
      );
      await locker.proposeRenewal(0, 10 * DAY, true, 0, 0, future);
      await expect(locker.proposeRenewal(0, 10 * DAY, true, 0, 0, future)).to.be.revertedWith("offer exists");
    });

    it("acceptRenewal reverts when no offer or expired", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await expect(locker.connect(alice).acceptRenewal(0)).to.be.revertedWith("no offer");

      await locker.proposeRenewal(0, 10 * DAY, true, 0, 0, (await now()) + 100);
      await increase(200);
      await expect(locker.connect(alice).acceptRenewal(0)).to.be.revertedWith("offer expired");
    });

    it("acceptRenewal with keepRemaining=false resets term from now", async () => {
      await locker.connect(alice).lock(0, E18("100")); // 10d
      await increase(2 * DAY);
      await locker.proposeRenewal(0, 30 * DAY, false, 0, 0, (await now()) + 1000);
      await locker.connect(alice).acceptRenewal(0);
      const pos = await locker.positions(0);
      const t = await now();
      expect(Number(pos.endTime) - t).to.be.closeTo(30 * DAY, 5);
    });

    it("cancelRenewal reverts with no offer", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await expect(locker.cancelRenewal(0)).to.be.revertedWith("no offer");
    });
  });

  describe("views & sweeps", () => {
    it("getPositionIds returns the owner's ids", async () => {
      await locker.connect(alice).lock(0, E18("10"));
      await locker.connect(alice).lock(1, E18("20"));
      const ids = await locker.getPositionIds(alice.address);
      expect(ids.map((x) => Number(x))).to.deep.equal([0, 1]);
    });

    it("getPositionsOf returns a full per-position snapshot", async () => {
      await locker.connect(alice).lock(0, E18("100")); // tier0 w1 -> 100 shares
      await locker.connect(alice).lock(1, E18("50")); // tier1 w2 -> 100 shares; total 200
      await locker.distribute(E8("3")); // 1.5 each
      const list = await locker.getPositionsOf(alice.address);
      expect(list.length).to.equal(2);
      expect(list[0].tierId).to.equal(0);
      expect(list[0].amount).to.equal(E18("100"));
      expect(list[0].transferable).to.equal(true);
      expect(list[0].pending).to.equal(E8("1.5"));
      expect(list[1].tierId).to.equal(1);
      expect(list[1].amount).to.equal(E18("50"));
      expect(list[0].pending + list[1].pending).to.equal(E8("3"));
    });

    it("setBaseURI drives tokenURI and is owner-only", async () => {
      await locker.connect(alice).lock(0, E18("10"));
      await locker.setBaseURI("https://meta.test/pos/");
      expect(await locker.tokenURI(0)).to.equal("https://meta.test/pos/0");
      await expect(locker.connect(alice).setBaseURI("x")).to.be.revertedWithCustomError(
        locker,
        "OwnableUnauthorizedAccount"
      );
    });

    it("pending returns 0 for an unknown/closed position", async () => {
      expect(await locker.pending(12345)).to.equal(0);
    });

    it("sweepEva takes only stray EVA, never locked", async () => {
      await locker.connect(alice).lock(0, E18("100")); // locked
      await eva.transfer(await locker.getAddress(), E18("7")); // stray
      const before = await eva.balanceOf(owner.address);
      await locker.sweepEva(owner.address);
      expect(await eva.balanceOf(owner.address)).to.equal(before + E18("7"));
      // locked EVA still withdrawable
      await increase(11 * DAY);
      const aBefore = await eva.balanceOf(alice.address);
      await locker.connect(alice).withdraw(0);
      expect(await eva.balanceOf(alice.address)).to.equal(aBefore + E18("100"));
    });

    it("sweepWbtc / sweepEva revert when nothing to sweep", async () => {
      await expect(locker.sweepWbtc(owner.address)).to.be.revertedWith("nothing to sweep");
      await expect(locker.sweepEva(owner.address)).to.be.revertedWith("nothing to sweep");
    });
  });

  describe("multi-position accrual for one user", () => {
    it("accrues independently across two positions", async () => {
      await locker.connect(alice).lock(0, E18("100")); // 100 shares
      await locker.connect(alice).lock(1, E18("100")); // 200 shares; total 300
      await locker.distribute(E8("3"));
      expect(await locker.pending(0)).to.equal(E8("1"));
      expect(await locker.pending(1)).to.equal(E8("2"));
    });
  });
});
