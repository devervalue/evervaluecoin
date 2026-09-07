import { ethers } from "hardhat";
import { expect } from "chai";
import { EVALocker, EverValueCoin, Token, EVABurnVault } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86400;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

// Curve enum
const LINEAR = 0;
const QUADRATIC = 1;
const SQRT = 2;

// Tiers: weights [1,2,4,0]; durations [10d,20d,40d,80d]
const WEIGHTS = [1n, 2n, 4n, 0n];
const DURATIONS = [10 * DAY, 20 * DAY, 40 * DAY, 80 * DAY];
const CURVES = [LINEAR, LINEAR, LINEAR, LINEAR];
const TRANSFERABLES = [true, true, true, false];

async function increase(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("EVALocker", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let coreVault: EVABurnVault;
  let locker: EVALocker;

  let owner: SignerWithAddress; // also acts as distributor
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    const EvaFactory = await ethers.getContractFactory("EverValueCoin");
    eva = await EvaFactory.deploy();
    await eva.waitForDeployment();

    const TokenFactory = await ethers.getContractFactory("Token");
    wbtc = await TokenFactory.deploy(E8("21000000"), "Wrapped Bitcoin", "WBTC", 8);
    await wbtc.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("EVABurnVault");
    coreVault = await VaultFactory.deploy(await eva.getAddress(), await wbtc.getAddress());
    await coreVault.waitForDeployment();
    // fund the core vault so early-exit redemption has backing
    await wbtc.transfer(await coreVault.getAddress(), E8("100"));

    const LockerFactory = await ethers.getContractFactory("EVALocker");
    locker = await LockerFactory.deploy(
      await eva.getAddress(),
      await wbtc.getAddress(),
      await coreVault.getAddress(),
      WEIGHTS,
      DURATIONS,
      CURVES,
      TRANSFERABLES
    );
    await locker.waitForDeployment();

    // owner is the distributor in tests
    await locker.setDistributor(owner.address);
    await wbtc.approve(await locker.getAddress(), ethers.MaxUint256);

    // fund users with EVA and approve the locker
    await eva.transfer(alice.address, E18("1000"));
    await eva.transfer(bob.address, E18("1000"));
    await eva.connect(alice).approve(await locker.getAddress(), ethers.MaxUint256);
    await eva.connect(bob).approve(await locker.getAddress(), ethers.MaxUint256);
  });

  async function distribute(amount: bigint) {
    await locker.distribute(amount);
  }

  describe("constructor", () => {
    it("configures tiers", async () => {
      expect(await locker.tierCount()).to.equal(4);
      const t0 = await locker.tiers(0);
      expect(t0.weight).to.equal(1);
      expect(t0.duration).to.equal(10 * DAY);
      expect(t0.enabled).to.equal(true);
    });

    it("reverts on mismatched arrays / zero address", async () => {
      const LockerFactory = await ethers.getContractFactory("EVALocker");
      await expect(
        LockerFactory.deploy(
          ethers.ZeroAddress,
          await wbtc.getAddress(),
          await coreVault.getAddress(),
          WEIGHTS,
          DURATIONS,
          CURVES,
      TRANSFERABLES
        )
      ).to.be.revertedWith("zero address");
      await expect(
        LockerFactory.deploy(
          await eva.getAddress(),
          await wbtc.getAddress(),
          await coreVault.getAddress(),
          [1n, 2n],
          DURATIONS,
          CURVES,
      TRANSFERABLES
        )
      ).to.be.revertedWith("tier length mismatch");
    });
  });

  describe("lock", () => {
    it("custodies EVA and records shares = amount * weight", async () => {
      await locker.connect(alice).lock(1, E18("100")); // tier1, weight 2
      expect(await eva.balanceOf(await locker.getAddress())).to.equal(E18("100"));
      const pos = await locker.positions(0);
      expect(await locker.ownerOf(0)).to.equal(alice.address);
      expect(pos.amount).to.equal(E18("100"));
      expect(pos.shares).to.equal(E18("200"));
      expect(await locker.totalShares()).to.equal(E18("200"));
    });

    it("project tier (weight 0) creates a position with zero shares", async () => {
      await locker.connect(alice).lock(3, E18("100")); // tier3, weight 0
      const pos = await locker.positions(0);
      expect(pos.shares).to.equal(0);
      expect(await locker.totalShares()).to.equal(0);
    });

    it("reverts when paused or tier disabled", async () => {
      await locker.setLocksPaused(true);
      await expect(locker.connect(alice).lock(0, E18("1"))).to.be.revertedWith("locks paused");
      await locker.setLocksPaused(false);
      await locker.setTierEnabled(0, false);
      await expect(locker.connect(alice).lock(0, E18("1"))).to.be.revertedWith("tier disabled");
    });
  });

  describe("weighted distribution", () => {
    it("splits rewards by weighted shares", async () => {
      await locker.connect(alice).lock(0, E18("100")); // 100 shares
      await locker.connect(bob).lock(1, E18("100")); // 200 shares; total 300
      await distribute(E8("3"));
      expect(await locker.pending(0)).to.equal(E8("1"));
      expect(await locker.pending(1)).to.equal(E8("2"));
    });

    it("project tier earns nothing and does not dilute", async () => {
      await locker.connect(alice).lock(0, E18("100")); // 100 shares
      await locker.connect(bob).lock(3, E18("100")); // weight 0 -> 0 shares
      await distribute(E8("5"));
      expect(await locker.pending(0)).to.equal(E8("5"));
      expect(await locker.pending(1)).to.equal(0);
    });

    it("banks rewards when there are no shares, then releases on next distribution", async () => {
      await distribute(E8("2")); // nobody locked
      expect(await locker.undistributed()).to.equal(E8("2"));
      await locker.connect(alice).lock(0, E18("100"));
      await distribute(E8("1")); // pool = 1 + 2 banked
      expect(await locker.pending(0)).to.equal(E8("3"));
      expect(await locker.undistributed()).to.equal(0);
    });
  });

  describe("claim", () => {
    it("pays out and resets pending", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await distribute(E8("3"));
      const before = await wbtc.balanceOf(alice.address);
      await locker.connect(alice).claim(0);
      expect(await wbtc.balanceOf(alice.address)).to.equal(before + E8("3"));
      expect(await locker.pending(0)).to.equal(0);
    });

    it("only the owner can claim", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await expect(locker.connect(bob).claim(0)).to.be.revertedWith("not owner");
    });

    it("claimAll pays every position the caller owns in one tx", async () => {
      await locker.connect(alice).lock(0, E18("100")); // id0, 100 shares
      await locker.connect(alice).lock(1, E18("100")); // id1, 200 shares; total 300
      await distribute(E8("3")); // id0 -> 1, id1 -> 2
      const before = await wbtc.balanceOf(alice.address);
      await locker.connect(alice).claimAll();
      expect(await wbtc.balanceOf(alice.address)).to.equal(before + E8("3"));
      expect(await locker.pending(0)).to.equal(0);
      expect(await locker.pending(1)).to.equal(0);
    });

    it("claimMany pays the listed positions only", async () => {
      await locker.connect(alice).lock(0, E18("100")); // id0
      await locker.connect(alice).lock(1, E18("100")); // id1
      await distribute(E8("3"));
      const before = await wbtc.balanceOf(alice.address);
      await locker.connect(alice).claimMany([1]); // only id1
      expect(await wbtc.balanceOf(alice.address)).to.equal(before + E8("2"));
      expect(await locker.pending(0)).to.equal(E8("1")); // id0 untouched
      expect(await locker.pending(1)).to.equal(0);
    });

    it("claimMany reverts if the caller doesn't own one of the ids", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await locker.connect(bob).lock(0, E18("100"));
      await expect(locker.connect(alice).claimMany([0, 1])).to.be.revertedWith("not owner");
    });
  });

  describe("maturity & expiry", () => {
    it("stops earning after maturity even if not withdrawn", async () => {
      await locker.connect(alice).lock(0, E18("100")); // 10d, 100 shares
      await locker.connect(bob).lock(1, E18("100")); // 20d, 200 shares
      await distribute(E8("3")); // alice 1, bob 2
      expect(await locker.pending(0)).to.equal(E8("1"));

      await increase(11 * DAY); // alice matured
      await distribute(E8("3")); // only bob (200 shares) should earn

      expect(await locker.pending(0)).to.equal(E8("1")); // frozen
      expect(await locker.pending(1)).to.equal(E8("5")); // 2 + 3
    });

    it("withdraw after maturity returns all EVA and pays frozen rewards", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await distribute(E8("3"));
      await increase(11 * DAY);

      const evaBefore = await eva.balanceOf(alice.address);
      const wbtcBefore = await wbtc.balanceOf(alice.address);
      await locker.connect(alice).withdraw(0);
      expect(await eva.balanceOf(alice.address)).to.equal(evaBefore + E18("100"));
      expect(await wbtc.balanceOf(alice.address)).to.equal(wbtcBefore + E8("3"));
    });

    it("cannot withdraw before maturity", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await expect(locker.connect(alice).withdraw(0)).to.be.revertedWith("not matured");
    });
  });

  describe("early exit (linear curve)", () => {
    it("returns half EVA and burns half at the midpoint", async () => {
      await locker.connect(alice).lock(0, E18("100")); // 10d
      await increase(5 * DAY); // f = 0.5

      const evaBefore = await eva.balanceOf(alice.address);
      const wbtcBefore = await wbtc.balanceOf(alice.address);
      await locker.connect(alice).earlyExit(0);

      // ~50 EVA returned (allow tiny epoch drift on elapsed time)
      const evaGained = (await eva.balanceOf(alice.address)) - evaBefore;
      expect(evaGained).to.be.closeTo(E18("50"), E18("0.05"));
      // received some WBTC backing for the burned half
      expect(await wbtc.balanceOf(alice.address)).to.be.greaterThan(wbtcBefore);
      // position closed (NFT burned)
      await expect(locker.ownerOf(0)).to.be.reverted;
    });

    it("burns ~100% immediately after locking", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      const evaBefore = await eva.balanceOf(alice.address);
      await locker.connect(alice).earlyExit(0);
      const evaGained = (await eva.balanceOf(alice.address)) - evaBefore;
      expect(evaGained).to.be.lessThan(E18("0.1")); // essentially nothing returned as EVA
    });
  });

  describe("renewals", () => {
    it("extends the term, compounds EVA prize into shares, and pays WBTC instantly", async () => {
      await locker.connect(alice).lock(0, E18("100")); // tier0 weight 1 -> 100 shares
      // escrow prize: +50 EVA and 1 WBTC, extend by 10 days keeping remaining
      await eva.approve(await locker.getAddress(), E18("50"));
      await locker.proposeRenewal(0, 10 * DAY, true, E18("50"), E8("1"), (await time()) + 1000);

      const wbtcBefore = await wbtc.balanceOf(alice.address);
      await locker.connect(alice).acceptRenewal(0);

      const pos = await locker.positions(0);
      expect(pos.amount).to.equal(E18("150"));
      expect(pos.shares).to.equal(E18("150")); // weight 1
      expect(await locker.totalShares()).to.equal(E18("150"));
      expect(await wbtc.balanceOf(alice.address)).to.equal(wbtcBefore + E8("1"));
    });

    it("can reactivate a matured position", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await increase(11 * DAY); // matured -> shares retired
      // poke processing
      await locker.connect(bob).lock(1, E18("1"));
      expect(await locker.totalShares()).to.equal(E18("2")); // only bob

      await locker.proposeRenewal(0, 10 * DAY, false, 0, 0, (await time()) + 1000);
      await locker.connect(alice).acceptRenewal(0);

      const pos = await locker.positions(0);
      expect(pos.shares).to.equal(E18("100"));
      expect(await locker.totalShares()).to.equal(E18("102"));
    });

    // Audit F-2026-19110: a renewal may only extend, never shorten.
    describe("monotonic end-time guard", () => {
      it("rejects a reset-from-now offer shorter than the remaining term at proposal time", async () => {
        await locker.connect(alice).lock(0, E18("100")); // 10d tier
        await increase(2 * DAY); // 8d remaining
        await expect(
          locker.proposeRenewal(0, 2 * DAY, false, 0, E8("1"), (await time()) + 1000)
        ).to.be.revertedWith("must not shorten");
        // nothing escrowed
        expect(await locker.wbtcEscrow()).to.equal(0);
      });

      it("an offer valid at proposal stays valid at a later acceptance (extra == remaining, accepted a day later)", async () => {
        // If the offer passes at proposal (now_p + extra >= endTime), it passes at any later acceptance
        // (now_a >= now_p). Verify: propose with extra == remaining, accept a day later.
        await locker.connect(alice).lock(0, E18("100"));
        const pos = await locker.positions(0);
        const remaining = Number(pos.endTime) - (await time());
        await locker.proposeRenewal(0, remaining, false, 0, 0, (await time()) + 5 * DAY);
        await increase(1 * DAY);
        await expect(locker.connect(alice).acceptRenewal(0)).to.emit(locker, "RenewalAccepted");
        expect((await locker.positions(0)).endTime).to.be.greaterThanOrEqual(pos.endTime);
      });

      it("an extension exactly equal to the remaining time is allowed (newEnd == endTime)", async () => {
        await locker.connect(alice).lock(0, E18("100"));
        const pos = await locker.positions(0);
        // keepRemaining=true with extra=0 is an "empty offer" unless it carries a prize; use a prize.
        await locker.proposeRenewal(0, 0, true, 0, E8("1"), (await time()) + 1000);
        await expect(locker.connect(alice).acceptRenewal(0)).to.emit(locker, "RenewalAccepted");
        expect((await locker.positions(0)).endTime).to.equal(pos.endTime);
      });

      it("keepRemaining=true can never shorten and always passes", async () => {
        await locker.connect(alice).lock(0, E18("100"));
        const pos = await locker.positions(0);
        await locker.proposeRenewal(0, 1, true, 0, 0, (await time()) + 1000); // +1 second
        await locker.connect(alice).acceptRenewal(0);
        expect((await locker.positions(0)).endTime).to.equal(pos.endTime + 1n);
      });

      it("matured positions can still be reactivated with any future end", async () => {
        await locker.connect(alice).lock(0, E18("100"));
        await increase(11 * DAY); // matured
        await locker.proposeRenewal(0, 2 * DAY, false, 0, 0, (await time()) + 1000);
        await expect(locker.connect(alice).acceptRenewal(0)).to.emit(locker, "RenewalAccepted");
      });

      it("soulbound weight-0 (founder) tier cannot be released early via a short renewal", async () => {
        await locker.connect(alice).lock(3, E18("1000")); // tier 3: soulbound, weight 0, 80d
        await increase(10 * DAY); // 70d remaining
        // Admin + holder collusion attempt: "renew" to 2 days from now, then withdraw at 100%.
        await expect(
          locker.proposeRenewal(0, 2 * DAY, false, 0, 0, (await time()) + 1000)
        ).to.be.revertedWith("must not shorten");
        // Position is untouched; withdraw still requires the original maturity.
        await expect(locker.connect(alice).withdraw(0)).to.be.revertedWith("not matured");
        await increase(70 * DAY);
        await expect(locker.connect(alice).withdraw(0)).to.emit(locker, "Withdrawn");
      });
    });

    it("cancel refunds escrow to the admin", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await eva.approve(await locker.getAddress(), E18("50"));
      await locker.proposeRenewal(0, 10 * DAY, true, E18("50"), E8("1"), (await time()) + 1000);
      const evaBefore = await eva.balanceOf(owner.address);
      const wbtcBefore = await wbtc.balanceOf(owner.address);
      await locker.cancelRenewal(0);
      expect(await eva.balanceOf(owner.address)).to.equal(evaBefore + E18("50"));
      expect(await wbtc.balanceOf(owner.address)).to.equal(wbtcBefore + E8("1"));
    });

    it("only owner proposes; only position owner accepts", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await expect(
        locker.connect(alice).proposeRenewal(0, 10 * DAY, true, 0, 0, (await time()) + 1000)
      ).to.be.revertedWithCustomError(locker, "OwnableUnauthorizedAccount");
      await locker.proposeRenewal(0, 10 * DAY, true, 0, 0, (await time()) + 1000);
      await expect(locker.connect(bob).acceptRenewal(0)).to.be.revertedWith("not owner");
    });
  });

  describe("access control & sweeps", () => {
    it("only distributor can distribute", async () => {
      await expect(locker.connect(alice).distribute(E8("1"))).to.be.revertedWith("not distributor");
    });

    it("sweepWbtc only takes the unreserved surplus", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      await distribute(E8("3")); // 3 owed (reserved)
      await wbtc.transfer(await locker.getAddress(), E8("1")); // stray
      const before = await wbtc.balanceOf(owner.address);
      await locker.sweepWbtc(owner.address);
      expect(await wbtc.balanceOf(owner.address)).to.equal(before + E8("1"));
      // alice can still claim her full reward
      await locker.connect(alice).claim(0);
      expect(await locker.pending(0)).to.equal(0);
    });
  });

  async function time(): Promise<number> {
    const b = await ethers.provider.getBlock("latest");
    return b!.timestamp;
  }
});
