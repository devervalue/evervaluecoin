import { ethers } from "hardhat";
import { expect } from "chai";
import { EVALocker, EverValueCoin, Token, EVABurnVault } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86400;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

const WEIGHTS = [1n, 2n, 4n, 0n];
const DURATIONS = [10 * DAY, 20 * DAY, 40 * DAY, 80 * DAY];
const CURVES = [0, 1, 2, 0]; // LINEAR, QUADRATIC, SQRT, LINEAR
const TRANSFERABLES = [true, true, true, false];

async function increase(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}
async function now(): Promise<number> {
  return (await ethers.provider.getBlock("latest"))!.timestamp;
}

// Deterministic PRNG so any failure is reproducible.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s % n;
  };
}

describe("EVALocker - stateful invariants (fuzz)", function () {
  this.timeout(300000);

  let eva: EverValueCoin;
  let wbtc: Token;
  let coreVault: EVABurnVault;
  let locker: EVALocker;
  let owner: SignerWithAddress;
  let users: SignerWithAddress[];

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    users = [signers[1], signers[2], signers[3]];

    eva = await (await ethers.getContractFactory("EverValueCoin")).deploy();
    wbtc = await (await ethers.getContractFactory("Token")).deploy(E8("21000000"), "WBTC", "WBTC", 8);
    coreVault = await (await ethers.getContractFactory("EVABurnVault")).deploy(
      await eva.getAddress(),
      await wbtc.getAddress()
    );
    await wbtc.transfer(await coreVault.getAddress(), E8("5000")); // deep backing for early-exit burns
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

    for (const u of users) {
      await eva.transfer(u.address, E18("1000000"));
      await eva.connect(u).approve(await locker.getAddress(), ethers.MaxUint256);
    }
  });

  async function checkInvariants(liveIds: number[]) {
    const lockerAddr = await locker.getAddress();

    // INV1: reward solvency — contract holds at least everything it owes/escrows.
    // (totalUnclaimedRewards already includes banked/undistributed WBTC.)
    const wbtcBal = await wbtc.balanceOf(lockerAddr);
    const reservedWbtc = (await locker.totalUnclaimedRewards()) + (await locker.wbtcEscrow());
    expect(wbtcBal).to.be.greaterThanOrEqual(reservedWbtc);

    // INV2: principal solvency — locked EVA + escrowed EVA never exceeds the balance.
    const evaBal = await eva.balanceOf(lockerAddr);
    const reservedEva = (await locker.lockedEvaTotal()) + (await locker.evaEscrow());
    expect(evaBal).to.be.greaterThanOrEqual(reservedEva);

    // INV3 + INV4: shares accounting and no over-crediting of rewards.
    const lpe = await locker.lastProcessedEpoch();
    let sumShares = 0n;
    let sumPending = 0n;
    for (const id of liveIds) {
      const p = await locker.positions(id);
      if (p.expiryEpoch > lpe) sumShares += p.shares; // still live in the pool
      sumPending += await locker.pending(id);
    }
    // INV4: totalShares equals the sum of not-yet-retired live shares.
    expect(await locker.totalShares()).to.equal(sumShares);
    // INV3: claimable never exceeds the recorded liability.
    expect(sumPending).to.be.lessThanOrEqual(await locker.totalUnclaimedRewards());
  }

  it("maintains solvency and accounting across a random op sequence, then drains", async () => {
    const rng = makeRng(0xc0ffee);
    const live: { id: number; owner: SignerWithAddress }[] = [];
    let totalDistributed = 0n;
    const STEPS = 90;

    for (let i = 0; i < STEPS; i++) {
      const op = rng(7);
      try {
        if (op === 0) {
          // lock
          const u = users[rng(users.length)];
          const tier = rng(4);
          const amt = E18(1 + rng(1000));
          const tx = await locker.connect(u).lock(tier, amt);
          const rc = await tx.wait();
          // id = nextPositionId - 1 after the tx
          const id = Number((await locker.nextPositionId()) - 1n);
          live.push({ id, owner: u });
        } else if (op === 1) {
          // distribute
          const amt = E8((1 + rng(500)).toString());
          await locker.distribute(amt);
          totalDistributed += amt;
        } else if (op === 2 && live.length > 0) {
          // claim
          const pick = live[rng(live.length)];
          await locker.connect(pick.owner).claim(pick.id);
        } else if (op === 3 && live.length > 0) {
          // early exit (reverts if matured -> caught)
          const idx = rng(live.length);
          const pick = live[idx];
          await locker.connect(pick.owner).earlyExit(pick.id);
          live.splice(idx, 1);
        } else if (op === 4 && live.length > 0) {
          // withdraw (reverts if not matured -> caught)
          const idx = rng(live.length);
          const pick = live[idx];
          await locker.connect(pick.owner).withdraw(pick.id);
          live.splice(idx, 1);
        } else if (op === 5) {
          // advance time 1h .. 12d
          await increase(3600 + rng(12 * DAY));
        } else if (op === 6 && live.length > 0) {
          // transfer a position to another user (reverts on soulbound tier -> caught)
          const idx = rng(live.length);
          const pick = live[idx];
          const to = users[rng(users.length)];
          await locker.connect(pick.owner).transferFrom(pick.owner.address, to.address, pick.id);
          pick.owner = to; // update tracked owner on success
        }
      } catch {
        // legitimate reverts (matured/not-matured/etc.) — state unchanged, keep going
      }
      await checkInvariants(live.map((l) => l.id));
    }

    // ---- Drain: mature everything, then everyone exits. ----
    await increase(100 * DAY);
    for (const l of [...live]) {
      try {
        await locker.connect(l.owner).withdraw(l.id);
      } catch {
        // already retired/closed
      }
    }

    // After everyone is out, totalUnclaimedRewards = banked (undistributed, no shares to credit) plus
    // unattributable rounding dust. The non-banked part (the dust) must be utterly negligible.
    const residualOwed = await locker.totalUnclaimedRewards();
    const banked = await locker.undistributed();
    expect(residualOwed - banked).to.be.lessThan(E8("0.0001"));

    // Solvency still holds and sweep recovers only the unreserved surplus.
    const before = await wbtc.balanceOf(owner.address);
    const lockerAddr = await locker.getAddress();
    const reserved = (await locker.totalUnclaimedRewards()) + (await locker.wbtcEscrow());
    const sweepable = (await wbtc.balanceOf(lockerAddr)) - reserved;
    if (sweepable > 0n) {
      await locker.sweepWbtc(owner.address);
      expect(await wbtc.balanceOf(owner.address)).to.equal(before + sweepable);
    }
    console.log(
      `      fuzz: distributed ${ethers.formatUnits(totalDistributed, 8)} WBTC, locked-in dust ${ethers.formatUnits(
        residualOwed,
        8
      )} WBTC`
    );
  });
});
