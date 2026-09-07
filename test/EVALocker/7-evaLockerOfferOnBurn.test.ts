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

describe("EVALocker - renewal offer cleared on burn paths", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let coreVault: EVABurnVault;
  let locker: EVALocker;
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();
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
    await eva.transfer(alice.address, E18("1000"));
    await eva.connect(alice).approve(await locker.getAddress(), ethers.MaxUint256);
    // owner funds the renewal escrow
    await eva.approve(await locker.getAddress(), ethers.MaxUint256);
    await wbtc.approve(await locker.getAddress(), ethers.MaxUint256);
  });

  async function lockAndPropose(): Promise<number> {
    await locker.connect(alice).lock(0, E18("100"));
    const id = Number((await locker.nextPositionId()) - 1n);
    await locker.proposeRenewal(id, 10 * DAY, true, E18("50"), E8("1"), (await now()) + 100000);
    expect((await locker.offers(id)).active).to.equal(true);
    expect(await locker.evaEscrow()).to.equal(E18("50"));
    expect(await locker.wbtcEscrow()).to.equal(E8("1"));
    return id;
  }

  it("withdraw refunds the pending offer's escrow to the admin", async () => {
    const id = await lockAndPropose();
    await increase(11 * DAY); // matured

    const ownerEva = await eva.balanceOf(owner.address);
    const ownerWbtc = await wbtc.balanceOf(owner.address);
    await locker.connect(alice).withdraw(id);

    expect((await locker.offers(id)).active).to.equal(false);
    expect(await locker.evaEscrow()).to.equal(0);
    expect(await locker.wbtcEscrow()).to.equal(0);
    expect(await eva.balanceOf(owner.address)).to.equal(ownerEva + E18("50"));
    expect(await wbtc.balanceOf(owner.address)).to.equal(ownerWbtc + E8("1"));
  });

  // Audit F-2026-19105: refunds go to owner(); a renounced owner (address(0)) would make every
  // withdraw/earlyExit/transfer of a position carrying a prize offer revert. renounceOwnership is disabled.
  describe("renounceOwnership is disabled (owner() can never be address(0))", () => {
    it("reverts for the owner, with and without an active prize offer", async () => {
      await expect(locker.renounceOwnership()).to.be.revertedWith("renounce disabled");
      await lockAndPropose(); // prize offer now active
      await expect(locker.renounceOwnership()).to.be.revertedWith("renounce disabled");
      expect(await locker.owner()).to.equal(owner.address);
    });

    it("reverts for non-owners too", async () => {
      await expect(locker.connect(alice).renounceOwnership()).to.be.revertedWith("renounce disabled");
    });

    it("transferOwnership still works and refunds then go to the new owner", async () => {
      const id = await lockAndPropose();
      await locker.transferOwnership(alice.address);
      expect(await locker.owner()).to.equal(alice.address);
      // holder exits early; escrow refund lands on the new owner, exit is not blocked
      const aliceEva = await eva.balanceOf(alice.address);
      const aliceWbtc = await wbtc.balanceOf(alice.address);
      await locker.connect(alice).earlyExit(id);
      expect((await locker.offers(id)).active).to.equal(false);
      expect(await locker.evaEscrow()).to.equal(0);
      expect(await locker.wbtcEscrow()).to.equal(0);
      // alice is both holder and new owner here: she receives the 50 EVA escrow refund plus her
      // liquid slice, and the 1 WBTC escrow refund plus her burn proceeds
      expect(await eva.balanceOf(alice.address)).to.be.greaterThanOrEqual(aliceEva + E18("50"));
      expect(await wbtc.balanceOf(alice.address)).to.be.greaterThanOrEqual(aliceWbtc + E8("1"));
    });

    it("the auditor's freeze scenario is unreachable: exits with an active prize offer always succeed", async () => {
      const id = await lockAndPropose();
      // An expired offer cannot be accepted or cleared by the holder; only the refund path clears it.
      await increase(100001);
      await expect(locker.connect(alice).acceptRenewal(id)).to.be.revertedWith("offer expired");
      // The exit still works because owner() is a live address and cannot be renounced.
      await expect(locker.connect(alice).earlyExit(id)).to.emit(locker, "EarlyExited");
    });
  });

  it("earlyExit refunds the pending offer's escrow to the admin", async () => {
    const id = await lockAndPropose();

    const ownerEva = await eva.balanceOf(owner.address);
    const ownerWbtc = await wbtc.balanceOf(owner.address);
    await locker.connect(alice).earlyExit(id); // before maturity

    expect((await locker.offers(id)).active).to.equal(false);
    expect(await locker.evaEscrow()).to.equal(0);
    expect(await locker.wbtcEscrow()).to.equal(0);
    expect(await eva.balanceOf(owner.address)).to.equal(ownerEva + E18("50"));
    expect(await wbtc.balanceOf(owner.address)).to.equal(ownerWbtc + E8("1"));
  });
});
