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

// Lock fee (in EVA) is skimmed from the locked amount, burned via the core vault, and the resulting
// wBTC is forwarded to the distributor (RevenueRouter). It is waived when it would redeem to 0 sats.
describe("EVALocker — lock fee & minimum", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let coreVault: EVABurnVault;
  let locker: EVALocker;

  let owner: SignerWithAddress; // also acts as distributor
  let alice: SignerWithAddress;

  let lockerAddr: string;
  let coreVaultAddr: string;

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();

    const EvaFactory = await ethers.getContractFactory("EverValueCoin");
    eva = await EvaFactory.deploy();
    await eva.waitForDeployment();

    const TokenFactory = await ethers.getContractFactory("Token");
    wbtc = await TokenFactory.deploy(E8("21000000"), "Wrapped Bitcoin", "WBTC", 8);
    await wbtc.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("EVABurnVault");
    coreVault = await VaultFactory.deploy(await eva.getAddress(), await wbtc.getAddress());
    await coreVault.waitForDeployment();
    coreVaultAddr = await coreVault.getAddress();
    // fund the core vault so the burn redemption has backing
    await wbtc.transfer(coreVaultAddr, E8("100"));

    const LockerFactory = await ethers.getContractFactory("EVALocker");
    locker = await LockerFactory.deploy(
      await eva.getAddress(),
      await wbtc.getAddress(),
      coreVaultAddr,
      WEIGHTS,
      DURATIONS,
      CURVES,
      TRANSFERABLES
    );
    await locker.waitForDeployment();
    lockerAddr = await locker.getAddress();

    await locker.setDistributor(owner.address); // owner is the distributor
    await eva.transfer(alice.address, E18("1000"));
    await eva.connect(alice).approve(lockerAddr, ethers.MaxUint256);
  });

  describe("admin setters", () => {
    it("only owner can set the fee and the minimum", async () => {
      await expect(locker.connect(alice).setLockFee(100)).to.be.revertedWithCustomError(
        locker,
        "OwnableUnauthorizedAccount"
      );
      await expect(locker.connect(alice).setMinLockAmount(1)).to.be.revertedWithCustomError(
        locker,
        "OwnableUnauthorizedAccount"
      );
    });

    it("enforces the 5% fee cap", async () => {
      await expect(locker.setLockFee(501)).to.be.revertedWith("fee too high");
      await expect(locker.setLockFee(500)).to.emit(locker, "LockFeeUpdated").withArgs(500);
      expect(await locker.lockFeeBps()).to.equal(500);
    });

    it("sets the minimum lock amount", async () => {
      await expect(locker.setMinLockAmount(E18("50")))
        .to.emit(locker, "MinLockAmountUpdated")
        .withArgs(E18("50"));
      expect(await locker.minLockAmount()).to.equal(E18("50"));
    });
  });

  describe("minLockAmount", () => {
    it("rejects locks below the minimum and accepts at/above it", async () => {
      await locker.setMinLockAmount(E18("50"));
      await expect(locker.connect(alice).lock(0, E18("10"))).to.be.revertedWith("below min lock");
      await locker.connect(alice).lock(0, E18("50")); // exactly the minimum is allowed
      expect(await locker.balanceOf(alice.address)).to.equal(1);
    });
  });

  describe("fee charging", () => {
    it("charges 5%: skims from amount, burns it, forwards wBTC to the distributor", async () => {
      await locker.setLockFee(500); // 5%
      const amount = E18("100");
      const fee = (amount * 500n) / 10000n; // 5 EVA

      const supplyBefore = await eva.totalSupply();
      const vaultWbtc = await wbtc.balanceOf(coreVaultAddr);
      const expectedOut = (fee * vaultWbtc) / supplyBefore; // mirrors the vault's payout math
      expect(expectedOut).to.be.greaterThan(0n); // precondition: this fee actually redeems

      const distBefore = await wbtc.balanceOf(owner.address);

      await expect(locker.connect(alice).lock(1, amount)) // tier 1, weight 2
        .to.emit(locker, "LockFeeCharged")
        .withArgs(0, fee, expectedOut);

      const pos = await locker.positions(0);
      expect(pos.amount).to.equal(amount - fee); // principal = amount - fee
      expect(pos.shares).to.equal((amount - fee) * 2n); // shares off principal
      expect(await locker.lockedEvaTotal()).to.equal(amount - fee);

      // fee EVA was burned (supply down) and the wBTC landed at the distributor
      expect(await eva.totalSupply()).to.equal(supplyBefore - fee);
      expect((await wbtc.balanceOf(owner.address)) - distBefore).to.equal(expectedOut);
      // locker keeps only the principal in EVA and no leftover fee wBTC
      expect(await eva.balanceOf(lockerAddr)).to.equal(amount - fee);
    });
  });

  describe("fee waiver (never bricks lock)", () => {
    it("waives a sub-satoshi fee: locks the full amount, burns nothing", async () => {
      await locker.setLockFee(1); // 0.01%
      const amount = E18("1");
      const fee = (amount * 1n) / 10000n; // 0.0001 EVA
      const supplyBefore = await eva.totalSupply();
      const vaultWbtc = await wbtc.balanceOf(coreVaultAddr);
      expect((fee * vaultWbtc) / supplyBefore).to.equal(0n); // precondition: redeems to 0 -> waived

      const distBefore = await wbtc.balanceOf(owner.address);
      await locker.connect(alice).lock(0, amount);

      const pos = await locker.positions(0);
      expect(pos.amount).to.equal(amount); // full amount locked, fee waived
      expect(await eva.totalSupply()).to.equal(supplyBefore); // nothing burned
      expect(await wbtc.balanceOf(owner.address)).to.equal(distBefore); // nothing forwarded
    });

    it("waives the fee when no distributor is set", async () => {
      const LockerFactory = await ethers.getContractFactory("EVALocker");
      const l2 = await LockerFactory.deploy(
        await eva.getAddress(),
        await wbtc.getAddress(),
        coreVaultAddr,
        WEIGHTS,
        DURATIONS,
        CURVES,
        TRANSFERABLES
      );
      await l2.waitForDeployment();
      await l2.setLockFee(500); // fee set, but distributor left unset (address(0))
      await eva.connect(alice).approve(await l2.getAddress(), ethers.MaxUint256);

      const supplyBefore = await eva.totalSupply();
      await l2.connect(alice).lock(0, E18("100"));

      const pos = await l2.positions(0);
      expect(pos.amount).to.equal(E18("100")); // full amount, fee waived (no router to receive it)
      expect(await eva.totalSupply()).to.equal(supplyBefore); // nothing burned
    });
  });
});
