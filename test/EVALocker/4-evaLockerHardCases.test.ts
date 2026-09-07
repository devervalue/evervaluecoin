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

describe("EVALocker - hard cases", function () {
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
    await eva.transfer(alice.address, E18("100000"));
    await eva.transfer(bob.address, E18("100000"));
    await eva.connect(alice).approve(await locker.getAddress(), ethers.MaxUint256);
    await eva.connect(bob).approve(await locker.getAddress(), ethers.MaxUint256);
  });

  // 1. Value conservation: kept + burned == amount EXACTLY, and the burn actually reduces supply.
  describe("value conservation on early exit", () => {
    for (const [name, curve] of [
      ["LINEAR", LINEAR],
      ["QUADRATIC", QUADRATIC],
      ["SQRT", SQRT],
    ] as const) {
      for (const days of [1, 3, 7, 9]) {
        it(`${name} @ ${days}d: kept + burned == amount, supply drops by burned`, async () => {
          await locker.setTierCurve(0, curve);
          await locker.connect(alice).lock(0, E18("100"));
          await increase(days * DAY);

          const supplyBefore = await eva.totalSupply();
          const aliceBefore = await eva.balanceOf(alice.address);
          await locker.connect(alice).earlyExit(0);

          const kept = (await eva.balanceOf(alice.address)) - aliceBefore;
          const burned = supplyBefore - (await eva.totalSupply());
          expect(kept + burned).to.equal(E18("100")); // exact conservation
          expect(burned).to.be.greaterThan(0n);
        });
      }
    }
  });

  // 1b. Zero-sat burn waiver (audit F-2026-19108): the vault reverts when burnEva * B / S floors to 0.
  //     earlyExit must never brick on that; the unredeemable slice is returned as liquid EVA instead.
  describe("early exit when the vault burn would pay zero sats (waiver)", () => {
    // Setup: B = 1000 WBTC = 1e11 sats, S = 21e6 EVA = 21e24 wei -> threshold S/B = 2.1e14 wei (0.00021 EVA).

    it("dust position can exit at t=0 (100% burn slice, unredeemable): full principal returned, nothing burned", async () => {
      const dust = 10n ** 14n; // 0.0001 EVA < S/B, so any burn slice of it redeems to 0 sats
      await locker.connect(alice).lock(0, dust);
      const supplyBefore = await eva.totalSupply();
      const aliceEva = await eva.balanceOf(alice.address);
      const aliceWbtc = await wbtc.balanceOf(alice.address);

      await expect(locker.connect(alice).earlyExit(0))
        .to.emit(locker, "EarlyExited")
        .withArgs(0, alice.address, dust, 0, 0);

      expect(await eva.balanceOf(alice.address)).to.equal(aliceEva + dust);
      expect(await eva.totalSupply()).to.equal(supplyBefore); // no burn happened
      expect(await wbtc.balanceOf(alice.address)).to.equal(aliceWbtc);
      expect(await locker.lockedEvaTotal()).to.equal(0);
      expect(await eva.balanceOf(await locker.getAddress())).to.equal(0); // EVA solvency holds
    });

    it("normal position inside the thin pre-maturity window exits instead of reverting", async () => {
      // 1 EVA, 10-day LINEAR tier: 60s before endTime the burn slice is ~6.9e13 wei < S/B -> vault would revert.
      await locker.connect(alice).lock(0, E18("1"));
      const p = await locker.positions(0);
      const target = Number(p.endTime) - 60;
      await ethers.provider.send("evm_setNextBlockTimestamp", [target]);

      const supplyBefore = await eva.totalSupply();
      const aliceEva = await eva.balanceOf(alice.address);
      await expect(locker.connect(alice).earlyExit(0))
        .to.emit(locker, "EarlyExited")
        .withArgs(0, alice.address, E18("1"), 0, 0);
      expect(await eva.balanceOf(alice.address)).to.equal(aliceEva + E18("1"));
      expect(await eva.totalSupply()).to.equal(supplyBefore);
    });

    it("control: a burn slice that redeems to >0 sats still goes through the vault", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await increase(5 * DAY); // ~50% burn slice = 50 EVA -> clearly > S/B
      const supplyBefore = await eva.totalSupply();
      const aliceWbtc = await wbtc.balanceOf(alice.address);
      const vaultWbtc = await wbtc.balanceOf(await coreVault.getAddress());

      await locker.connect(alice).earlyExit(0);

      const burned = supplyBefore - (await eva.totalSupply());
      expect(burned).to.be.greaterThan(0n);
      const received = (await wbtc.balanceOf(alice.address)) - aliceWbtc;
      expect(received).to.be.greaterThan(0n);
      expect(await wbtc.balanceOf(await coreVault.getAddress())).to.equal(vaultWbtc - received);
    });

    it("the waiver threshold can only shrink: vault ratio B/S is non-decreasing across burns", async () => {
      const vaultAddr = await coreVault.getAddress();
      const ratio = async () =>
        ((await wbtc.balanceOf(vaultAddr)) * 10n ** 36n) / (await eva.totalSupply());
      const r0 = await ratio();
      // Several burns of varying size through the locker's early-exit path.
      for (const amt of ["1000", "12345.678", "0.5", "50000"]) {
        await locker.connect(bob).lock(0, E18(amt));
        await increase(1 * DAY);
        const id = Number((await locker.nextPositionId()) - 1n);
        await locker.connect(bob).earlyExit(id);
        expect(await ratio()).to.be.greaterThanOrEqual(r0);
      }
    });
  });

  // 2a. Two positions in the same expiry epoch: one early-exits, the other is held to maturity.
  it("same-epoch positions: early-exit then held withdrawal keep totalShares consistent", async () => {
    await locker.connect(alice).lock(0, E18("100")); // id 0
    await locker.connect(bob).lock(0, E18("100")); // id 1, same tier/day
    const p0 = await locker.positions(0);
    const p1 = await locker.positions(1);
    expect(p0.expiryEpoch).to.equal(p1.expiryEpoch); // same epoch (sanity)
    expect(await locker.totalShares()).to.equal(E18("200"));

    await increase(5 * DAY);
    await locker.connect(alice).earlyExit(0); // removes 100 shares + decrements the bucket
    expect(await locker.totalShares()).to.equal(E18("100"));

    await increase(6 * DAY); // both past maturity now
    await locker.connect(bob).withdraw(1); // epoch processed -> no double subtract
    expect(await locker.totalShares()).to.equal(0);
  });

  // 2b. Position whose epoch is processed while still BEFORE its exact endTime (the subtle no-op path).
  it("epoch processed before endTime: early-exit still works and shares reconcile", async () => {
    // Align the lock so there is a sub-day window between the epoch boundary and endTime.
    const base = (await now());
    const start = (Math.floor(base / DAY) + 2) * DAY + 50000; // start at +50000s into a future day
    await ethers.provider.send("evm_setNextBlockTimestamp", [start]);
    await locker.connect(alice).lock(0, E18("100")); // 10d; endTime = start + 864000, endTime%DAY = 50000

    const pos = await locker.positions(0);
    const epochStart = Number(pos.expiryEpoch) * DAY;
    expect(epochStart).to.be.lessThan(Number(pos.endTime)); // window exists

    // Distribute early in the expiry epoch (before endTime) -> processes & retires the position.
    await ethers.provider.send("evm_setNextBlockTimestamp", [epochStart + 100]);
    await locker.connect(bob).lock(1, E18("1")); // bob keeps the pool non-empty so distribute applies
    await locker.distribute(E8("1"));
    expect(await locker.lastProcessedEpoch()).to.equal(pos.expiryEpoch);

    // alice is retired (matured at epoch granularity) but block time is still < endTime.
    const t = await now();
    expect(t).to.be.lessThan(Number(pos.endTime));
    // She must use withdraw (contract treats her as matured); earlyExit is blocked only by endTime.
    // Here endTime is still in the future, so earlyExit is allowed and must not double-subtract.
    const before = await eva.balanceOf(alice.address);
    await locker.connect(alice).earlyExit(0);
    expect((await eva.balanceOf(alice.address)) - before).to.be.greaterThan(0n);
    // totalShares should only reflect bob's position now (bob: 1 EVA * tier1 weight 2 = 2 shares).
    expect(await locker.totalShares()).to.equal(E18("2"));
  });

  // 3. Long idle gap then a distribution: matured positions freeze, no revert.
  it("long idle gap: matured positions freeze at the pre-gap rate", async () => {
    await locker.connect(alice).lock(0, E18("100")); // 10d -> 100 shares
    await locker.connect(bob).lock(1, E18("100")); // 20d -> 200 shares
    await locker.distribute(E8("3")); // alice 1, bob 2
    await increase(60 * DAY); // both matured; no interaction for 60 epochs
    await locker.distribute(E8("9")); // processes both epochs -> totalShares 0 -> banks
    expect(await locker.undistributed()).to.equal(E8("9"));
    expect(await locker.pending(0)).to.equal(E8("1")); // frozen
    expect(await locker.pending(1)).to.equal(E8("2")); // frozen
  });

  // 4. Banking then reactivation: banked rewards are released to a reactivated position.
  it("bank-then-reactivate: reactivated position receives previously banked rewards", async () => {
    await locker.connect(alice).lock(0, E18("100")); // 10d
    await locker.distribute(E8("1")); // alice pending 1
    await increase(11 * DAY); // matured
    await locker.distribute(E8("2")); // totalShares 0 -> bank 2
    expect(await locker.undistributed()).to.equal(E8("2"));

    // Renew/reactivate alice for 20 more days.
    await locker.proposeRenewal(0, 20 * DAY, false, 0, 0, (await now()) + 1000);
    const wbtcBefore = await wbtc.balanceOf(alice.address);
    await locker.connect(alice).acceptRenewal(0); // settles the frozen 1 WBTC
    expect(await wbtc.balanceOf(alice.address)).to.equal(wbtcBefore + E8("1"));

    await locker.distribute(E8("1")); // pool = 1 + 2 banked = 3, all to alice
    expect(await locker.undistributed()).to.equal(0);
    expect(await locker.pending(0)).to.equal(E8("3"));
  });

  // 5. Renewal does not leak or double-count rewards.
  it("renewal settles once and accrues fresh afterwards (no double count)", async () => {
    await locker.connect(alice).lock(0, E18("100")); // id0, 100 shares
    await locker.connect(bob).lock(0, E18("100")); // id1, 100 shares
    await locker.distribute(E8("2")); // alice 1, bob 1

    await eva.approve(await locker.getAddress(), E18("100"));
    await locker.proposeRenewal(0, 10 * DAY, true, E18("100"), 0, (await now()) + 1000);
    const aliceWbtcStart = await wbtc.balanceOf(alice.address);
    await locker.connect(alice).acceptRenewal(0); // pays alice's pending 1; shares 100 -> 200
    expect(await wbtc.balanceOf(alice.address)).to.equal(aliceWbtcStart + E8("1"));
    expect(await locker.pending(0)).to.equal(0); // no residual

    await locker.distribute(E8("3")); // total 300: alice(200) 2, bob(100) 1
    expect(await locker.pending(0)).to.equal(E8("2")); // only post-renewal, not the first dist again
    expect(await locker.pending(1)).to.equal(E8("2")); // bob: 1 + 1
  });
});
