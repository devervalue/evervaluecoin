import { ethers } from "hardhat";
import { expect } from "chai";
import {
  RevenueRouter,
  EVALocker,
  EverValueCoin,
  Token,
  EVABurnVault,
  MockSLSFactoryForRouter,
  MockSLSVaultForRouter,
} from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86400;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

const WEIGHTS = [1n, 2n, 4n, 0n];
const DURATIONS = [10 * DAY, 20 * DAY, 40 * DAY, 80 * DAY];
const CURVES = [0, 0, 0, 0];
const TRANSFERABLES = [true, true, true, false];

describe("RevenueRouter", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let coreVault: EVABurnVault;
  let locker: EVALocker;
  let factory: MockSLSFactoryForRouter;
  let slsVault: MockSLSVaultForRouter;
  let router: RevenueRouter;

  let owner: SignerWithAddress;
  let caller: SignerWithAddress;
  let alice: SignerWithAddress;

  beforeEach(async function () {
    [owner, caller, alice] = await ethers.getSigners();

    const EvaFactory = await ethers.getContractFactory("EverValueCoin");
    eva = await EvaFactory.deploy();
    await eva.waitForDeployment();

    const TokenFactory = await ethers.getContractFactory("Token");
    wbtc = await TokenFactory.deploy(E8("21000000"), "Wrapped Bitcoin", "WBTC", 8);
    await wbtc.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("EVABurnVault");
    coreVault = await VaultFactory.deploy(await eva.getAddress(), await wbtc.getAddress());
    await coreVault.waitForDeployment();

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

    const MockFactory = await ethers.getContractFactory("MockSLSFactoryForRouter");
    factory = await MockFactory.deploy();
    await factory.waitForDeployment();

    const MockVault = await ethers.getContractFactory("MockSLSVaultForRouter");
    slsVault = await MockVault.deploy(await wbtc.getAddress());
    await slsVault.waitForDeployment();

    const RouterFactory = await ethers.getContractFactory("RevenueRouter");
    router = await RouterFactory.deploy(
      await wbtc.getAddress(),
      await coreVault.getAddress(),
      await factory.getAddress(),
      await locker.getAddress(),
      [caller.address]
    );
    await router.waitForDeployment();

    // wire: router is the locker's distributor
    await locker.setDistributor(await router.getAddress());

    // give an alice a live locker position so distribute has shares
    await eva.transfer(alice.address, E18("100"));
    await eva.connect(alice).approve(await locker.getAddress(), ethers.MaxUint256);
    await locker.connect(alice).lock(0, E18("100"));

    // fund the router float
    await wbtc.transfer(await router.getAddress(), E8("1000"));
  });

  it("splits across core, SLS (direct), and locker", async () => {
    await factory.setActiveVault(await slsVault.getAddress());

    const coreBefore = await wbtc.balanceOf(await coreVault.getAddress());
    // 50% core, 30% sls, 20% locker on 100 WBTC
    await router.connect(caller).pay(E8("100"), 5000, 3000, 2000, false, 0);

    expect((await wbtc.balanceOf(await coreVault.getAddress())) - coreBefore).to.equal(E8("50"));
    expect(await wbtc.balanceOf(await slsVault.getAddress())).to.equal(E8("30"));
    expect(await locker.pending(0)).to.equal(E8("20"));
  });

  it("routes the SLS leg via increaseBacking when requested", async () => {
    await factory.setActiveVault(await slsVault.getAddress());
    await router.connect(caller).pay(E8("100"), 5000, 3000, 2000, true, E18("123"));

    expect(await slsVault.totalPulled()).to.equal(E8("30"));
    expect(await slsVault.lastAdditionalEva()).to.equal(E18("123"));
  });

  it("folds the SLS portion into core when there is no active vault", async () => {
    // activeVault defaults to address(0)
    const coreBefore = await wbtc.balanceOf(await coreVault.getAddress());
    await router.connect(caller).pay(E8("100"), 5000, 3000, 2000, false, 0);
    // core gets 50 + 30 folded = 80; locker gets 20
    expect((await wbtc.balanceOf(await coreVault.getAddress())) - coreBefore).to.equal(E8("80"));
    expect(await locker.pending(0)).to.equal(E8("20"));
  });

  it("reverts when bps do not sum to 10000", async () => {
    await expect(router.connect(caller).pay(E8("100"), 5000, 3000, 1000, false, 0)).to.be.revertedWith(
      "bps must sum to 10000"
    );
  });

  it("only allowed callers can pay", async () => {
    await expect(router.connect(alice).pay(E8("100"), 10000, 0, 0, false, 0)).to.be.revertedWith(
      "caller not allowed"
    );
    await router.setCaller(alice.address, true);
    await expect(router.connect(alice).pay(E8("100"), 10000, 0, 0, false, 0)).to.not.be.reverted;
  });

  it("owner can rescue stray tokens", async () => {
    const before = await wbtc.balanceOf(owner.address);
    await router.rescue(await wbtc.getAddress(), owner.address, E8("10"));
    expect(await wbtc.balanceOf(owner.address)).to.equal(before + E8("10"));
  });
});
