import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const payerModule = buildModule("payerModule", (m) => {
  const addrEva = m.getParameter("addrEva");
  const payerWallet = m.getParameter(
    "payerWallet",
    "0x3a174E2317F657521fd54E296391fC65E883F5c8" //Arbitrum USDT
  );

  const addrWbtc = m.getParameter(
    "addrWbtc",
    "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f"
  );

  const addrEvaBurnVault = m.getParameter(
    "addrEvaBurnVault",
    "0xA89d65deF0A001947d8D5fDda93F9C4f8453902e"
  );
  const payer = m.contract(
    "Payer",
    [payerWallet, addrWbtc, addrEvaBurnVault],
    {}
  );

  return { payer };
});

export default payerModule;
