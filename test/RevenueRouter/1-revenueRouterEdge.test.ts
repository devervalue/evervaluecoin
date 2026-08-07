import { ethers } from "hardhat";
import { expect } from "chai";
import {
  RevenueRouter,
  EVALocker,
  EverValueCoin,
  Token,
  EVABurnVault,
  MockSLSFactoryForRouter,
} from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86400;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

const WEIGHTS = [1n, 2n, 4n, 0n];
const DURATIONS = [10 * DAY, 20 * DAY, 40 * DAY, 80 * DAY];
const CURVES = [0, 0, 0, 0];
const TRANSFERABLES = [true, true, true, false];

describe("RevenueRouter - edge cases & branches", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let coreVault: EVABurnVault;
  let locker: EVALocker;
  let factory: MockSLSFactoryForRouter;
  let router: RevenueRouter;
  let owner: SignerWithAddress;
  let caller: SignerWithAddress;
  let alice: SignerWithAddress;

  beforeEach(async function () {
    [owner, caller, alice] = await ethers.getSigners();

    eva = await (await ethers.getContractFactory("EverValueCoin")).deploy();
    wbtc = await (await ethers.getContractFactory("Token")).deploy(E8("21000000"), "WBTC", "WBTC", 8);
    coreVault = await (await ethers.getContractFactory("EVABurnVault")).deploy(
      await eva.getAddress(),
      await wbtc.getAddress()
    );
    locker = await (await ethers.getContractFactory("EVALocker")).deploy(
      await eva.getAddress(),
      await wbtc.getAddress(),
      await coreVault.getAddress(),
      WEIGHTS,
      DURATIONS,
      CURVES,
      TRANSFERABLES
    );
    factory = await (await ethers.getContractFactory("MockSLSFactoryForRouter")).deploy();
    router = await (await ethers.getContractFactory("RevenueRouter")).deploy(
      await wbtc.getAddress(),
      await coreVault.getAddress(),
      await factory.getAddress(),
      await locker.getAddress(),
      [caller.address]
    );
    await locker.setDistributor(await router.getAddress());

    await eva.transfer(alice.address, E18("100"));
    await eva.connect(alice).approve(await locker.getAddress(), ethers.MaxUint256);
    await locker.connect(alice).lock(0, E18("100"));
    await wbtc.transfer(await router.getAddress(), E8("1000"));
  });

  it("constructor rejects zero addresses", async () => {
    const F = await ethers.getContractFactory("RevenueRouter");
    const wbtcA = await wbtc.getAddress();
    const coreA = await coreVault.getAddress();
    const facA = await factory.getAddress();
    const lockA = await locker.getAddress();
    await expect(F.deploy(ethers.ZeroAddress, coreA, facA, lockA, [])).to.be.revertedWith("backingToken zero");
    await expect(F.deploy(wbtcA, ethers.ZeroAddress, facA, lockA, [])).to.be.revertedWith("coreVault zero");
    await expect(F.deploy(wbtcA, coreA, ethers.ZeroAddress, lockA, [])).to.be.revertedWith("factory zero");
    await expect(F.deploy(wbtcA, coreA, facA, ethers.ZeroAddress, [])).to.be.revertedWith("locker zero");
  });

  it("pay rejects zero amount", async () => {
    await expect(router.connect(caller).pay(0, 10000, 0, 0, false, 0)).to.be.revertedWith("amount is zero");
  });

  it("100% core leg works (no sls/locker)", async () => {
    const before = await wbtc.balanceOf(await coreVault.getAddress());
    await router.connect(caller).pay(E8("40"), 10000, 0, 0, false, 0);
    expect((await wbtc.balanceOf(await coreVault.getAddress())) - before).to.equal(E8("40"));
  });

  it("100% locker leg works (no core/sls)", async () => {
    await router.connect(caller).pay(E8("40"), 0, 0, 10000, false, 0);
    expect(await locker.pending(0)).to.equal(E8("40"));
  });

  it("setCaller rejects zero address and toggles off", async () => {
    await expect(router.setCaller(ethers.ZeroAddress, true)).to.be.revertedWith("caller zero");
    await router.setCaller(caller.address, false);
    await expect(router.connect(caller).pay(E8("1"), 10000, 0, 0, false, 0)).to.be.revertedWith(
      "caller not allowed"
    );
  });

  it("rescue rejects zero recipient and non-owner", async () => {
    await expect(router.rescue(await wbtc.getAddress(), ethers.ZeroAddress, 1)).to.be.revertedWith("to zero");
    await expect(
      router.connect(alice).rescue(await wbtc.getAddress(), alice.address, 1)
    ).to.be.revertedWithCustomError(router, "OwnableUnauthorizedAccount");
  });
});
