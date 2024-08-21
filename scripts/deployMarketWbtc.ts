import hre from "hardhat";
import evaMarketWbtcModule from "../ignition/modules/EVAMarketWbtc";
import erc20Module from "../ignition/modules/token";
async function main() {
  const [owner] = await hre.ethers.getSigners();

  const addrEva = "0x45d9831d8751b2325f3dbf48db748723726e1c8c";

  const { evaMarket } = await hre.ignition.deploy(evaMarketWbtcModule, {
    parameters: {
      evaMarketWbtcModule: {
        addrEva: addrEva,
        marketTokenDecimals: 8,
      },
    },
  });

  const addrMarket = await evaMarket.getAddress();
  await hre.run("verify:verify", {
    address: addrMarket,
    constructorArguments: [
      addrEva,
      "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
      443,
      10,
      8,
    ], // USDT address and other parameters
  });

  console.log("Everything deployed...");
  console.log({ addrMarket });
}

main().catch(console.error);
