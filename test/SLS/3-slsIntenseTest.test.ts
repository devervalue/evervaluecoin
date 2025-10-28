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

describe("SLSburnVault - Intense Test Suite", function () {
  // Signers
  let owner: SignerWithAddress;
  let addr1: SignerWithAddress;
  let addr2: SignerWithAddress;
  let addr3: SignerWithAddress;
  let addr4: SignerWithAddress;
  let addr5: SignerWithAddress;
  let addr6: SignerWithAddress;
  let addr7: SignerWithAddress;
  let addr8: SignerWithAddress;
  let addr9: SignerWithAddress;
  let addr10: SignerWithAddress;

  // Core
  let eva: EverValueCoin;
  let burnVault: EVABurnVault;
  let factory: SLSburnVaultFactory;

  // Market tokens with varying decimals
  let wbtc: Token; // 6 decimals
  let token2: Token; // 8 decimals (WBTC-like)
  let token3: Token; // 9 decimals
  let token4: Token; // 12 decimals
  let token5: Token; // 18 decimals

  const ONE_EVA = ethers.parseEther("1");

  beforeEach(async function () {
    [owner, addr1, addr2, addr3, addr4, addr5, addr6, addr7, addr8, addr9, addr10] = await ethers.getSigners();

    // Deploy EVA (21M fixed supply minted to owner)
    const EvaFactory = await ethers.getContractFactory("EverValueCoin");
    eva = await EvaFactory.deploy();
    await eva.waitForDeployment();

    // Deploy five mock tokens with different decimals
    const TokenFactory = await ethers.getContractFactory("Token");
    wbtc = await TokenFactory.deploy(ethers.parseUnits("1000000000", 6),  "Wrapped Bitcoin", "wBTC", 8); // will works as wBTC for original burnVault
    await wbtc.waitForDeployment();
    token2 = await TokenFactory.deploy(ethers.parseUnits("1000000000", 8),  "Token 2", "TK2", 6);
    await token2.waitForDeployment();
    token3 = await TokenFactory.deploy(ethers.parseUnits("1000000000", 9),  "Token 3", "TK3", 9);
    await token3.waitForDeployment();
    token4 = await TokenFactory.deploy(ethers.parseUnits("1000000000", 12), "Token 4", "TK4", 12);
    await token4.waitForDeployment();
    token5 = await TokenFactory.deploy(ethers.parseUnits("1000000000", 18), "Token 5", "TK5", 18);
    await token5.waitForDeployment();

    // Deploy EVABurnVault using EVA and token2 (8 decimals) as the backing token
    const BurnVaultFactory = await ethers.getContractFactory("EVABurnVault");
    burnVault = await BurnVaultFactory.deploy(
      await eva.getAddress(),
      await token2.getAddress()
    );
    await burnVault.waitForDeployment();

    // Deploy SLSburnVaultFactory (do NOT deploy SLS vaults here)
    const FactoryFactory = await ethers.getContractFactory("SLSburnVaultFactory");
    factory = await FactoryFactory.deploy(await eva.getAddress(), await burnVault.getAddress(), await wbtc.getAddress());
    await factory.waitForDeployment();

    // Initialize original vault reservation (transfer 1 EVA to factory and initialize)
    await eva.transfer(await factory.getAddress(), ONE_EVA);
    await factory.initializeOriginalVaultReservation();

    //Initial funding for the burnVault
    await wbtc.transfer(await burnVault.getAddress(), ethers.parseUnits("180", 8));
  });

  it("Will keep all the backing accesible in multi vault scenario", async function(){
    //Deploy 10 vaults
    await wbtc.approve(await factory.getAddress(), ethers.parseUnits("100000000000", 18));
    await eva.approve(await factory.getAddress(), ONE_EVA * 1000n);
    const vaults = [];
    /// Total of 100 vaults covering 10.000.000 EVA (100.000 EVA per vault)
    for(let i = 0; i < 100; i++){
        const vault = await factory.createVault(await wbtc.getAddress(), ethers.parseUnits("100000", 18), ethers.parseUnits("10", 8) * BigInt((i+1)*10));
        const allVaults = await factory.getAllVaults();
        const newVaultAddress = allVaults[allVaults.length - 1];
        const newVault = await ethers.getContractAt("SLSburnVault", newVaultAddress);
        vaults.push(newVault);
        expect(await eva.balanceOf(newVaultAddress)).to.equal(ONE_EVA);
        expect(await newVault.getEffectiveEvaAmount()).to.equal(ethers.parseUnits("100000", 18) - ONE_EVA);
    }
    expect(await eva.balanceOf(owner.address)).to.equal(ethers.parseEther("21000000") - ONE_EVA * 101n);

    //Now the system will enter in a state where the total supply of EVA is less or equal than the total vault count * ONE_EVA
    await eva.burn(ethers.parseUnits("21000000", 18) - ONE_EVA * 101n);
    expect(await eva.totalSupply()).to.equal(ONE_EVA * 101n);
    expect(await factory.totalVaultCount()).to.equal(101);
    for(const vault of vaults){
        expect(await vault.getEffectiveEvaAmount()).to.equal(0);
        expect(await vault.adminFinalWithdraw()).to.changeTokenBalance(wbtc, owner.address, await wbtc.balanceOf(await vault.getAddress()));
        expect(await wbtc.balanceOf(await vault.getAddress())).to.equal(0);
    }
  })

})