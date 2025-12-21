import { ethers } from "hardhat";
import { expect } from "chai";
import {
  SLSburnVault,
  SLSburnVaultFactory,
  EverValueCoin,
  Token
} from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("SLSburnVault - sequential flow", function () {
  let owner: SignerWithAddress;
  let eva: EverValueCoin;
  let wbtc: Token;
  let factory: SLSburnVaultFactory;

  const ONE_EVA = ethers.parseEther("1");
  const FIXED_EVA = ethers.parseEther("1000");
  const INITIAL_BACKING = ethers.parseUnits("50", 8);

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

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

    const FactoryFactory = await ethers.getContractFactory("SLSburnVaultFactory");
    factory = await FactoryFactory.deploy(await eva.getAddress());
    await factory.waitForDeployment();
  });

  it("allows sequential vault lifecycle with price-safe topups", async function () {
    // Create first vault
    await wbtc.approve(await factory.getAddress(), INITIAL_BACKING);
    await factory.createVault(await wbtc.getAddress(), FIXED_EVA, INITIAL_BACKING);
    const v1Addr = (await factory.getAllVaults())[0];
    const v1 = await ethers.getContractAt("SLSburnVault", v1Addr);
    await v1.setPayer(owner.address, true);

    // Top up backing only (no EVA increase)
    const extraBacking = ethers.parseUnits("5", 8);
    await wbtc.approve(v1Addr, extraBacking);
    await v1.increaseBacking(0, extraBacking);
    expect(await v1.remainingEvaCovered()).to.equal(FIXED_EVA);
    expect(await wbtc.balanceOf(v1Addr)).to.equal(INITIAL_BACKING + extraBacking);

    // Deplete the vault
    await eva.approve(v1Addr, FIXED_EVA);
    await v1.backingWithdraw(FIXED_EVA);
    expect(await factory.activeVault()).to.equal(ethers.ZeroAddress);

    // Create a second vault after depletion
    await wbtc.approve(await factory.getAddress(), INITIAL_BACKING);
    await factory.createVault(await wbtc.getAddress(), FIXED_EVA, INITIAL_BACKING);
    const v2Addr = (await factory.getAllVaults())[1];
    expect(await factory.activeVault()).to.equal(v2Addr);
    expect(await factory.getVaultCount()).to.equal(2);
  });

  it("intense lifecycle: 30 vaults, 50 withdrawals each, zero dust left", async function () {
    const vaultCount = 30;
    const withdrawsPerVault = 50;
    const fixedPerVault = FIXED_EVA;

    // prepare two users for multi-user burns
    const [_, user1, user2] = await ethers.getSigners();
    await eva.transfer(user1.address, fixedPerVault * BigInt(vaultCount) / 2n);
    await eva.transfer(user2.address, fixedPerVault * BigInt(vaultCount) / 2n);

    for (let i = 0; i < vaultCount; i++) {
      expect(await factory.activeVault()).to.equal(ethers.ZeroAddress);

      const backing = ethers.parseUnits((50 - i).toString(), 8) + BigInt(i); // varying, includes tiny satoshis
      await wbtc.approve(await factory.getAddress(), backing);
      await factory.createVault(await wbtc.getAddress(), fixedPerVault, backing);
      const addr = (await factory.getAllVaults()).at(-1)!;
      const vault = await ethers.getContractAt("SLSburnVault", addr);

      // owner + users approve the vault
      await eva.approve(addr, ethers.MaxUint256);
      await eva.connect(user1).approve(addr, ethers.MaxUint256);
      await eva.connect(user2).approve(addr, ethers.MaxUint256);
      await vault.setPayer(owner.address, true);
      await vault.setPayer(user1.address, true);
      await vault.setPayer(user2.address, true);

      // price-safe top-up (backing only)
      const extraBacking = 10n;
      await wbtc.approve(addr, extraBacking);
      await vault.increaseBacking(0, extraBacking);

      // price-safe increase coverage
      const addEva = ONE_EVA;
      const currentBacking = await wbtc.balanceOf(addr);
      const backingEnough = (currentBacking * addEva) / (fixedPerVault) + 1n;
      await wbtc.approve(addr, backingEnough);
      await vault.increaseBacking(addEva, backingEnough);

      // price guard revert
      await expect(vault.increaseBacking(ONE_EVA, 1)).to.be.revertedWith("Price would decrease");

      // multi-user withdrawals
      const per = (fixedPerVault + addEva) / BigInt(withdrawsPerVault);
      const users = [owner, user1, user2];
      for (let j = 0; j < withdrawsPerVault; j++) {
        const remaining = await vault.getEffectiveEvaAmount();
        if (remaining === 0n) break;
        const amt = j === withdrawsPerVault - 1 ? remaining : per;
        const quote = await vault.getBurningQuote(amt);
        const signer = users[j % users.length];
        if (quote === 0n) {
          const tiny = 1n;
          const tinyQuote = await vault.getBurningQuote(tiny);
          if (tinyQuote === 0n) break;
          await vault.connect(signer).backingWithdraw(tiny);
        } else {
          await vault.connect(signer).backingWithdraw(amt);
        }
      }

      // post-depletion stray deposits and emergency flows
      let remaining = await vault.getEffectiveEvaAmount();
      if (remaining > 0n) {
        const topUp = 1n; // 0.00000001 WBTC to finish depletion
        await wbtc.transfer(addr, topUp);
        await vault.backingWithdraw(remaining);
      }

      // stray backing after depletion
      await wbtc.transfer(addr, 2n);
      await vault.emergencyWithdrawBacking();
      expect(await wbtc.balanceOf(addr)).to.equal(0);

      // stray EVA after depletion
      await eva.transfer(addr, ONE_EVA);
      await vault.emergencyWithdrawEVA();
      expect(await eva.balanceOf(addr)).to.equal(0);

      expect(await vault.getEffectiveEvaAmount()).to.equal(0);
      expect(await wbtc.balanceOf(addr)).to.equal(0);
      expect(await factory.activeVault()).to.equal(ethers.ZeroAddress);
    }
  });
});
