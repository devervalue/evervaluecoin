import { ethers } from "hardhat";
import chai from "chai";
import { EverValueCoin, Token } from "../../typechain-types";
import hre from "hardhat";
import erc20Module from "../../ignition/modules/token";
import evaModule from "../../ignition/modules/EverValueCoin";
const { expect } = chai;

describe("Burn vault constructor fail requires", function () {
  let eva: EverValueCoin;
  let wbtc: Token;
  let usdt: Token;
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  beforeEach(async function () {
    const [owner] = await ethers.getSigners();
    wbtc = (
      await hre.ignition.deploy(erc20Module, {
        parameters: {
          erc20Module: {
            name: "Wrapped Bitcoin",
            symbol: "WBTC",
            totalSupply: BigInt(21000000) * BigInt(10) ** BigInt(18),
          },
        },
      })
    ).erc20 as unknown as Token;
    eva = (await hre.ignition.deploy(evaModule))
      .eva as unknown as EverValueCoin;

    usdt = (
      await hre.ignition.deploy(erc20Module, {
        parameters: {
          erc20Module: {
            name: "USD Tether",
            symbol: "USDT",
            totalSupply: BigInt(1000000000) * BigInt(10) ** BigInt(18),
          },
        },
      })
    ).erc20 as unknown as Token;
  });

  it("Contract deployment may fail setting EVA address as zero address", async function () {
    const [owner] = await ethers.getSigners();
    const burnVault = await ethers.getContractFactory("EVABurnVault");
    await expect(
      burnVault.deploy(zeroAddress, wbtc.getAddress())
    ).to.revertedWith("Cannot set EVA to zero address");
  });

  it("Contract deployment may fail setting EVA address as zero address", async function () {
    const [owner] = await ethers.getSigners();
    const burnVault = await ethers.getContractFactory("EVABurnVault");
    await expect(
      burnVault.deploy(eva.getAddress(), zeroAddress)
    ).to.revertedWith("Cannot set wBTC to zero address");
  });
});
