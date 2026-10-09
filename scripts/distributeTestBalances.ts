import { ethers } from "hardhat";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Hand out DMO / DWBTC test balances on the Arbitrum Sepolia replica.
//
// The faucet tokens are owner-only mint and the deployer holds the production-like supply, so test
// accounts receive balances by TRANSFER from the deployer (no mint → supply/backing ratios stay put).
//
// Usage:
//   npx hardhat run scripts/distributeTestBalances.ts --network arbitrumSepolia
//
// Recipients come from recipients.json at the repo root (gitignored), shape:
//   [ { "address": "0x…", "dmo": "5000", "dwbtc": "0.5", "note": "client dev 1" }, … ]
// Amounts are human units (DMO 18 decimals, DWBTC 8). Omit either field for 0.
// Env: DEMO_ADDR_FILE (default demo-arbitrum-sepolia.json), RECIPIENTS (default recipients.json).
// Dry run (print only, no transactions): DRY_RUN=1
// ---------------------------------------------------------------------------

type Recipient = { address: string; dmo?: string; dwbtc?: string; note?: string };

async function main() {
  const addrFile = process.env.DEMO_ADDR_FILE || "demo-arbitrum-sepolia.json";
  const recFile = process.env.RECIPIENTS || "recipients.json";
  const dryRun = process.env.DRY_RUN === "1";

  const a = JSON.parse(fs.readFileSync(addrFile, "utf8")).contracts;
  const recipients: Recipient[] = JSON.parse(fs.readFileSync(recFile, "utf8"));
  const [me] = await ethers.getSigners();
  const dmo = await ethers.getContractAt("DemoMintableToken", a.DMO);
  const dwbtc = await ethers.getContractAt("DemoMintableToken", a.DWBTC);

  let totDmo = 0n, totDwbtc = 0n;
  const plan = recipients.map((r) => {
    if (!ethers.isAddress(r.address)) throw new Error(`bad address: ${r.address}`);
    const d = r.dmo ? ethers.parseUnits(r.dmo, 18) : 0n;
    const w = r.dwbtc ? ethers.parseUnits(r.dwbtc, 8) : 0n;
    totDmo += d; totDwbtc += w;
    return { ...r, d, w };
  });

  const balDmo = await dmo.balanceOf(me.address), balW = await dwbtc.balanceOf(me.address);
  console.log(`sender ${me.address} | DMO ${ethers.formatUnits(balDmo, 18)} | DWBTC ${ethers.formatUnits(balW, 8)}`);
  console.log(`plan: ${plan.length} recipients | DMO ${ethers.formatUnits(totDmo, 18)} | DWBTC ${ethers.formatUnits(totDwbtc, 8)}${dryRun ? "  [DRY RUN]" : ""}`);
  if (totDmo > balDmo || totDwbtc > balW) throw new Error("insufficient sender balance for the plan");

  for (const r of plan) {
    const tag = `${r.address}${r.note ? " (" + r.note + ")" : ""}`;
    if (r.d > 0n) {
      if (!dryRun) await (await dmo.transfer(r.address, r.d)).wait();
      console.log(`  DMO   ${ethers.formatUnits(r.d, 18).padStart(14)} -> ${tag}`);
    }
    if (r.w > 0n) {
      if (!dryRun) await (await dwbtc.transfer(r.address, r.w)).wait();
      console.log(`  DWBTC ${ethers.formatUnits(r.w, 8).padStart(14)} -> ${tag}`);
    }
  }
  console.log(dryRun ? "dry run complete, nothing sent." : "done.");
  if (!dryRun) {
    console.log("reminder: recipients also need Arbitrum Sepolia ETH for gas (not handled here).");
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message || e);
  process.exitCode = 1;
});
