import hre from "hardhat";
import evaModule from "../ignition/modules/EverValueCoin";
import evaMarketModule from "../ignition/modules/EVAMarket";
import evaBurnVaultModule from "../ignition/modules/EVABurnVault";
import erc20Module from "../ignition/modules/token";
async function main() {
  const { eva } = await hre.ignition.deploy(evaModule);
  const [owner] = await hre.ethers.getSigners();
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

  const addrEva = (await eva.getAddress()).toLocaleLowerCase();
  const addrWbtc = (await wbtc.getAddress()).toLocaleLowerCase();
  const addrUsdt = (await usdt.getAddress()).toLocaleLowerCase();

  const { evaBurnVault } = await hre.ignition.deploy(evaBurnVaultModule, {
    parameters: {
      bttBurnVaultModule: { addrEva: addrEva, addrWbtc: addrWbtc },
    },
  });

  const { evaMarket } = await hre.ignition.deploy(evaMarketModule, {
    parameters: {
      bttMarketModule: {
        addrEva: addrEva,
        addrMarketToken: addrUsdt,
        owner: owner.address,
      },
    },
  });
}

main().catch(console.error);
