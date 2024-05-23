import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { erc20 } from "../../typechain-types/@openzeppelin/contracts/token";

const evaMarketModule = buildModule("evaMarketModule", (m) => {
  const addrEva = m.getParameter("addrEva");
  const addrMarketToken = m.getParameter(
    "addrMarketToken",
    "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" //Arbitrum USDT
  );
  const addrNewOwner = m.getParameter(
    "owner",
    "0xba8307396eD8B503Ad49fff4f28d65D5eb36677A" //Arbitrum admin wallet
  );
  const marketTokenPer100Eva = 35;
  const fee = 10;
  const evaMarket = m.contract(
    "EVAMarket",
    [addrEva, addrMarketToken, marketTokenPer100Eva, fee],
    {}
  );
  m.call(evaMarket, "transferOwnership", [addrNewOwner], {});

  return { evaMarket };
});

export default evaMarketModule;
