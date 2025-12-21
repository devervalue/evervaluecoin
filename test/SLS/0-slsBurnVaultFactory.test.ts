import { ethers } from "hardhat";
import { expect } from "chai";
import {
  SLSburnVault,
  SLSburnVaultFactory,
  EverValueCoin,
  Token,
  SLSPayer
} from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("SLSburnVaultFactory - single active vault flow", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let factory: SLSburnVaultFactory;
  let payer: SLSPayer;

  let owner: SignerWithAddress;
  let addr1: SignerWithAddress;

  const ONE_EVA = ethers.parseEther("1");
  const FIXED_EVA = ethers.parseEther("1000");
  const INITIAL_WBTC_BACKING = ethers.parseUnits("100", 8);

  beforeEach(async function () {
    [owner, addr1] = await ethers.getSigners();

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

    const PayerFactory = await ethers.getContractFactory("SLSPayer");
    payer = await PayerFactory.deploy(
      await wbtc.getAddress(),
      owner.address, // dummy burnVault for tests
      await factory.getAddress(),
      [owner.address]
    );
    await payer.waitForDeployment();
  });

  describe("constructor", () => {
    it("reverts on zero addresses", async () => {
      const FactoryFactory = await ethers.getContractFactory("SLSburnVaultFactory");
      const zero = ethers.ZeroAddress;
      await expect(FactoryFactory.deploy(zero)).to.be.revertedWith("EVA address cannot be zero");
    });
  });

  describe("createVault and active guard", () => {
    it("prevents non-owner creation", async () => {
      await expect(
        factory.connect(addr1).createVault(await wbtc.getAddress(), FIXED_EVA, INITIAL_WBTC_BACKING)
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount").withArgs(addr1.address);
    });

    it("creates vault with initial backing and blocks second until depletion", async () => {
      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING);
      await expect(
        factory.createVault(await wbtc.getAddress(), FIXED_EVA, INITIAL_WBTC_BACKING)
      ).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);

      const allVaults = await factory.getAllVaults();
      expect(allVaults.length).to.equal(1);
      const activeAddr = allVaults[0];
      const vault = await ethers.getContractAt("SLSburnVault", activeAddr);
      expect(await factory.activeVault()).to.equal(activeAddr);
      expect(await vault.remainingEvaCovered()).to.equal(FIXED_EVA);
      expect(await wbtc.balanceOf(activeAddr)).to.equal(INITIAL_WBTC_BACKING);
      expect(await eva.balanceOf(activeAddr)).to.equal(0);

      await expect(
        factory.createVault(await wbtc.getAddress(), FIXED_EVA, 0)
      ).to.be.revertedWith("Deplete current vault first");

      // Deplete the vault
      await eva.approve(activeAddr, FIXED_EVA);
      await vault.backingWithdraw(FIXED_EVA);
      expect(await factory.activeVault()).to.equal(ethers.ZeroAddress);

      // Now a new vault can be created
      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING);
      await factory.createVault(await wbtc.getAddress(), FIXED_EVA, INITIAL_WBTC_BACKING);
      expect((await factory.getAllVaults()).length).to.equal(2);
    });

    it("creates vault with zero initial backing", async () => {
      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING);
      await factory.createVault(await wbtc.getAddress(), FIXED_EVA, 0);
      const addr = (await factory.getAllVaults())[0];
      expect(await wbtc.balanceOf(addr)).to.equal(0);
    });

    it("reverts on zero backing token or zero EVA amount", async () => {
      await expect(
        factory.createVault(ethers.ZeroAddress, FIXED_EVA, 0)
      ).to.be.revertedWith("Backing token cannot be zero address");
      await expect(
        factory.createVault(await wbtc.getAddress(), 0, 0)
      ).to.be.revertedWith("Fixed EVA amount must be greater than 0");
    });
  });

  describe("onVaultDepletion", () => {
    it("reverts if called by non-active vault", async () => {
      await expect(factory.onVaultDepletion()).to.be.revertedWith("Only active vault can deplete");
    });

    it("reverts on duplicate depletion call", async () => {
      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING);
      await factory.createVault(await wbtc.getAddress(), FIXED_EVA, INITIAL_WBTC_BACKING);
      const addr = (await factory.getAllVaults())[0];
      const vault = await ethers.getContractAt("SLSburnVault", addr);
      await eva.approve(addr, FIXED_EVA);
      await vault.backingWithdraw(FIXED_EVA);
      await expect(factory.onVaultDepletion()).to.be.revertedWith("Only active vault can deplete");
    });
  });

  describe("pause/unpause creation", () => {
    it("only owner can pause/unpause", async () => {
      await expect(factory.connect(addr1).setCreationPaused(true))
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount").withArgs(addr1.address);
    });

    it("blocks creation when paused and allows when unpaused", async () => {
      await expect(factory.setCreationPaused(true))
        .to.emit(factory, "CreationPauseToggled")
        .withArgs(true);
      await expect(
        factory.createVault(await wbtc.getAddress(), FIXED_EVA, INITIAL_WBTC_BACKING)
      ).to.be.revertedWith("Vault creation is paused");

      await expect(factory.setCreationPaused(false))
        .to.emit(factory, "CreationPauseToggled")
        .withArgs(false);

      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING);
      await factory.createVault(await wbtc.getAddress(), FIXED_EVA, INITIAL_WBTC_BACKING);
    });
  });

  describe("views", () => {
    it("returns vault lists and totals correctly", async () => {
      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING);
      await factory.createVault(await wbtc.getAddress(), FIXED_EVA, INITIAL_WBTC_BACKING);
      // deplete first to allow a second
      const v1 = (await factory.getAllVaults())[0];
      const vault1 = await ethers.getContractAt("SLSburnVault", v1);
      await eva.approve(v1, FIXED_EVA);
      await vault1.backingWithdraw(FIXED_EVA);

      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING);
      await factory.createVault(await wbtc.getAddress(), FIXED_EVA, INITIAL_WBTC_BACKING);

      const all = await factory.getAllVaults();
      expect(all.length).to.equal(2);
      expect(await factory.getVaultsByBackingToken(await wbtc.getAddress())).to.deep.equal(all);
      expect(await factory.getVaultCount()).to.equal(2);
      expect(await factory.isCreatedVault(all[0])).to.equal(true);
      expect(await factory.isCreatedVault(all[1])).to.equal(true);
      expect(await factory.isActiveVault(ethers.ZeroAddress)).to.equal(false);
      expect(await factory.getTotalBackingByToken(await wbtc.getAddress())).to.equal(INITIAL_WBTC_BACKING);
    });
  });

  describe("finalBurnVaultWithdraw", () => {
    it("is removed in this version", async () => {
      expect((factory as any).finalBurnVaultWithdraw).to.equal(undefined);
    });
  });

  describe("SLSPayer minimal checks", () => {
    it("allows owner as caller", async () => {
      await payer.setCaller(owner.address, true);
      expect(await payer.isCallerAllowed(owner.address)).to.equal(true);
    });
  });
});
