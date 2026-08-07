import { ethers } from "hardhat";
import { expect } from "chai";
import { EVALocker, EverValueCoin, Token, EVABurnVault } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86400;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

const WEIGHTS = [1n, 2n, 3n, 4n, 0n]; // confirmed mainnet scale
const DURATIONS = [10 * DAY, 20 * DAY, 40 * DAY, 80 * DAY, 80 * DAY];
const CURVES = [0, 1, 2, 0, 0]; // LINEAR, QUADRATIC, SQRT, LINEAR, LINEAR
const TRANSFERABLES = [true, true, true, true, false];

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

/**
 * Solvency fuzz v2 — extends the stateful invariants with the lock fee, minLockAmount, renewals and
 * the epoch guards in the op mix, upgrades solvency to strict EQUALITY (no unaccounted residue may
 * ever sit in the contract), and ends with a STRICT liveness drain: every surviving position must
 * withdraw successfully — no sequence of operations may brick a position.
 */
describe("EVALocker - solvency & liveness fuzz (fee/renewal aware)", function () {
  this.timeout(600000);

  let eva: EverValueCoin;
  let wbtc: Token;
  let coreVault: EVABurnVault;
  let locker: EVALocker;
  let owner: SignerWithAddress; // admin + distributor + renewal proposer
  let users: SignerWithAddress[];
  let lockerAddr: string;

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
    await wbtc.transfer(await coreVault.getAddress(), E8("5000")); // deep backing for burns
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
    await wbtc.approve(lockerAddr, ethers.MaxUint256); // distributions + wbtc renewal prizes
    await eva.approve(lockerAddr, ethers.MaxUint256); // eva renewal prizes

    for (const u of users) {
      await eva.transfer(u.address, E18("1000000"));
      await eva.connect(u).approve(lockerAddr, ethers.MaxUint256);
    }
  });

  async function checkInvariants(liveIds: number[]) {
    // INV1 (STRICT): wBTC balance == owed rewards (incl. banked) + offer escrow, to the wei.
    // Fee-wBTC and early-exit backing are forwarded within the same tx, so they may never linger.
    const wbtcBal = await wbtc.balanceOf(lockerAddr);
    const reservedWbtc = (await locker.totalUnclaimedRewards()) + (await locker.wbtcEscrow());
    expect(wbtcBal, "INV1 wBTC solvency (strict)").to.equal(reservedWbtc);

    // INV2 (STRICT): EVA balance == locked principal + offer escrow. The fee is burned within
    // lock() itself, so no fee residue may ever accumulate in the contract.
    const evaBal = await eva.balanceOf(lockerAddr);
    const reservedEva = (await locker.lockedEvaTotal()) + (await locker.evaEscrow());
    expect(evaBal, "INV2 EVA solvency (strict)").to.equal(reservedEva);

    // INV3 + INV4: shares conservation and no over-crediting.
    const lpe = await locker.lastProcessedEpoch();
    let sumShares = 0n;
    let sumPending = 0n;
    for (const id of liveIds) {
      const p = await locker.positions(id);
      if (p.expiryEpoch > lpe) sumShares += p.shares;
      sumPending += await locker.pending(id); // also liveness: pending() must never revert
    }
    expect(await locker.totalShares(), "INV4 shares conservation").to.equal(sumShares);
    expect(sumPending, "INV3 claimable <= liability").to.be.lessThanOrEqual(
      await locker.totalUnclaimedRewards()
    );
  }

  for (const seed of [0xe7a10c, 0xc0ffee, 0x5eed42]) {
  it(`holds strict solvency and liveness across random ops (seed 0x${seed.toString(16)})`, async () => {
    const rng = makeRng(seed);
    const live: { id: number; owner: SignerWithAddress }[] = [];
    let totalDistributed = 0n;
    let feeCharges = 0;
    let feeWaivers = 0;
    let renewalsAccepted = 0;
    let epochGuardHits = 0;
    const STEPS = 120;

    for (let i = 0; i < STEPS; i++) {
      const op = rng(11);
      try {
        if (op === 0 || op === 1) {
          // lock (weighted twice: keep the position set growing)
          const u = users[rng(users.length)];
          const tier = rng(5);
          const amt = E18(1 + rng(1000));
          await locker.connect(u).lock(tier, amt);
          const id = Number((await locker.nextPositionId()) - 1n);
          live.push({ id, owner: u });
          // fee accounting probe: principal < amt means the fee was charged, == means waived/zero
          const p = await locker.positions(id);
          if (p.amount < amt) feeCharges++;
          else feeWaivers++;
        } else if (op === 2) {
          // distribute
          const amt = E8((1 + rng(500)).toString());
          await locker.distribute(amt);
          totalDistributed += amt;
        } else if (op === 3 && live.length > 0) {
          // claim
          const pick = live[rng(live.length)];
          await locker.connect(pick.owner).claim(pick.id);
        } else if (op === 4 && live.length > 0) {
          // early exit (reverts if matured -> caught)
          const idx = rng(live.length);
          const pick = live[idx];
          await locker.connect(pick.owner).earlyExit(pick.id);
          live.splice(idx, 1);
        } else if (op === 5 && live.length > 0) {
          // withdraw (reverts if not matured -> caught)
          const idx = rng(live.length);
          const pick = live[idx];
          await locker.connect(pick.owner).withdraw(pick.id);
          live.splice(idx, 1);
        } else if (op === 6) {
          // advance time 1h .. 12d
          await increase(3600 + rng(12 * DAY));
        } else if (op === 7 && live.length > 0) {
          // transfer a position (reverts on soulbound tier -> caught)
          const idx = rng(live.length);
          const pick = live[idx];
          const to = users[rng(users.length)];
          await locker.connect(pick.owner).transferFrom(pick.owner.address, to.address, pick.id);
          pick.owner = to;
        } else if (op === 8) {
          // retune the entry terms: fee (within cap) and minimum
          await locker.setLockFee(rng(501));
          await locker.setMinLockAmount(E18(rng(2) === 0 ? 0 : rng(200)));
        } else if (op === 9 && live.length > 0) {
          // admin proposes a renewal (prize escrowed); sub-day extensions probe the epoch guard
          const pick = live[rng(live.length)];
          const extra = rng(3) === 0 ? 3600 + rng(20 * 3600) : DAY + rng(30 * DAY);
          const keepRemaining = rng(2) === 0;
          await locker.proposeRenewal(
            pick.id,
            extra,
            keepRemaining,
            E18(rng(5)),
            E8((rng(3)).toString()),
            (await now()) + 60 * DAY
          );
        } else if (op === 10 && live.length > 0) {
          // holder accepts a pending renewal (may revert: no offer / epoch guard -> caught)
          const pick = live[rng(live.length)];
          try {
            await locker.connect(pick.owner).acceptRenewal(pick.id);
            renewalsAccepted++;
          } catch (e: any) {
            if (`${e.message}`.includes("renewal ends this epoch")) epochGuardHits++;
            throw e;
          }
        }
      } catch {
        // legitimate reverts (not matured / matured / below min / no offer / epoch guard / soulbound)
      }
      await checkInvariants(live.map((l) => l.id));
    }

    // ---- STRICT drain: mature everything, then EVERY position must withdraw successfully. ----
    let maxEnd = 0n;
    for (const l of live) {
      const p = await locker.positions(l.id);
      if (p.endTime > maxEnd) maxEnd = p.endTime;
    }
    const t = await now();
    if (maxEnd >= BigInt(t)) await increase(Number(maxEnd - BigInt(t)) + 3600);

    for (const l of live) {
      // no try/catch: a revert here means a bricked position — the failure we must never allow
      await locker.connect(l.owner).withdraw(l.id);
    }
    expect(await locker.lockedEvaTotal(), "all principal returned").to.equal(0n);
    expect(await locker.totalShares(), "no stranded shares").to.equal(0n);

    // Residual liability = banked (undistributed) + rounding dust only.
    const residualOwed = await locker.totalUnclaimedRewards();
    const banked = await locker.undistributed();
    expect(residualOwed - banked, "dust only").to.be.lessThan(E8("0.0001"));

    console.log(
      `      fuzz: ${STEPS} steps, distributed ${ethers.formatUnits(totalDistributed, 8)} WBTC, ` +
        `fees charged/waived ${feeCharges}/${feeWaivers}, renewals ${renewalsAccepted}, ` +
        `epoch-guard hits ${epochGuardHits}, dust ${ethers.formatUnits(residualOwed - banked, 8)} WBTC`
    );
  });
  }
});
