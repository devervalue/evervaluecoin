import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const slsBurnVaultModule = buildModule("slsBurnVaultModule", (m) => {
  const addrEva = m.getParameter("addrEva");
  const addrBackingToken = m.getParameter(
    "addrBackingToken",
    "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" //Default: Arbitrum WBTC, but can be any ERC20 token
  );
  const fixedEvaAmount = m.getParameter(
    "fixedEvaAmount",
    "1000000000000000000000000" // 1M EVA tokens (18 decimals)
  );
  const addrFactory = m.getParameter("addrFactory");
  
  const slsBurnVault = m.contract("SLSburnVault", [addrEva, addrBackingToken, fixedEvaAmount, addrFactory], {});

  return { slsBurnVault };
});

export default slsBurnVaultModule;
