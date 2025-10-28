import { ethers } from "hardhat";
import { expect } from "chai";
import { 
  SLSburnVault, 
  EverValueCoin, 
  Token,
  MockSLSburnVaultFactory
} from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("SLSburnVault - Comprehensive Unit Tests", function () {
  // Contract instances
  let eva: EverValueCoin;
  let wbtc: Token;
  let usdt: Token;
  let usdc: Token;
  let dai: Token;
  let link: Token;
  let mockFactory: MockSLSburnVaultFactory;
  
  // Vault instances for each backing token
  let wbtcVault: SLSburnVault;
  let usdtVault: SLSburnVault;
  let usdcVault: SLSburnVault;
  let daiVault: SLSburnVault;
  let linkVault: SLSburnVault;

  // Signers
  let owner: SignerWithAddress;
  let addr1: SignerWithAddress;
  let addr2: SignerWithAddress;
  let addr3: SignerWithAddress;
  let addr4: SignerWithAddress;
  let addr5: SignerWithAddress;

  // Constants
  const ONE_EVA = ethers.parseEther("1");
  const EVA_TOTAL_SUPPLY = ethers.parseEther("21000000"); // 21M EVA
  const VAULT_FIXED_EVA = ethers.parseEther("1000000"); // 1M EVA per vault
  
  // Backing token amounts (different decimals to test edge cases)
  const WBTC_AMOUNT = ethers.parseUnits("100", 8);      // 100 WBTC (8 decimals)
  const USDT_AMOUNT = ethers.parseUnits("1000000", 6);  // 1M USDT (6 decimals)
  const USDC_AMOUNT = ethers.parseUnits("1000000", 6);  // 1M USDC (6 decimals)
  const DAI_AMOUNT = ethers.parseUnits("1000000", 18);  // 1M DAI (18 decimals)
  const LINK_AMOUNT = ethers.parseUnits("50000", 18);   // 50K LINK (18 decimals)

  beforeEach(async function () {
    // Get signers
    [owner, addr1, addr2, addr3, addr4, addr5] = await ethers.getSigners();

    // ===== Deploy EVA Token =====
    const EvaFactory = await ethers.getContractFactory("EverValueCoin");
    eva = await EvaFactory.deploy();
    await eva.waitForDeployment();

    // ===== Deploy Backing Tokens =====
    const TokenFactory = await ethers.getContractFactory("Token");
    
    // WBTC (8 decimals)
    wbtc = await TokenFactory.deploy(
      ethers.parseUnits("21000000", 8),
      "Wrapped Bitcoin",
      "WBTC",
      8
    );
    await wbtc.waitForDeployment();

    // USDT (6 decimals)
    usdt = await TokenFactory.deploy(
      ethers.parseUnits("1000000000", 6),
      "Tether USD",
      "USDT",
      6
    );
    await usdt.waitForDeployment();

    // USDC (6 decimals)
    usdc = await TokenFactory.deploy(
      ethers.parseUnits("1000000000", 6),
      "USD Coin",
      "USDC",
      6
    );
    await usdc.waitForDeployment();

    // DAI (18 decimals)
    dai = await TokenFactory.deploy(
      ethers.parseUnits("1000000000", 18),
      "Dai Stablecoin",
      "DAI",
      18
    );
    await dai.waitForDeployment();

    // LINK (18 decimals)
    link = await TokenFactory.deploy(
      ethers.parseUnits("1000000000", 18),
      "Chainlink",
      "LINK",
      18
    );
    await link.waitForDeployment();

    // ===== Deploy Mock Factory =====
    const MockFactoryFactory = await ethers.getContractFactory("MockSLSburnVaultFactory");
    mockFactory = await MockFactoryFactory.deploy(5); // 5 SLS vaults
    await mockFactory.waitForDeployment();

    // ===== Deploy SLS Vaults =====
    const VaultFactory = await ethers.getContractFactory("SLSburnVault");
    
    // WBTC Vault
    wbtcVault = await VaultFactory.deploy(
      await eva.getAddress(),
      await wbtc.getAddress(),
      VAULT_FIXED_EVA,
      await mockFactory.getAddress()
    );
    await wbtcVault.waitForDeployment();

    // USDT Vault
    usdtVault = await VaultFactory.deploy(
      await eva.getAddress(),
      await usdt.getAddress(),
      VAULT_FIXED_EVA,
      await mockFactory.getAddress()
    );
    await usdtVault.waitForDeployment();

    // USDC Vault
    usdcVault = await VaultFactory.deploy(
      await eva.getAddress(),
      await usdc.getAddress(),
      VAULT_FIXED_EVA,
      await mockFactory.getAddress()
    );
    await usdcVault.waitForDeployment();

    // DAI Vault
    daiVault = await VaultFactory.deploy(
      await eva.getAddress(),
      await dai.getAddress(),
      VAULT_FIXED_EVA,
      await mockFactory.getAddress()
    );
    await daiVault.waitForDeployment();

    // LINK Vault
    linkVault = await VaultFactory.deploy(
      await eva.getAddress(),
      await link.getAddress(),
      VAULT_FIXED_EVA,
      await mockFactory.getAddress()
    );
    await linkVault.waitForDeployment();

    // ===== Transfer 1 EVA to Each Vault =====
    await eva.transfer(await wbtcVault.getAddress(), ONE_EVA);
    await eva.transfer(await usdtVault.getAddress(), ONE_EVA);
    await eva.transfer(await usdcVault.getAddress(), ONE_EVA);
    await eva.transfer(await daiVault.getAddress(), ONE_EVA);
    await eva.transfer(await linkVault.getAddress(), ONE_EVA);

    // ===== Transfer Backing Tokens to Vaults =====
    await wbtc.transfer(await wbtcVault.getAddress(), WBTC_AMOUNT);
    await usdt.transfer(await usdtVault.getAddress(), USDT_AMOUNT);
    await usdc.transfer(await usdcVault.getAddress(), USDC_AMOUNT);
    await dai.transfer(await daiVault.getAddress(), DAI_AMOUNT);
    await link.transfer(await linkVault.getAddress(), LINK_AMOUNT);

    // ===== Setup Approvals =====
    const vaults = [wbtcVault, usdtVault, usdcVault, daiVault, linkVault];
    const users = [addr1, addr2, addr3, addr4, addr5];
    
    for (const user of users) {
      for (const vault of vaults) {
        await eva.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
      }
    }

    // ===== Distribute EVA to Users =====
    const evaPerUser = ethers.parseEther("100000"); // 100K EVA each
    await eva.transfer(addr1.address, evaPerUser);
    await eva.transfer(addr2.address, evaPerUser);
    await eva.transfer(addr3.address, evaPerUser);
    await eva.transfer(addr4.address, evaPerUser);
    await eva.transfer(addr5.address, evaPerUser);
  });


  describe("Constructor Validations", function () {
    // Tests for constructor parameter validation
    it("constructor require fails", async function(){
        const zeroAddress = "0x0000000000000000000000000000000000000000";
        const VaultFactory = await ethers.getContractFactory("SLSburnVault");
        await expect(VaultFactory.deploy(zeroAddress, await wbtc.getAddress(), VAULT_FIXED_EVA, await mockFactory.getAddress())).to.be.revertedWith("Cannot set EVA to zero address");
        await expect(VaultFactory.deploy(await eva.getAddress(), zeroAddress, VAULT_FIXED_EVA, await mockFactory.getAddress())).to.be.revertedWith("Cannot set backing token to zero address");
        await expect(VaultFactory.deploy(await eva.getAddress(), await wbtc.getAddress(), ethers.parseEther("0.999999999"), await mockFactory.getAddress())).to.be.revertedWith("Fixed EVA amount must be greater than or equal to 1 EVA");
        await expect(VaultFactory.deploy(await eva.getAddress(), await wbtc.getAddress(), VAULT_FIXED_EVA, zeroAddress)).to.be.revertedWith("Cannot set factory to zero address");
    })
    it("constructor must fail if fixed EVA amount is greatter than EVA total supply", async function(){
        const VaultFactory = await ethers.getContractFactory("SLSburnVault");
        await expect(VaultFactory.deploy(await eva.getAddress(), await wbtc.getAddress(), ethers.parseEther("21000001"), await mockFactory.getAddress())).to.be.revertedWith("Fixed EVA amount cannot exceed total supply");
    })
  });

  describe("getEffectiveEvaAmount", function () {
    // Tests for effective EVA amount calculation
    it("must correctly return the effective EVA amount", async function(){
        const effectiveEva = await wbtcVault.getEffectiveEvaAmount();
        expect(effectiveEva).to.equal(VAULT_FIXED_EVA - ONE_EVA);
    })
    it("must correctly return the effective EVA amount when the vault has been depleted", async function(){
        await eva.approve(await wbtcVault.getAddress(), VAULT_FIXED_EVA - ONE_EVA);
        await wbtcVault.backingWithdraw(VAULT_FIXED_EVA - ONE_EVA);
        const effectiveEva = await wbtcVault.getEffectiveEvaAmount();
        expect(effectiveEva).to.equal(0);
    })
    it("must correctly return the effective EVA amount when EVA total supply is less than fixed EVA amount", async function(){
        //Reduce EVA total supply to 999999 EVA
        //All vaults are covering more than totalSupply
        await eva.burn(ethers.parseEther("20000000") + ONE_EVA);
        
        // Vaults must be covering totalSupply less totalVaultCount * ONE_EVA
        const totalVaultCount = await mockFactory.totalVaultCount();
        expect(await wbtcVault.getEffectiveEvaAmount()).to.equal(ethers.parseEther("999999") - totalVaultCount * ONE_EVA);
    })
    it("must correctly return the totalSupply is less than totalVaultCount * ONE_EVA", async function(){
        //Owner burns all its eva
        await eva.burn(await eva.balanceOf(owner.address));
        //Users burns all their eva
        await eva.connect(addr1).burn(await eva.balanceOf(addr1.address));
        await eva.connect(addr2).burn(await eva.balanceOf(addr2.address));
        await eva.connect(addr3).burn(await eva.balanceOf(addr3.address));
        await eva.connect(addr4).burn(await eva.balanceOf(addr4.address));
        await eva.connect(addr5).burn(await eva.balanceOf(addr5.address));
        //Vaults must be covering totalSupply less totalVaultCount * ONE_EVA
        const totalVaultCount = await mockFactory.totalVaultCount();
        expect(await wbtcVault.getEffectiveEvaAmount()).to.equal(0);
        expect(await usdtVault.getEffectiveEvaAmount()).to.equal(0);
        expect(await usdcVault.getEffectiveEvaAmount()).to.equal(0);
        expect(await daiVault.getEffectiveEvaAmount()).to.equal(0);
        expect(await linkVault.getEffectiveEvaAmount()).to.equal(0);
    })
  });

  describe("backingWithdraw - Basic Functionality", function () {
    it("must revert if effective EVA amount is 0", async function(){
        await eva.approve(await wbtcVault.getAddress(), VAULT_FIXED_EVA - ONE_EVA);
        await wbtcVault.backingWithdraw(VAULT_FIXED_EVA - ONE_EVA);
        expect(await wbtcVault.getEffectiveEvaAmount()).to.equal(0);
        await eva.approve(await wbtcVault.getAddress(), ONE_EVA);
        await expect(wbtcVault.backingWithdraw(ONE_EVA)).to.be.revertedWith("No EVA amount remaining in this vault");
    })
    it("must revert if amount exceeds effective EVA amount", async function(){
        await eva.approve(await wbtcVault.getAddress(), VAULT_FIXED_EVA);
        await expect(wbtcVault.backingWithdraw(VAULT_FIXED_EVA)).to.revertedWith("Amount exceeds remaining EVA in vault");
    })
    it("must revert if backing token balance is 0", async function(){
        //Deploy a new wbtcVault without backing tokens
        const VaultFactory = await ethers.getContractFactory("SLSburnVault");
        const newWbtcVault = await VaultFactory.deploy(
            await eva.getAddress(),
            await wbtc.getAddress(),
            VAULT_FIXED_EVA,
            await mockFactory.getAddress()
        );
        await newWbtcVault.waitForDeployment();
        await expect(newWbtcVault.backingWithdraw(ONE_EVA)).to.be.revertedWith("Nothing to withdraw");
    })
    it("must revert if backingToWithdraw is 0", async function(){
        await eva.approve(await wbtcVault.getAddress(), VAULT_FIXED_EVA);
        //Using a small amount to test the revert condition
        await expect(wbtcVault.backingWithdraw(1)).to.be.revertedWith("Nothing to withdraw");
    })
  });


  describe("adminFinalWithdraw", async function(){
    it("must revert if effective EVA amount is not 0", async function(){
        await eva.approve(await wbtcVault.getAddress(), VAULT_FIXED_EVA - ONE_EVA);
        await expect(wbtcVault.adminFinalWithdraw()).to.be.revertedWith("Can only withdraw when effective EVA amount is 0");
    })

    it("must revert if called by non owner", async function(){
        await expect(wbtcVault.connect(addr1).adminFinalWithdraw()).to.be.revertedWithCustomError(wbtcVault, "OwnableUnauthorizedAccount").withArgs(addr1.address);
    })
    it("must correctly burn the last EVA on the vault and transfer the remaining backing to the owner", async function(){
        await eva.approve(await wbtcVault.getAddress(), VAULT_FIXED_EVA - ONE_EVA);
        await wbtcVault.backingWithdraw(VAULT_FIXED_EVA - ONE_EVA);
        await expect(wbtcVault.adminFinalWithdraw()).to.changeTokenBalance(wbtc, owner.address, await wbtc.balanceOf(await wbtcVault.getAddress()));
    })
    it("must correctly re depleate vault without calling onVaultDepletion logic if vault already depleated", async function(){
        await eva.approve(await wbtcVault.getAddress(), VAULT_FIXED_EVA - ONE_EVA);
        await wbtcVault.backingWithdraw(VAULT_FIXED_EVA - ONE_EVA);
        await expect(wbtcVault.adminFinalWithdraw()).to.changeTokenBalance(wbtc, owner.address, await wbtc.balanceOf(await wbtcVault.getAddress()));
        eva.transfer(await wbtcVault.getAddress(), ONE_EVA);
        wbtc.transfer(await wbtcVault.getAddress(), ONE_EVA);
        const lastOnVaultDepletionCall = await mockFactory.getVaultDepletionCalls(await wbtcVault.getAddress());
        console.log(lastOnVaultDepletionCall);
        await expect(wbtcVault.adminFinalWithdraw()).to.changeTokenBalance(wbtc, owner.address, await wbtc.balanceOf(await wbtcVault.getAddress()));
        expect(await mockFactory.getVaultDepletionCalls(await wbtcVault.getAddress())).to.equal(lastOnVaultDepletionCall);
        expect(await eva.balanceOf(await wbtcVault.getAddress())).to.equal(0);
    })
  })

});