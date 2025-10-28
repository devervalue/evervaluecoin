import hre from "hardhat";
import evaModule from "../ignition/modules/EverValueCoin";
import slsBurnVaultFactoryModule from "../ignition/modules/SLSburnVaultFactory";
import erc20Module from "../ignition/modules/token";
import evaBurnVaultModule from "../ignition/modules/EVABurnVault";

async function main() {
  console.log("Deploying SLS system for testing...");
  
  // Deploy EVA token for testing
  const { eva } = await hre.ignition.deploy(evaModule);
  const addrEva = (await eva.getAddress()).toLowerCase();
  console.log("EVA Token deployed to:", addrEva);

  // Deploy some test tokens for backing
  const wbtc = (
    await hre.ignition.deploy(erc20Module, {
      parameters: {
        erc20Module: {
          name: "Wrapped Bitcoin",
          symbol: "WBTC",
          totalSupply: BigInt(21000000) * BigInt(10) ** BigInt(18),
        },
      },
    })
  ).erc20;

  const usdt = (
    await hre.ignition.deploy(erc20Module, {
      parameters: {
        erc20Module: {
          name: "USD Tether",
          symbol: "USDT",
          totalSupply: BigInt(1000000000) * BigInt(10) ** BigInt(18),
        },
      },
    })
  ).erc20;

  const addrWbtc = (await wbtc.getAddress()).toLowerCase();
  const addrUsdt = (await usdt.getAddress()).toLowerCase();
  
  console.log("WBTC Test Token deployed to:", addrWbtc);
  console.log("USDT Test Token deployed to:", addrUsdt);


  //Deploy EVABurnVault
  const { evaBurnVault } = await hre.ignition.deploy(evaBurnVaultModule, {
    parameters: {
      evaBurnVaultModule: { addrEva: addrEva, addrWbtc: addrWbtc },
    },
  });
  const addrEvaBurnVault = (await evaBurnVault.getAddress()).toLowerCase();
  // Deploy SLSburnVaultFactory
  const { slsBurnVaultFactory } = await hre.ignition.deploy(slsBurnVaultFactoryModule, {
    parameters: {
      slsBurnVaultFactoryModule: { 
        addrEva: addrEva,
        addrBackingToken: addrWbtc,
        addrBurnVault: addrEvaBurnVault,
      },
    },
  });

  const factoryAddress = await slsBurnVaultFactory.getAddress();
  console.log("SLSburnVaultFactory deployed to:", factoryAddress);

  console.log("\n=== SLS TESTING DEPLOYMENT COMPLETE ===");
  console.log("EVA Token Address:", addrEva);
  console.log("WBTC Test Token Address:", addrWbtc);
  console.log("USDT Test Token Address:", addrUsdt);
  console.log("SLSburnVaultFactory Address:", factoryAddress);

  return {
    eva: addrEva,
    wbtc: addrWbtc,
    usdt: addrUsdt,
    factory: factoryAddress
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
