import hre from "hardhat";
import slsBurnVaultFactoryModule from "../ignition/modules/SLSburnVaultFactory";

async function main() {
  // EVA token address already deployed on mainnet
  const addrEva = "0x45d9831d8751b2325f3dbf48db748723726e1c8c";
  
  console.log("Deploying SLS system to mainnet...");
  console.log("Using existing EVA address:", addrEva);

  // Deploy SLSburnVaultFactory
  const { slsBurnVaultFactory } = await hre.ignition.deploy(slsBurnVaultFactoryModule, {
    parameters: {
      slsBurnVaultFactoryModule: { 
        addrEva: addrEva
      },
    },
  });

  const factoryAddress = await slsBurnVaultFactory.getAddress();
  console.log("SLSburnVaultFactory deployed to:", factoryAddress);

  // Verify the factory contract
  console.log("Verifying SLSburnVaultFactory contract...");
  try {
    await hre.run("verify:verify", {
      address: factoryAddress,
      constructorArguments: [addrEva],
    });
    console.log("SLSburnVaultFactory verified successfully!");
  } catch (error) {
    console.log("Verification failed:", error);
  }

  console.log("\n=== SLS DEPLOYMENT COMPLETE ===");
  console.log("EVA Token Address:", addrEva);
  console.log("SLSburnVaultFactory Address:", factoryAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
