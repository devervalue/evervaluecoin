import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const positionMarketModule = buildModule("positionMarketModule", (m) => {
  // EVALocker (position NFT) address — deploy EVALocker first and pass it here.
  const addrLocker = m.getParameter("addrLocker");
  const addrWbtc = m.getParameter(
    "addrWbtc",
    "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" // WBTC on Arbitrum
  );
  // Minimum EVA a position must hold to be listed (anti-spam floor). Default 10 EVA.
  const minListAmount = m.getParameter("minListAmount", "10000000000000000000");

  const positionMarket = m.contract("PositionMarket", [addrLocker, addrWbtc, minListAmount], {});

  return { positionMarket };
});

export default positionMarketModule;
