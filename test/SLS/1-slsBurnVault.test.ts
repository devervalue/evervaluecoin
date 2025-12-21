import { ethers } from "hardhat";
import { expect } from "chai";
import {
  SLSburnVault,
  EverValueCoin,
  Token,
  MockSLSburnVaultFactory
} from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("SLSburnVault - updated logic", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let mockFactory: MockSLSburnVaultFactory;
  let vault: SLSburnVault;

  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  const ONE_EVA = ethers.parseEther("1");
  const FIXED_EVA = ethers.parseEther("1000"); // smaller for testing
  const BACKING_AMOUNT = ethers.parseUnits("100", 8);

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    const EvaFactory = await ethers.getContractFactory("EverValueCoin");
    eva = await EvaFactory.deploy();
    await eva.waitForDeployment();

    const TokenFactory = await ethers.getContractFactory("Token");
    wbtc = await TokenFactory.deploy(
      ethers.parseUnits("21000000", 8),
      "Wrapped Bitcoin",
      "WBTC",
      8
    );
    await wbtc.waitForDeployment();

    const MockFactory = await ethers.getContractFactory("MockSLSburnVaultFactory");
    mockFactory = await MockFactory.deploy(1);
    await mockFactory.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("SLSburnVault");
    vault = await VaultFactory.deploy(
      await eva.getAddress(),
      await wbtc.getAddress(),
      FIXED_EVA,
      await mockFactory.getAddress()
    );
    await vault.waitForDeployment();

    await wbtc.transfer(await vault.getAddress(), BACKING_AMOUNT);
    await eva.approve(await vault.getAddress(), FIXED_EVA);
  });

  describe("constructor validations", () => {
    it("reverts on bad params", async () => {
      const zero = ethers.ZeroAddress;
      const VaultFactory = await ethers.getContractFactory("SLSburnVault");
      await expect(
        VaultFactory.deploy(zero, await wbtc.getAddress(), FIXED_EVA, await mockFactory.getAddress())
      ).to.be.revertedWith("Cannot set EVA to zero address");
      await expect(
        VaultFactory.deploy(await eva.getAddress(), zero, FIXED_EVA, await mockFactory.getAddress())
      ).to.be.revertedWith("Cannot set backing token to zero address");
      await expect(
        VaultFactory.deploy(await eva.getAddress(), await wbtc.getAddress(), ethers.parseEther("0.5"), await mockFactory.getAddress())
      ).to.be.revertedWith("Fixed EVA amount must be >= 1 EVA");
      await expect(
        VaultFactory.deploy(await eva.getAddress(), await wbtc.getAddress(), FIXED_EVA, zero)
      ).to.be.revertedWith("Cannot set factory to zero address");
      await expect(
        VaultFactory.deploy(await eva.getAddress(), await wbtc.getAddress(), ethers.parseEther("21000001"), await mockFactory.getAddress())
      ).to.be.revertedWith("Fixed EVA exceeds total supply");
    });
  });

  describe("getEffectiveEvaAmount and quotes", () => {
    it("returns remaining EVA allocation", async () => {
      expect(await vault.getEffectiveEvaAmount()).to.equal(FIXED_EVA);
    });

    it("quotes backing correctly and clamps to remaining EVA", async () => {
      const quoteOne = await vault.getBurningQuote(ONE_EVA);
      expect(quoteOne).to.equal((ONE_EVA * BACKING_AMOUNT) / FIXED_EVA);

      const quoteOver = await vault.getBurningQuote(FIXED_EVA * 2n);
      expect(quoteOver).to.equal(BACKING_AMOUNT);
    });

    it("returns zero when no backing or no remaining EVA", async () => {
      // no backing
      const VaultFactory = await ethers.getContractFactory("SLSburnVault");
      const emptyVault = await VaultFactory.deploy(
        await eva.getAddress(),
        await wbtc.getAddress(),
        FIXED_EVA,
        await mockFactory.getAddress()
      );
      await emptyVault.waitForDeployment();
      expect(await emptyVault.getBurningQuote(ONE_EVA)).to.equal(0);

      // deplete and quote
      await vault.backingWithdraw(FIXED_EVA);
      expect(await vault.getBurningQuote(ONE_EVA)).to.equal(0);
    });
  });

  describe("backingWithdraw", () => {
    it("reverts when no backing", async () => {
      const VaultFactory = await ethers.getContractFactory("SLSburnVault");
      const emptyVault = await VaultFactory.deploy(
        await eva.getAddress(),
        await wbtc.getAddress(),
        FIXED_EVA,
        await mockFactory.getAddress()
      );
      await emptyVault.waitForDeployment();
      await expect(emptyVault.backingWithdraw(ONE_EVA)).to.be.revertedWith("Nothing to withdraw");
    });

    it("reverts if amount exceeds remaining EVA", async () => {
      await expect(vault.backingWithdraw(FIXED_EVA + ONE_EVA)).to.be.revertedWith("Amount exceeds remaining EVA");
    });

    it("burns EVA, pays backing, and marks depletion at zero", async () => {
      const backingBefore = await wbtc.balanceOf(owner.address);
      const ownerEvaBefore = await eva.balanceOf(owner.address);
      await expect(vault.backingWithdraw(FIXED_EVA)).to.changeTokenBalance(
        wbtc,
        owner.address,
        BACKING_AMOUNT
      );
      expect(await eva.balanceOf(owner.address)).to.equal(ownerEvaBefore - FIXED_EVA);
      expect(await vault.getEffectiveEvaAmount()).to.equal(0);
      expect(await vault.hasBeenDepleted()).to.equal(true);
      expect(await mockFactory.depletionCallCount()).to.equal(1);
      expect(await wbtc.balanceOf(await vault.getAddress())).to.equal(0);
      expect((await wbtc.balanceOf(owner.address)) - backingBefore).to.equal(BACKING_AMOUNT);
    });

    it("reverts after depletion", async () => {
      await vault.backingWithdraw(FIXED_EVA);
      await expect(vault.backingWithdraw(1)).to.be.revertedWith("No EVA remaining");
    });

    it("partial burn leaves vault active and does not mark depletion", async () => {
      const half = FIXED_EVA / 2n;
      await vault.backingWithdraw(half);
      expect(await vault.hasBeenDepleted()).to.equal(false);
      expect(await vault.getEffectiveEvaAmount()).to.equal(FIXED_EVA - half);
    });

    it("reverts when backingToTransfer would be zero (tiny backing)", async () => {
      // Deploy fresh vault with tiny backing
      const VaultFactory = await ethers.getContractFactory("SLSburnVault");
      const tinyVault = await VaultFactory.deploy(
        await eva.getAddress(),
        await wbtc.getAddress(),
        FIXED_EVA,
        await mockFactory.getAddress()
      );
      await tinyVault.waitForDeployment();

      // Fund 1 unit of backing, amount is too small to produce a non-zero transfer
      const tinyBacking = 1n;
      await wbtc.transfer(await tinyVault.getAddress(), tinyBacking);
      await expect(tinyVault.backingWithdraw(1)).to.be.revertedWith("Nothing to withdraw");
    });
  });

  describe("increaseBacking", () => {
    it("raises price without changing EVA when additionalEva = 0", async () => {
      await vault.setPayer(owner.address, true);
      const extraBacking = ethers.parseUnits("10", 8);
      await wbtc.approve(await vault.getAddress(), extraBacking);
      await vault.increaseBacking(0, extraBacking);
      expect(await vault.remainingEvaCovered()).to.equal(FIXED_EVA);
      expect(await wbtc.balanceOf(await vault.getAddress())).to.equal(BACKING_AMOUNT + extraBacking);
    });

    it("increases EVA allocation with price guard and supply cap", async () => {
      await vault.setPayer(owner.address, true);
      const extraBacking = BACKING_AMOUNT; // enough to keep price
      const extraEva = ONE_EVA * 10n;
      await wbtc.approve(await vault.getAddress(), extraBacking);
      await vault.increaseBacking(extraEva, extraBacking);
      expect(await vault.remainingEvaCovered()).to.equal(FIXED_EVA + extraEva);
    });

    it("reverts if price would decrease", async () => {
      await vault.setPayer(owner.address, true);
      await wbtc.approve(await vault.getAddress(), 1);
      await expect(vault.increaseBacking(ONE_EVA, 1)).to.be.revertedWith("Price would decrease");
    });

    it("reverts if new fixedEva exceeds total supply", async () => {
      await vault.setPayer(owner.address, true);
      const currentBacking = await wbtc.balanceOf(await vault.getAddress());
      const tooMuch = (await eva.totalSupply()) + ONE_EVA;
      // choose backingAmount to satisfy price guard: backingNeeded = floor(currentBacking * tooMuch / FIXED_EVA) + 1
      const backingNeeded =
        (currentBacking * tooMuch) / FIXED_EVA + 1n;
      await wbtc.approve(await vault.getAddress(), backingNeeded);
      await expect(vault.increaseBacking(tooMuch, backingNeeded)).to.be.revertedWith(
        "Remaining EVA amount exceeds total supply"
      );
    });

    it("reverts when vault is depleted", async () => {
      await vault.setPayer(owner.address, true);
      await vault.backingWithdraw(FIXED_EVA);
      await wbtc.approve(await vault.getAddress(), BACKING_AMOUNT);
      await expect(vault.increaseBacking(0, BACKING_AMOUNT)).to.be.revertedWith("Vault is depleted");
    });

    it("reverts when backingAmount is zero", async () => {
      await vault.setPayer(owner.address, true);
      await expect(vault.increaseBacking(0, 0)).to.be.revertedWith("backingAmount is zero");
    });

    it("reverts for non-payer", async () => {
      const [, addr] = await ethers.getSigners();
      await vault.setPayer(owner.address, true);
      await wbtc.approve(await vault.getAddress(), BACKING_AMOUNT);
      await expect(
        vault.connect(addr).increaseBacking(0, BACKING_AMOUNT)
      ).to.be.revertedWith("Not authorized payer");
    });
  });

  describe("emergency withdrawals", () => {
    it("allows EVA recovery anytime", async () => {
      await eva.transfer(await vault.getAddress(), ONE_EVA);
      await expect(vault.emergencyWithdrawEVA()).to.changeTokenBalance(
        eva,
        owner.address,
        ONE_EVA
      );
    });

    it("backs only after depletion", async () => {
      await expect(vault.emergencyWithdrawBacking()).to.be.revertedWith("Not depleted");

      // deplete
      await vault.backingWithdraw(FIXED_EVA);
      // send stray backing
      const stray = ethers.parseUnits("1", 8);
      await wbtc.transfer(await vault.getAddress(), stray);
      await expect(vault.emergencyWithdrawBacking()).to.changeTokenBalance(
        wbtc,
        owner.address,
        stray
      );
    });

    it("allows EVA recovery after depletion", async () => {
      await vault.backingWithdraw(FIXED_EVA);
      await eva.transfer(await vault.getAddress(), ONE_EVA);
      await expect(vault.emergencyWithdrawEVA()).to.changeTokenBalance(eva, owner.address, ONE_EVA);
    });

    it("reverts emergency backing withdraw for non-owner", async () => {
      const [, addr] = await ethers.getSigners();
      await expect(
        vault.connect(addr).emergencyWithdrawBacking()
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount").withArgs(addr.address);
    });

    it("reverts emergency EVA withdraw for non-owner", async () => {
      const [, addr] = await ethers.getSigners();
      await expect(
        vault.connect(addr).emergencyWithdrawEVA()
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount").withArgs(addr.address);
    });

    it("setPayer reverts for non-owner", async () => {
      const [, addr] = await ethers.getSigners();
      await expect(vault.connect(addr).setPayer(addr.address, true)).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );
    });

    it("setPayer reverts on zero address", async () => {
      await expect(vault.setPayer(ethers.ZeroAddress, true)).to.be.revertedWith("Invalid payer");
    });
  });
});
