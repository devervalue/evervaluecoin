import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const revenueRouterModule = buildModule("revenueRouterModule", (m) => {
  const addrWbtc = m.getParameter(
    "addrWbtc",
    "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" // WBTC on Arbitrum
  );
  const addrCoreVault = m.getParameter(
    "addrCoreVault",
    "0xA89d65deF0A001947d8D5fDda93F9C4f8453902e" // original EVABurnVault
  );
  // SLSburnVaultFactory address (set once known on the target network).
  const addrFactory = m.getParameter("addrFactory");
  // EVALocker address (deploy EVALocker first, then pass it here).
  const addrLocker = m.getParameter("addrLocker");
  // Addresses initially allowed to call pay().
  const initialCallers = m.getParameter("initialCallers", []);

  const revenueRouter = m.contract(
    "RevenueRouter",
    [addrWbtc, addrCoreVault, addrFactory, addrLocker, initialCallers],
    {}
  );

  return { revenueRouter };
});

export default revenueRouterModule;
