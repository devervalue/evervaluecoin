import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const DAY = 86400;

// Curve enum: 0 = LINEAR, 1 = QUADRATIC, 2 = SQRT
const evaLockerModule = buildModule("evaLockerModule", (m) => {
  const addrEva = m.getParameter(
    "addrEva",
    "0x45d9831d8751b2325f3dbf48db748723726e1c8c" // EVA on Arbitrum
  );
  const addrWbtc = m.getParameter(
    "addrWbtc",
    "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" // WBTC on Arbitrum
  );
  const addrCoreVault = m.getParameter(
    "addrCoreVault",
    "0xA89d65deF0A001947d8D5fDda93F9C4f8453902e" // original EVABurnVault
  );

  // Tier config — CONFIRMED linear scale: 3mo 1x, 6mo 2x, 12mo 3x, 24mo 4x (all tradable),
  // plus the 24mo founder tier (weight 0, soulbound). All early-exit curves LINEAR.
  const weights = m.getParameter("weights", [1, 2, 3, 4, 0]);
  const durations = m.getParameter("durations", [90 * DAY, 180 * DAY, 365 * DAY, 730 * DAY, 730 * DAY]);
  const curves = m.getParameter("curves", [0, 0, 0, 0, 0]);
  // Per-tier transferability: founder/trust tier (last) is soulbound.
  const transferables = m.getParameter("transferables", [true, true, true, true, false]);

  const evaLocker = m.contract(
    "EVALocker",
    [addrEva, addrWbtc, addrCoreVault, weights, durations, curves, transferables],
    {}
  );

  return { evaLocker };
});

export default evaLockerModule;
