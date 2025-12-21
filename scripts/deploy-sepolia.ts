import { ethers, run } from "hardhat";

async function main() {
  const deployer = (await ethers.getSigners())[0];
  console.log("Deployer:", deployer.address);
  console.log("Balance:", await deployer.provider!.getBalance(deployer.address));

  // Deploy EverValueCoin
  const Eva = await ethers.getContractFactory("EverValueCoin");
  const eva = await Eva.deploy();
  await eva.waitForDeployment();
  console.log("EverValueCoin:", await eva.getAddress());

  // Deploy mock WBTC (Token) for testing/backing on Sepolia
  const Token = await ethers.getContractFactory("Token");
  const wbtc = await Token.deploy(
    ethers.parseUnits("21000000", 8), // total supply
    "Wrapped Bitcoin",
    "WBTC",
    8
  );
  await wbtc.waitForDeployment();
  console.log("WBTC mock:", await wbtc.getAddress());

  // Deploy legacy EVABurnVault and fund it with 300 WBTC
  const BurnVault = await ethers.getContractFactory("EVABurnVault");
  const burnVault = await BurnVault.deploy(await eva.getAddress(), await wbtc.getAddress());
  await burnVault.waitForDeployment();
  console.log("EVABurnVault:", await burnVault.getAddress());

  // Deploy SLSburnVaultFactory
  const Factory = await ethers.getContractFactory("SLSburnVaultFactory");
  const factory = await Factory.deploy(await eva.getAddress());
  await factory.waitForDeployment();
  console.log("SLSburnVaultFactory:", await factory.getAddress());

  // Deploy SLSPayer pointing to the legacy burn vault
  const Payer = await ethers.getContractFactory("SLSPayer");
  const payer = await Payer.deploy(
    await wbtc.getAddress(),
    await burnVault.getAddress(),
    await factory.getAddress(),
    [deployer.address, "0xDcd9Df090165b78ea7Db345b61575cD6D8E41738"]
  );
  await payer.waitForDeployment();
  console.log("SLSPayer:", await payer.getAddress());

  // Optional: create first SLS vault
  const FIXED_EVA = ethers.parseEther("100000"); // 100,000 EVA
  const INITIAL_WBTC_BACKING = ethers.parseUnits("25", 8); // 25 WBTC (8 decimals)
  const INITIAL_BURNVAULT_WBTC = ethers.parseUnits("300", 8); // 300 WBTC for legacy burn vault

  // Fund legacy burn vault
  await (await wbtc.transfer(await burnVault.getAddress(), INITIAL_BURNVAULT_WBTC)).wait();

  // Approve factory to pull initial backing
  await (await wbtc.approve(await factory.getAddress(), INITIAL_WBTC_BACKING)).wait();

  const txCreate = await factory.createVault(
    await wbtc.getAddress(),
    FIXED_EVA,
    INITIAL_WBTC_BACKING
  );
  await txCreate.wait();
  const vaultAddress = await factory.activeVault();
  console.log("First SLSburnVault:", vaultAddress);

  // Verify (Etherscan V2). Ensure ETHERSCAN_API_KEY is set.
  // If verification fails due to propagation, it will just log and continue.
  const verify = async (address: string, args: any[]) => {
    try {
      await run("verify:verify", { address, constructorArguments: args });
      console.log("Verified", address);
    } catch (err: any) {
      console.log("Verification skipped/failed for", address, "-", err.message ?? err);
    }
  };

  await verify(await eva.getAddress(), []);
  await verify(await wbtc.getAddress(), [ethers.parseUnits("21000000", 8), "Wrapped Bitcoin", "WBTC", 8]);
  await verify(await burnVault.getAddress(), [await eva.getAddress(), await wbtc.getAddress()]);
  await verify(await factory.getAddress(), [await eva.getAddress()]);
  await verify(await payer.getAddress(), [
    await wbtc.getAddress(),
    await burnVault.getAddress(),
    await factory.getAddress(),
    [deployer.address],
  ]);
  if (vaultAddress) {
    await verify(vaultAddress, [
      await eva.getAddress(),
      await wbtc.getAddress(),
      FIXED_EVA,
      await factory.getAddress(),
    ]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

