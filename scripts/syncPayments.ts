import { ethers } from "hardhat";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Replay mainnet revenue payments on the Sepolia replica.
//
// Reads the production payer's daily WBTC outflows on Arbitrum One (one payment per day at 20:00 UTC,
// core + SLS) since the last replayed day, and executes each day's total through the Sepolia
// RevenueRouter with the replica's split (10/45/45, from demo-arbitrum-sepolia.json params.splitBps).
//
//   npx hardhat run scripts/syncPayments.ts --network arbitrumSepolia
//
// State: payments-sync.json at the repo root records the last replayed day and every replay (committed,
// so whoever runs it next continues from the right day). Env: DRY_RUN=1 (list only), MAINNET_RPC_URL
// (defaults to the public Arbitrum One RPC), DEMO_ADDR_FILE.
// ---------------------------------------------------------------------------

const STATE_FILE = "payments-sync.json";
const MAINNET = {
  rpc: process.env.MAINNET_RPC_URL || "https://arb1.arbitrum.io/rpc",
  wbtc: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  payer: "0x396ade2A476170cE7AB055AB44023Afad53658fd", // SLSPayer: single outflow source, pays core + SLS daily
};
const f8 = (x: bigint) => ethers.formatUnits(x, 8);
const dayOf = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

type State = { lastReplayedDay: string; replayed: { day: string; amountSats: string; tx: string; at: string }[] };

async function main() {
  const dryRun = process.env.DRY_RUN === "1";
  const state: State = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const addr = JSON.parse(fs.readFileSync(process.env.DEMO_ADDR_FILE || "demo-arbitrum-sepolia.json", "utf8"));
  const split = addr.params.splitBps as { core: number; sls: number; locker: number };

  // --- mainnet: aggregate payer outflows per UTC day after lastReplayedDay ---
  const mp = new ethers.JsonRpcProvider(MAINNET.rpc, 42161, { staticNetwork: true });
  const latest = await mp.getBlockNumber();
  const head = await mp.getBlock(latest);
  const back = await mp.getBlock(latest - 300_000);
  const bps = 300_000 / (head!.timestamp - back!.timestamp);
  const since = Date.parse(state.lastReplayedDay + "T00:00:00Z") / 1000 + 86400; // start of the next day
  if (head!.timestamp <= since) { console.log(`nothing to sync: last replayed ${state.lastReplayedDay}, mainnet now ${dayOf(head!.timestamp)}`); return; }
  const fromBlock = Math.max(0, latest - Math.ceil((head!.timestamp - since) * bps) - 20_000);
  const topic = ethers.id("Transfer(address,address,uint256)");
  const iface = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
  const logs = await mp.getLogs({ address: MAINNET.wbtc, topics: [topic, ethers.zeroPadValue(MAINNET.payer, 32)], fromBlock, toBlock: latest });
  const perDay = new Map<string, bigint>();
  for (const l of logs) {
    const b = await mp.getBlock(l.blockNumber);
    if (b!.timestamp < since) continue;
    const d = dayOf(b!.timestamp);
    perDay.set(d, (perDay.get(d) ?? 0n) + iface.parseLog(l)!.args.value);
  }
  const days = [...perDay.keys()].sort();
  console.log(`mainnet ${dayOf(head!.timestamp)} ${new Date(head!.timestamp * 1000).toISOString().slice(11, 16)} UTC | last replayed ${state.lastReplayedDay} | pending days: ${days.length}${dryRun ? "  [DRY RUN]" : ""}`);
  if (!days.length) return;

  // --- sepolia: replay ---
  const [me] = await ethers.getSigners();
  const router = await ethers.getContractAt("RevenueRouter", addr.contracts.RevenueRouter);
  const wbtc = await ethers.getContractAt("DemoMintableToken", addr.contracts.DWBTC);
  const need = days.reduce((s, d) => s + perDay.get(d)!, 0n);
  const float = await wbtc.balanceOf(addr.contracts.RevenueRouter);
  console.log(`router float ${f8(float)} DWBTC | needed ${f8(need)} | split ${split.core}/${split.sls}/${split.locker}`);
  if (float < need) throw new Error("router float too low: top up with scripts/payRevenue.ts TOPUP=…");

  for (const d of days) {
    const amt = perDay.get(d)!;
    if (dryRun) { console.log(`  ${d}  ${f8(amt)} DWBTC  (would pay)`); continue; }
    const tx = await router.pay(amt, split.core, split.sls, split.locker, true, 0);
    const r = await tx.wait();
    state.replayed.push({ day: d, amountSats: amt.toString(), tx: tx.hash, at: new Date().toISOString() });
    state.lastReplayedDay = d;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`  ${d}  ${f8(amt)} DWBTC  tx ${tx.hash} (gas ${r!.gasUsed})`);
  }
  if (!dryRun) console.log(`done. last replayed day now ${state.lastReplayedDay}; router float ${f8(await wbtc.balanceOf(addr.contracts.RevenueRouter))} DWBTC`);
  console.log(`caller ${me.address}`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message || e);
  process.exitCode = 1;
});
