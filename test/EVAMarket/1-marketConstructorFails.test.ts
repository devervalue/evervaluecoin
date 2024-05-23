import { ethers } from "hardhat";
import chai from "chai";
import { EverValueCoin, Token } from "../../typechain-types";
import hre from "hardhat";
import erc20Module from "../../ignition/modules/token";
import evaModule from "../../ignition/modules/EverValueCoin";
const { expect } = chai;

describe("Market constructor fail requires", function () {
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
    const Market = await ethers.getContractFactory("EVAMarket");
    await expect(
      Market.deploy(zeroAddress, usdt.getAddress(), 35, 10)
    ).to.revertedWith("Cannot set EVA to zero address");
  });

  it("Contract deployment may fail setting marketToken address as zero address", async function () {
    const [owner] = await ethers.getSigners();
    const Market = await ethers.getContractFactory("EVAMarket");
    await expect(
      Market.deploy(eva.getAddress(), zeroAddress, 35, 10)
    ).to.revertedWith("Cannot set market token to zero address");
  });

  it("Contract deployment may fail setting _marketTokenPer100Eva as zero", async function () {
    const [owner] = await ethers.getSigners();
    const Market = await ethers.getContractFactory("EVAMarket");
    await expect(
      Market.deploy(eva.getAddress(), wbtc.getAddress(), 0, 10)
    ).to.revertedWith("Rate must be greater than 0");
  });

  it("Contract deployment may fail setting fee  greatter than 1000", async function () {
    const [owner] = await ethers.getSigners();
    const Market = await ethers.getContractFactory("EVAMarket");
    await expect(
      Market.deploy(eva.getAddress(), wbtc.getAddress(), 35, 1001)
    ).to.revertedWith("Fee must be lesser than 1000");
  });
});
