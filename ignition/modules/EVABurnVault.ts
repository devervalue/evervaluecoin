import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const evaBurnVaultModule = buildModule("evaBurnVaultModule", (m) => {
  const addrEva = m.getParameter("addrEva");
  const addrWbtc = m.getParameter(
    "addrWbtc",
    "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f"
  );
  const evaBurnVault = m.contract("EVABurnVault", [addrEva, addrWbtc], {});

  return { evaBurnVault };
});

export default evaBurnVaultModule;
