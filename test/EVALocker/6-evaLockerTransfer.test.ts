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
const TRANSFERABLES = [true, true, true, false]; // tier 3 (project) soulbound

async function increase(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}
async function now(): Promise<number> {
  return (await ethers.provider.getBlock("latest"))!.timestamp;
}

describe("EVALocker - tradeable positions (ERC-721)", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let coreVault: EVABurnVault;
  let locker: EVALocker;
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();
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
    await wbtc.approve(await locker.getAddress(), ethers.MaxUint256);
    await eva.transfer(alice.address, E18("10000"));
    await eva.connect(alice).approve(await locker.getAddress(), ethers.MaxUint256);
  });

  const addr = () => locker.getAddress();

  it("advertises ERC-165 / ERC-721 / Enumerable interfaces", async () => {
    expect(await locker.supportsInterface("0x01ffc9a7")).to.equal(true); // ERC165
    expect(await locker.supportsInterface("0x80ac58cd")).to.equal(true); // ERC721
    expect(await locker.supportsInterface("0x780e9d63")).to.equal(true); // ERC721Enumerable
    expect(await locker.supportsInterface("0xffffffff")).to.equal(false);
  });

  it("is a valid ERC-721 with metadata", async () => {
    expect(await locker.name()).to.equal("EVA Locked Position");
    expect(await locker.symbol()).to.equal("EVALOCK");
    await locker.connect(alice).lock(0, E18("100"));
    expect(await locker.ownerOf(0)).to.equal(alice.address);
    expect(await locker.balanceOf(alice.address)).to.equal(1);
    expect(await locker.totalSupply()).to.equal(1);
  });

  it("transfer settles the seller, and the buyer earns from then on", async () => {
    await locker.connect(alice).lock(0, E18("100"));
    await locker.distribute(E8("3")); // alice pending 3
    const aliceWbtc = await wbtc.balanceOf(alice.address);

    await locker.connect(alice).transferFrom(alice.address, bob.address, 0);

    // seller paid out on transfer, position debt reset
    expect(await wbtc.balanceOf(alice.address)).to.equal(aliceWbtc + E8("3"));
    expect(await locker.ownerOf(0)).to.equal(bob.address);
    expect(await locker.pending(0)).to.equal(0);

    await locker.distribute(E8("3")); // now accrues to bob
    expect(await locker.pending(0)).to.equal(E8("3"));
    const bobWbtc = await wbtc.balanceOf(bob.address);
    await locker.connect(bob).claim(0);
    expect(await wbtc.balanceOf(bob.address)).to.equal(bobWbtc + E8("3"));
  });

  it("buyer can withdraw the matured position and receives the principal", async () => {
    await locker.connect(alice).lock(0, E18("100"));
    await locker.connect(alice).transferFrom(alice.address, bob.address, 0);
    await increase(11 * DAY);
    const bobEva = await eva.balanceOf(bob.address);
    await locker.connect(bob).withdraw(0);
    expect(await eva.balanceOf(bob.address)).to.equal(bobEva + E18("100"));
  });

  it("soulbound (project) tier cannot be transferred", async () => {
    await locker.connect(alice).lock(3, E18("100")); // tier 3 soulbound
    await expect(
      locker.connect(alice).transferFrom(alice.address, bob.address, 0)
    ).to.be.revertedWith("tier soulbound");
    // but it can still be withdrawn by its owner at maturity
    await increase(81 * DAY);
    await locker.connect(alice).withdraw(0);
    expect(await eva.balanceOf(alice.address)).to.be.greaterThan(0n);
  });

  it("transferring cancels and refunds an open renewal offer to the admin", async () => {
    await locker.connect(alice).lock(0, E18("100"));
    await eva.approve(await addr(), E18("50"));
    await locker.proposeRenewal(0, 10 * DAY, true, E18("50"), E8("1"), (await now()) + 1000);

    const ownerEva = await eva.balanceOf(owner.address);
    const ownerWbtc = await wbtc.balanceOf(owner.address);
    await locker.connect(alice).transferFrom(alice.address, bob.address, 0);

    expect((await locker.offers(0)).active).to.equal(false);
    expect(await eva.balanceOf(owner.address)).to.equal(ownerEva + E18("50"));
    expect(await wbtc.balanceOf(owner.address)).to.equal(ownerWbtc + E8("1"));
    expect(await locker.evaEscrow()).to.equal(0);
    expect(await locker.wbtcEscrow()).to.equal(0);
  });

  it("supports approvals and operator transfers", async () => {
    await locker.connect(alice).lock(0, E18("100"));
    await locker.connect(alice).approve(carol.address, 0);
    await locker.connect(carol).transferFrom(alice.address, bob.address, 0);
    expect(await locker.ownerOf(0)).to.equal(bob.address);
  });

  it("supports safeTransferFrom and enumeration", async () => {
    await locker.connect(alice).lock(0, E18("10"));
    await locker.connect(alice).lock(1, E18("20"));
    expect((await locker.getPositionIds(alice.address)).map((x) => Number(x))).to.deep.equal([0, 1]);

    await locker.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 0);
    expect((await locker.getPositionIds(alice.address)).map((x) => Number(x))).to.deep.equal([1]);
    expect((await locker.getPositionIds(bob.address)).map((x) => Number(x))).to.deep.equal([0]);
  });

  it("non-owner / non-approved cannot transfer", async () => {
    await locker.connect(alice).lock(0, E18("100"));
    await expect(
      locker.connect(bob).transferFrom(alice.address, bob.address, 0)
    ).to.be.revertedWithCustomError(locker, "ERC721InsufficientApproval");
  });
});
