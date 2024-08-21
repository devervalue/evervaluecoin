import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { erc20 } from "../../typechain-types/@openzeppelin/contracts/token";

const evaMarketWbtcModule = buildModule("evaMarketWbtcModule", (m) => {
  const addrEva = m.getParameter("addrEva");
  const addrMarketToken = m.getParameter(
    "addrMarketToken",
    "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" //Arbitrum Wbtc
  );

  const marketTokenDecimals = m.getParameter("marketTokenDecimals", 18);
  const addrNewOwner = m.getParameter(
    "owner",
    "0x91962f8404692DFf6898624831D332793036485C" //Arbitrum admin wallet
  );

  const marketTokenPerPrecitionEva = m.getParameter(
    "marketTokenPerPrecitionEva",
    443
  );
  const fee = m.getParameter("fee", 10);
  const evaMarket = m.contract(
    "EVAMarketWbtc",
    [
      addrEva,
      addrMarketToken,
      marketTokenPerPrecitionEva,
      fee,
      marketTokenDecimals,
    ],
    {}
  );
  m.call(evaMarket, "transferOwnership", [addrNewOwner], {});

  return { evaMarket };
});

export default evaMarketWbtcModule;
