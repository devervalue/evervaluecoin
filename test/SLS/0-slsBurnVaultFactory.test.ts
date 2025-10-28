import { ethers } from "hardhat";
import chai from "chai";
import { expect } from "chai";
import hre from "hardhat";
import { 
  SLSburnVault, 
  SLSburnVaultFactory, 
  EverValueCoin, 
  Token,
  EVABurnVault 
} from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("SLSburnVault - Complete Test Suite", function () {
  // Contract instances
  let eva: EverValueCoin;
  let wbtc: Token;
  let burnVault: EVABurnVault;
  let factory: SLSburnVaultFactory;
  let slsVault: SLSburnVault;

  // Signers
  let owner: SignerWithAddress;
  let addr1: SignerWithAddress;
  let addr2: SignerWithAddress;
  let addr3: SignerWithAddress;

  // Constants
  const ONE_EVA = ethers.parseEther("1");
  const EVA_TOTAL_SUPPLY = ethers.parseEther("21000000"); // 21M EVA
  const WBTC_TOTAL_SUPPLY = ethers.parseUnits("21000000", 8); // 21M WBTC (8 decimals)
  const VAULT_FIXED_EVA = ethers.parseEther("1000000"); // 1M EVA per vault
  const INITIAL_WBTC_BACKING = ethers.parseUnits("100", 8); // 100 WBTC

  beforeEach(async function () {
    // Get signers
    [owner, addr1, addr2, addr3] = await ethers.getSigners();

    // Deploy EVA token
    const EvaFactory = await ethers.getContractFactory("EverValueCoin");
    eva = await EvaFactory.deploy();
    await eva.waitForDeployment();
    // Deploy WBTC token (using Token contract as mock)
    const TokenFactory = await ethers.getContractFactory("Token");
    wbtc = await TokenFactory.deploy(WBTC_TOTAL_SUPPLY, "Wrapped Bitcoin", "WBTC", 8);
    await wbtc.waitForDeployment();
    // Deploy original EVABurnVault
    const BurnVaultFactory = await ethers.getContractFactory("EVABurnVault");
    burnVault = await BurnVaultFactory.deploy(
      await eva.getAddress(),
      await wbtc.getAddress()
    );
    await burnVault.waitForDeployment();
    // Deploy SLSburnVaultFactory with all required addresses
    const FactoryFactory = await ethers.getContractFactory("SLSburnVaultFactory");
    factory = await FactoryFactory.deploy(
      await eva.getAddress(),
      await burnVault.getAddress(),
      await wbtc.getAddress()
    );
    await factory.waitForDeployment();
    // Transfer 1 EVA to factory for original vault reservation
    await eva.transfer(await factory.getAddress(), ONE_EVA);

    // Initialize original vault reservation
    await factory.initializeOriginalVaultReservation();



    // Get the deployed vault address
    const vaultAddresses = await factory.getAllVaults();
    const vaultAddress = vaultAddresses[vaultAddresses.length - 1];

   
  });

  describe("Deployment & Initialization", function () {
    it("Should deploy factory with correct addresses", async function () {
      expect(await factory.eva()).to.equal(await eva.getAddress());
      expect(await factory.wbtc()).to.equal(await wbtc.getAddress());
      expect(await factory.burnVault()).to.equal(await burnVault.getAddress());
    });
    it("Constructor requirements fails", async function () {  
      const zeroAddress = "0x0000000000000000000000000000000000000000";
      const FactoryFactory = await ethers.getContractFactory("SLSburnVaultFactory");
      await expect(FactoryFactory.deploy(zeroAddress, zeroAddress, zeroAddress)).to.be.revertedWith("EVA address cannot be zero");
      await expect(FactoryFactory.deploy(await eva.getAddress(), zeroAddress, await wbtc.getAddress())).to.be.revertedWith("Burn vault address cannot be zero");
      await expect(FactoryFactory.deploy(await eva.getAddress(), await burnVault.getAddress(), zeroAddress)).to.be.revertedWith("WBTC address cannot be zero");
    });
    it("Original vault reservation fails", async function () {
      const FactoryFactory = await ethers.getContractFactory("SLSburnVaultFactory");
      const factory = await FactoryFactory.deploy(await eva.getAddress(), await burnVault.getAddress(), await wbtc.getAddress());

      await expect(factory.connect(addr1).initializeOriginalVaultReservation()).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount").withArgs(addr1.address);
      await expect(factory.initializeOriginalVaultReservation()).to.be.revertedWith("Factory must have at least 1 EVA");
      await eva.transfer(await factory.getAddress(), ONE_EVA);
      await factory.initializeOriginalVaultReservation();
      await expect(factory.initializeOriginalVaultReservation()).to.be.revertedWith("Original vault already reserved");
    });

  });

  describe("Final Burn Vault Withdraw", function () {
    it("final admin withdraw must burn the last EVA on the burn vault and transfer the remaining WBTC to the owner", async function () {

      await wbtc.transfer(await burnVault.getAddress(), ethers.parseUnits("100", 8));
      await eva.approve(await burnVault.getAddress(), await eva.balanceOf(owner.address));
      const expectedWBTC = (await eva.balanceOf(owner.address) * ethers.parseUnits("100", 8)) / await eva.totalSupply();
      await expect(burnVault.backingWithdraw(await eva.balanceOf(owner.address))).to.changeTokenBalance(wbtc, owner.address,expectedWBTC);
      await expect(factory.finalBurnVaultWithdraw()).to.changeTokenBalance(wbtc, owner.address, ethers.parseUnits("100", 8) - expectedWBTC);
      expect(await eva.totalSupply()).to.equal(0);
      expect(await wbtc.balanceOf(await burnVault.getAddress())).to.equal(0);
    });
    it("final admin withdraw must revert if called by non owner", async function () {
      await wbtc.transfer(await burnVault.getAddress(), ethers.parseUnits("100", 8));
      await eva.approve(await burnVault.getAddress(), await eva.balanceOf(owner.address));
      const expectedWBTC = (await eva.balanceOf(owner.address) * ethers.parseUnits("100", 8)) / await eva.totalSupply();
      await expect(burnVault.backingWithdraw(await eva.balanceOf(owner.address))).to.changeTokenBalance(wbtc, owner.address,expectedWBTC);
      await expect(factory.connect(addr1).finalBurnVaultWithdraw()).to.revertedWithCustomError(factory, "OwnableUnauthorizedAccount").withArgs(addr1.address);
    })
    it("final admin withdraw must revert if called before original vault reservation", async function () {
      const FactoryFactory = await ethers.getContractFactory("SLSburnVaultFactory");
      const factory = await FactoryFactory.deploy(await eva.getAddress(), await burnVault.getAddress(), await wbtc.getAddress());
      await expect(factory.finalBurnVaultWithdraw()).to.be.revertedWith("Must initialize original vault reservation first");
    })
    it("final admin withdraw must rever if called without EVA balance", async function () {
      await wbtc.transfer(await burnVault.getAddress(), ethers.parseUnits("100", 8));
      await eva.approve(await burnVault.getAddress(), await eva.balanceOf(owner.address));
      const expectedWBTC = (await eva.balanceOf(owner.address) * ethers.parseUnits("100", 8)) / await eva.totalSupply();
      await expect(burnVault.backingWithdraw(await eva.balanceOf(owner.address))).to.changeTokenBalance(wbtc, owner.address,expectedWBTC);
      await expect(factory.finalBurnVaultWithdraw()).to.changeTokenBalance(wbtc, owner.address, ethers.parseUnits("100", 8) - expectedWBTC);
      expect(await eva.totalSupply()).to.equal(0);
      expect(await wbtc.balanceOf(await burnVault.getAddress())).to.equal(0);
      await expect(factory.finalBurnVaultWithdraw()).to.be.revertedWith("Factory must have at least 1 EVA");
    })
    it("final admin withdraw must rever if called before EVA total supply equals total vault count", async function () {
      await expect(factory.finalBurnVaultWithdraw()).to.be.revertedWith("EVA total supply must be less than or equal to total vault count");
    })
  })
  describe("Create Vault", function () {
    it("create vault must revert if called by non owner", async function () {
      await expect(factory.connect(addr1).createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.revertedWithCustomError(factory, "OwnableUnauthorizedAccount").withArgs(addr1.address);
    })
    it("must revert if called before original vault reservation", async function () {
      const FactoryFactory = await ethers.getContractFactory("SLSburnVaultFactory");
      const factory = await FactoryFactory.deploy(await eva.getAddress(), await burnVault.getAddress(), await wbtc.getAddress());
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.be.revertedWith("Must initialize original vault reservation first");
    })
    it("must revert if creation is paused", async function () {
      await factory.setCreationPaused(true);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.be.revertedWith("Vault creation is paused");
    })
    it("must rever if backing token is zero address", async function () {
      const zeroAddress = "0x0000000000000000000000000000000000000000";
      await expect(factory.createVault(zeroAddress, VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.be.revertedWith("Backing token cannot be zero address");
    })

    it("must revert if fixed EVA amount is zero", async function () {
      await expect(factory.createVault(await wbtc.getAddress(), 0, INITIAL_WBTC_BACKING)).to.be.revertedWith("Fixed EVA amount must be greater than 0");
    })

    it("must create a vault with initial backing", async function () {
      await eva.approve(await factory.getAddress(), ONE_EVA);
      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);
      const newVaults = await factory.getAllVaults();
      const newVault = newVaults[newVaults.length - 1];
      expect(await wbtc.balanceOf(newVault)).to.equal(INITIAL_WBTC_BACKING);
      expect(await eva.balanceOf(newVault)).to.equal(ONE_EVA);
    })
    it("must create a vault without initial backing", async function () {
      await eva.approve(await factory.getAddress(), ONE_EVA);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, 0)).to.changeTokenBalance(eva, owner.address, -ONE_EVA);
      const newVaults = await factory.getAllVaults();
      const newVault = newVaults[newVaults.length - 1];
      expect(await wbtc.balanceOf(newVault)).to.equal(0);
      expect(await eva.balanceOf(newVault)).to.equal(ONE_EVA);
    })
  })

  describe("On valut depletation logic", async function () {
    it("must revert if called by non vault", async function () {
      await expect(factory.onVaultDepletion()).to.be.revertedWith("Invalid vault address");
    })
    it("must correctly call depletation and reduce total vault count", async function () {
            await eva.approve(await factory.getAddress(), ONE_EVA);
      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);
      const newVaults = await factory.getAllVaults();
      const newVaultAddress = newVaults[newVaults.length - 1];
      const newVault = await ethers.getContractAt("SLSburnVault", newVaultAddress);
      await eva.approve(newVaultAddress, VAULT_FIXED_EVA);
      await expect(newVault.backingWithdraw(VAULT_FIXED_EVA - ONE_EVA)).to.changeTokenBalance(eva, owner.address, -VAULT_FIXED_EVA + ONE_EVA);
      const expectedVaultWbtcBalance = INITIAL_WBTC_BACKING - (VAULT_FIXED_EVA - ONE_EVA) * INITIAL_WBTC_BACKING / VAULT_FIXED_EVA;
      expect(expectedVaultWbtcBalance).to.equal(await wbtc.balanceOf(newVaultAddress));
      expect(expectedVaultWbtcBalance).to.equal(ethers.parseUnits("0.0001",8));
      await expect(newVault.adminFinalWithdraw()).to.changeTokenBalance(wbtc, owner.address, expectedVaultWbtcBalance);
      expect(await factory.totalVaultCount()).to.equal(1);
      expect(await wbtc.balanceOf(newVaultAddress)).to.equal(0);
      expect(await eva.totalSupply()).to.equal(ethers.parseEther("21000000") - VAULT_FIXED_EVA);
    })
  })

  describe("Pause and Unpause Creation", function () {
    it("pause must rever if called by non owner", async function () {
      await expect(factory.connect(addr1).setCreationPaused(true)).to.revertedWithCustomError(factory, "OwnableUnauthorizedAccount").withArgs(addr1.address);
    })
    it("Set creation paused must pause vault creations ", async function (){
      await expect(factory.setCreationPaused(true)).to.emit(factory, "CreationPauseToggled").withArgs(true);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.be.revertedWith("Vault creation is paused");
    })
    it("Set creation paused must unpause vault creations and revert if called when creation is not paused", async function (){
      await expect(factory.setCreationPaused(false)).to.emit(factory, "CreationPauseToggled").withArgs(false);
      await eva.approve(await factory.getAddress(), ONE_EVA);
      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);
    })

  })
  describe("View functions", function () {
    it("getTotalBackingByToken must return the correct total backing", async function () {
      await eva.approve(await factory.getAddress(), ONE_EVA * 2n);
      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING * 2n);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);
      expect(await factory.getTotalBackingByToken(await wbtc.getAddress())).to.equal(INITIAL_WBTC_BACKING * 2n);
    })
    it("getTotalBackingByToken must return 0 if no vaults exist", async function () {
      expect(await factory.getTotalBackingByToken(await wbtc.getAddress())).to.equal(0);
    })
    it("getTotalBackingByToken must return the correct total backing if multiple vaults exist with multiple backing tokens", async function () {
      await eva.approve(await factory.getAddress(), ONE_EVA * 2n);
      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING * 2n);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);
      expect(await factory.getTotalBackingByToken(await wbtc.getAddress())).to.equal(INITIAL_WBTC_BACKING * 2n);
      expect(await factory.getTotalBackingByToken(await eva.getAddress())).to.equal(0);

      //Deploy secondary backing token
      const SecondaryTokenFactory = await ethers.getContractFactory("Token");
      const secondaryToken = await SecondaryTokenFactory.deploy(ethers.parseUnits("100000", 18), "Secondary Token", "ST", 18);
      await secondaryToken.waitForDeployment();
      await eva.approve(await factory.getAddress(), ONE_EVA);
      await secondaryToken.approve(await factory.getAddress(), INITIAL_WBTC_BACKING);
      await expect(factory.createVault(await secondaryToken.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(secondaryToken, owner.address, -INITIAL_WBTC_BACKING);


      //First token must still return the right amount
      expect(await factory.getTotalBackingByToken(await wbtc.getAddress())).to.equal(INITIAL_WBTC_BACKING * 2n);
      expect(await factory.getTotalBackingByToken(await eva.getAddress())).to.equal(0);

      //Secondary token must return the right amount
      expect(await factory.getTotalBackingByToken(await secondaryToken.getAddress())).to.equal(INITIAL_WBTC_BACKING);
    })

    it("getVaultCount must return the correct number of vaults", async function () {
      await eva.approve(await factory.getAddress(), ONE_EVA * 2n);
      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING * 2n);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);
      expect(await factory.getVaultCount()).to.equal(2);
    })

    it("getVaultsByBackingToken must return the correct vaults", async function () {
      await eva.approve(await factory.getAddress(), ONE_EVA * 2n);
      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING * 2n);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);
      const vaults = await factory.getVaultsByBackingToken(await wbtc.getAddress());
      expect(vaults.length).to.equal(2);
      expect(vaults[0]).to.equal((await factory.getAllVaults())[0]);
      expect(vaults[1]).to.equal((await factory.getAllVaults())[1]);

      //Deploy secondary backing token
      const SecondaryTokenFactory = await ethers.getContractFactory("Token");
      const secondaryToken = await SecondaryTokenFactory.deploy(ethers.parseUnits("100000", 18), "Secondary Token", "ST", 18);
      await secondaryToken.waitForDeployment();
      await eva.approve(await factory.getAddress(), ONE_EVA);
      await secondaryToken.approve(await factory.getAddress(), INITIAL_WBTC_BACKING);
      await expect(factory.createVault(await secondaryToken.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(secondaryToken, owner.address, -INITIAL_WBTC_BACKING);
      const secondaryVaults = await factory.getVaultsByBackingToken(await secondaryToken.getAddress());
      expect(secondaryVaults.length).to.equal(1);
      expect(secondaryVaults[0]).to.equal((await factory.getAllVaults())[2]);
    })

    it("isValidVault must return the correct value", async function () {
      await eva.approve(await factory.getAddress(), ONE_EVA * 2n);
      await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING * 2n);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);
      await expect(factory.createVault(await wbtc.getAddress(), VAULT_FIXED_EVA, INITIAL_WBTC_BACKING)).to.changeTokenBalance(wbtc, owner.address, -INITIAL_WBTC_BACKING);
      expect(await factory.isValidVault((await factory.getAllVaults())[0])).to.equal(true);
      expect(await factory.isValidVault((await factory.getAllVaults())[1])).to.equal(true);
    })
    it("isValidVault must return false if vault does not exist", async function () {
      const zeroAddress = "0x0000000000000000000000000000000000000000";
      expect(await factory.isValidVault(zeroAddress)).to.equal(false);
    })

  })
});