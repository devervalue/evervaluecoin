import { ethers } from "hardhat";
import { expect } from "chai";
import {
  PositionMarket,
  EVALocker,
  EverValueCoin,
  Token,
  EVABurnVault,
  MaliciousReentrantToken,
} from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86400;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

const WEIGHTS = [1n, 2n, 4n, 0n];
const DURATIONS = [10 * DAY, 20 * DAY, 40 * DAY, 80 * DAY];
const CURVES = [0, 0, 0, 0];
const TRANSFERABLES = [true, true, true, false];
const MIN_LIST = E18("10");

describe("PositionMarket - edge cases & branches", function () {
  let eva: EverValueCoin;
  let owner: SignerWithAddress;
  let seller: SignerWithAddress;
  let buyer: SignerWithAddress;

  beforeEach(async function () {
    [owner, seller, buyer] = await ethers.getSigners();
    eva = await (await ethers.getContractFactory("EverValueCoin")).deploy();
  });

  it("constructor rejects zero addresses", async () => {
    const wbtc = await (await ethers.getContractFactory("Token")).deploy(E8("1"), "WBTC", "WBTC", 8);
    const F = await ethers.getContractFactory("PositionMarket");
    await expect(F.deploy(ethers.ZeroAddress, await wbtc.getAddress(), MIN_LIST)).to.be.revertedWith(
      "zero address"
    );
    await expect(F.deploy(owner.address, ethers.ZeroAddress, MIN_LIST)).to.be.revertedWith("zero address");
  });

  it("updatePrice rejects a zero price", async () => {
    const wbtc = await (await ethers.getContractFactory("Token")).deploy(E8("21000000"), "WBTC", "WBTC", 8);
    const coreVault = await (await ethers.getContractFactory("EVABurnVault")).deploy(
      await eva.getAddress(),
      await wbtc.getAddress()
    );
    const locker = await (await ethers.getContractFactory("EVALocker")).deploy(
      await eva.getAddress(),
      await wbtc.getAddress(),
      await coreVault.getAddress(),
      WEIGHTS,
      DURATIONS,
      CURVES,
      TRANSFERABLES
    );
    const market = await (await ethers.getContractFactory("PositionMarket")).deploy(
      await locker.getAddress(),
      await wbtc.getAddress(),
      MIN_LIST
    );
    await eva.transfer(seller.address, E18("100"));
    await eva.connect(seller).approve(await locker.getAddress(), ethers.MaxUint256);
    await locker.connect(seller).lock(0, E18("100"));
    await market.connect(seller).list(0, E8("0.5"));
    await expect(market.connect(seller).updatePrice(0, 0)).to.be.revertedWith("price is zero");
  });

  it("buy is protected against reentrancy (malicious WBTC)", async () => {
    // WBTC is a malicious token that re-enters market.buy during the payment transfer.
    const mal = (await (
      await ethers.getContractFactory("MaliciousReentrantToken")
    ).deploy(8, E8("21000000"))) as MaliciousReentrantToken;
    const coreVault = (await (
      await ethers.getContractFactory("EVABurnVault")
    ).deploy(await eva.getAddress(), await mal.getAddress())) as EVABurnVault;
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
    const market = (await (
      await ethers.getContractFactory("PositionMarket")
    ).deploy(await locker.getAddress(), await mal.getAddress(), MIN_LIST)) as PositionMarket;

    // seller locks and lists
    await eva.transfer(seller.address, E18("100"));
    await eva.connect(seller).approve(await locker.getAddress(), ethers.MaxUint256);
    await locker.connect(seller).lock(0, E18("100"));
    await locker.connect(seller).setApprovalForAll(await market.getAddress(), true);
    await market.connect(seller).list(0, E8("1"));

    // buyer holds the malicious WBTC and approves the market
    await mal.transfer(buyer.address, E8("10"));
    await mal.connect(buyer).approve(await market.getAddress(), ethers.MaxUint256);

    // arm the token to re-enter market.buy(0) during the payment transfer
    await mal.configure(await market.getAddress(), 6, 0);
    await mal.arm(true);

    await expect(market.connect(buyer).buy(0)).to.be.revertedWithCustomError(
      market,
      "ReentrancyGuardReentrantCall"
    );
  });
});
