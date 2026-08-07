import { ethers } from "hardhat";
import { expect } from "chai";
import { EVALocker, EverValueCoin, Token, EVABurnVault, MaliciousReentrantToken } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86400;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

const WEIGHTS = [1n, 2n, 4n, 0n];
const DURATIONS = [10 * DAY, 20 * DAY, 40 * DAY, 80 * DAY];
const CURVES = [0, 0, 0, 0];
const TRANSFERABLES = [true, true, true, false];

// modes in MaliciousReentrantToken
const M = { claim: 0, withdraw: 1, earlyExit: 2, acceptRenewal: 3, lock: 4, distribute: 5 };

async function increase(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}
async function now(): Promise<number> {
  return (await ethers.provider.getBlock("latest"))!.timestamp;
}

describe("EVALocker - reentrancy guard", function () {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();
  });

  // WBTC is malicious: it re-enters on the reward payout (transfer) / pull (transferFrom).
  async function deployWithMaliciousWbtc() {
    const eva = (await (await ethers.getContractFactory("EverValueCoin")).deploy()) as EverValueCoin;
    const mal = (await (
      await ethers.getContractFactory("MaliciousReentrantToken")
    ).deploy(8, E8("21000000"))) as MaliciousReentrantToken;
    const coreVault = (await (
      await ethers.getContractFactory("EVABurnVault")
    ).deploy(await eva.getAddress(), await mal.getAddress())) as EVABurnVault;
    await mal.transfer(await coreVault.getAddress(), E8("100"));
    const locker = (await (
      await ethers.getContractFactory("EVALocker")
    ).deploy(
      await eva.getAddress(),
      await mal.getAddress(),
      await coreVault.getAddress(),
      WEIGHTS,
      DURATIONS,
      CURVES,
      TRANSFERABLES
    )) as EVALocker;
    await locker.setDistributor(owner.address);
    await mal.approve(await locker.getAddress(), ethers.MaxUint256);
    await eva.transfer(alice.address, E18("1000"));
    await eva.connect(alice).approve(await locker.getAddress(), ethers.MaxUint256);
    return { eva, mal, coreVault, locker };
  }

  it("blocks reentrancy via claim", async () => {
    const { mal, locker } = await deployWithMaliciousWbtc();
    await locker.connect(alice).lock(0, E18("100"));
    await locker.distribute(E8("3")); // owed > 0 so the payout transfer fires
    await mal.configure(await locker.getAddress(), M.claim, 0);
    await mal.arm(true);
    await expect(locker.connect(alice).claim(0)).to.be.revertedWithCustomError(
      locker,
      "ReentrancyGuardReentrantCall"
    );
  });

  it("blocks reentrancy via withdraw", async () => {
    const { mal, locker } = await deployWithMaliciousWbtc();
    await locker.connect(alice).lock(0, E18("100"));
    await locker.distribute(E8("3"));
    await increase(11 * DAY);
    await mal.configure(await locker.getAddress(), M.withdraw, 0);
    await mal.arm(true);
    await expect(locker.connect(alice).withdraw(0)).to.be.revertedWithCustomError(
      locker,
      "ReentrancyGuardReentrantCall"
    );
  });

  it("blocks reentrancy via earlyExit", async () => {
    const { mal, locker } = await deployWithMaliciousWbtc();
    await locker.connect(alice).lock(0, E18("100"));
    await locker.distribute(E8("3"));
    await increase(5 * DAY);
    await mal.configure(await locker.getAddress(), M.earlyExit, 0);
    await mal.arm(true);
    await expect(locker.connect(alice).earlyExit(0)).to.be.revertedWithCustomError(
      locker,
      "ReentrancyGuardReentrantCall"
    );
  });

  it("blocks reentrancy via acceptRenewal", async () => {
    const { mal, locker } = await deployWithMaliciousWbtc();
    await locker.connect(alice).lock(0, E18("100"));
    await locker.distribute(E8("3"));
    await locker.proposeRenewal(0, 10 * DAY, true, 0, 0, (await now()) + 10000);
    await mal.configure(await locker.getAddress(), M.acceptRenewal, 0);
    await mal.arm(true);
    await expect(locker.connect(alice).acceptRenewal(0)).to.be.revertedWithCustomError(
      locker,
      "ReentrancyGuardReentrantCall"
    );
  });

  it("blocks reentrancy via distribute", async () => {
    const { mal, locker } = await deployWithMaliciousWbtc();
    await locker.connect(alice).lock(0, E18("100")); // shares > 0
    await mal.configure(await locker.getAddress(), M.distribute, E8("1"));
    await mal.arm(true);
    // distribute pulls via transferFrom -> token re-enters distribute
    await expect(locker.distribute(E8("3"))).to.be.revertedWithCustomError(
      locker,
      "ReentrancyGuardReentrantCall"
    );
  });

  it("blocks reentrancy via lock (malicious EVA)", async () => {
    // Here EVA is the malicious token so the lock-time transferFrom re-enters lock.
    const mal = (await (
      await ethers.getContractFactory("MaliciousReentrantToken")
    ).deploy(18, E18("21000000"))) as MaliciousReentrantToken;
    const wbtc = (await (
      await ethers.getContractFactory("Token")
    ).deploy(E8("21000000"), "WBTC", "WBTC", 8)) as Token;
    const coreVault = (await (
      await ethers.getContractFactory("EVABurnVault")
    ).deploy(await mal.getAddress(), await wbtc.getAddress())) as EVABurnVault;
    const locker = (await (
      await ethers.getContractFactory("EVALocker")
    ).deploy(
      await mal.getAddress(),
      await wbtc.getAddress(),
      await coreVault.getAddress(),
      WEIGHTS,
      DURATIONS,
      CURVES,
      TRANSFERABLES
    )) as EVALocker;
    await mal.transfer(alice.address, E18("1000"));
    await mal.connect(alice).approve(await locker.getAddress(), ethers.MaxUint256);

    await mal.configure(await locker.getAddress(), M.lock, E18("1"));
    await mal.arm(true);
    await expect(locker.connect(alice).lock(0, E18("100"))).to.be.revertedWithCustomError(
      locker,
      "ReentrancyGuardReentrantCall"
    );
  });
});
