import hre from "hardhat";
import evaModule from "../ignition/modules/EverValueCoin";
import evaMarketModule from "../ignition/modules/EVAMarket";
import evaBurnVaultModule from "../ignition/modules/EVABurnVault";
import erc20Module from "../ignition/modules/token";
async function main() {
  const { eva } = await hre.ignition.deploy(evaModule);
  const [owner] = await hre.ethers.getSigners();

  const addrEva = (await eva.getAddress()).toLocaleLowerCase();

  const { evaBurnVault } = await hre.ignition.deploy(evaBurnVaultModule, {
    parameters: {
      evaBurnVaultModule: { addrEva: addrEva },
    },
  });

  const { evaMarket } = await hre.ignition.deploy(evaMarketModule, {
    parameters: {
      evaMarketModule: {
        addrEva: addrEva,
      },
    },
  });

  // Verify the contracts
  await hre.run("verify:verify", {
    address: addrEva,
    constructorArguments: [],
  });

  const addrBurnVault = await evaBurnVault.getAddress();
  await hre.run("verify:verify", {
    address: addrBurnVault,
    constructorArguments: [
      addrEva,
      "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    ], // WBTC address
  });

  const addrMarket = await evaMarket.getAddress();
  await hre.run("verify:verify", {
    address: addrMarket,
    constructorArguments: [
      addrEva,
      "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      35,
      10,
    ], // USDT address and other parameters
  });

  console.log("Everything deployed...");
  console.log({ addrEva, addrBurnVault, addrMarket });
}

main().catch(console.error);
