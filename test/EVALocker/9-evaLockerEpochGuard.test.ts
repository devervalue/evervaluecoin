import { ethers } from "hardhat";
import { expect } from "chai";
import { EVALocker, EverValueCoin, Token, EVABurnVault } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86400;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

const LINEAR = 0;
const WEIGHTS = [1n, 2n, 4n, 0n];
const DURATIONS = [10 * DAY, 20 * DAY, 40 * DAY, 80 * DAY];
const CURVES = [LINEAR, LINEAR, LINEAR, LINEAR];
const TRANSFERABLES = [true, true, true, false];

// Guards ensuring a position always matures in a FUTURE epoch. A position whose expiry lands in the
// current (already-processed) epoch would have its shares stranded and the position bricked.
describe("EVALocker — same-epoch expiry guard", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let coreVault: EVABurnVault;
  let locker: EVALocker;

  let owner: SignerWithAddress; // admin + distributor
  let alice: SignerWithAddress;
  let lockerAddr: string;

  async function nextDayBoundary(daysAhead = 2): Promise<number> {
    const b = await ethers.provider.getBlock("latest");
    return (Math.floor(b!.timestamp / DAY) + daysAhead) * DAY;
  }

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();

    eva = await (await ethers.getContractFactory("EverValueCoin")).deploy();
    await eva.waitForDeployment();

    wbtc = await (await ethers.getContractFactory("Token")).deploy(E8("21000000"), "Wrapped Bitcoin", "WBTC", 8);
    await wbtc.waitForDeployment();

    coreVault = await (await ethers.getContractFactory("EVABurnVault")).deploy(
      await eva.getAddress(),
      await wbtc.getAddress()
    );
    await coreVault.waitForDeployment();
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
    await locker.waitForDeployment();
    lockerAddr = await locker.getAddress();

    await locker.setDistributor(owner.address);
    await wbtc.approve(lockerAddr, ethers.MaxUint256); // owner escrows renewal prizes
    await eva.transfer(alice.address, E18("1000"));
    await eva.connect(alice).approve(lockerAddr, ethers.MaxUint256);
  });

  describe("renewal guard", () => {
    it("rejects a sub-day renewal cleanly instead of bricking the position", async () => {
      await locker.connect(alice).lock(0, E18("100")); // tier 0

      // offer far in the future; extend by only 1 hour with keepRemaining=false
      const offerExpiry = (await nextDayBoundary(1000)) as number;
      await locker.proposeRenewal(0, 3600, false, 0, E8("0.001"), offerExpiry);

      // accept exactly on a day boundary so now + 1h stays inside the same epoch
      await ethers.provider.send("evm_setNextBlockTimestamp", [await nextDayBoundary(2)]);
      await expect(locker.connect(alice).acceptRenewal(0)).to.be.revertedWith("renewal ends this epoch");

      // the position is untouched and fully usable — not bricked
      expect(await locker.ownerOf(0)).to.equal(alice.address);
      await expect(locker.pending(0)).to.not.be.reverted;
      const pos = await locker.positions(0);
      expect(pos.amount).to.equal(E18("100"));
    });

    it("accepts a multi-day renewal (guard does not false-positive)", async () => {
      await locker.connect(alice).lock(0, E18("100"));
      const offerExpiry = (await nextDayBoundary(1000)) as number;
      // extend into a future epoch (5 days) — must succeed
      await locker.proposeRenewal(0, 5 * DAY, false, 0, E8("0.001"), offerExpiry);
      await expect(locker.connect(alice).acceptRenewal(0)).to.emit(locker, "RenewalAccepted");
    });
  });

  describe("lock guard", () => {
    it("rejects a lock whose (misconfigured) short tier would mature in the current epoch", async () => {
      // A locker with a 1-hour tier — only to exercise the guard; real tiers are multi-day.
      const shortLocker = await (await ethers.getContractFactory("EVALocker")).deploy(
        await eva.getAddress(),
        await wbtc.getAddress(),
        await coreVault.getAddress(),
        [1n],
        [3600], // 1 hour
        [LINEAR],
        [true]
      );
      await shortLocker.waitForDeployment();
      await eva.connect(alice).approve(await shortLocker.getAddress(), ethers.MaxUint256);

      // lock exactly on a day boundary → end = boundary + 1h → same epoch → must revert
      await ethers.provider.send("evm_setNextBlockTimestamp", [await nextDayBoundary(2)]);
      await expect(shortLocker.connect(alice).lock(0, E18("100"))).to.be.revertedWith(
        "expiry in current epoch"
      );
    });

    it("allows a normal multi-day lock (guard does not false-positive)", async () => {
      await expect(locker.connect(alice).lock(0, E18("100"))).to.emit(locker, "Locked");
    });
  });
});
