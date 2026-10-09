import { ethers } from "hardhat";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Execute a revenue payment through the RevenueRouter on the Sepolia replica.
//
// Mirrors the production daily payment: AMOUNT DWBTC split core / SLS / locker by bps. The router
// must already hold the float (it is seeded with 30 DWBTC at deploy); optionally top it up first
// from the deployer with TOPUP.
//
//   npx hardhat run scripts/payRevenue.ts --network arbitrumSepolia
//
// Env (all optional):
//   AMOUNT=0.33            DWBTC to pay (default 0.33, the production-like daily payment)
//   CORE_BPS=1000 SLS_BPS=4500 LOCKER_BPS=4500   split, must sum to 10000 (default 10/45/45)
//   INCREASE_SLS=1         1: SLS leg via increaseBacking (price-guarded top-up; router is payer)
//                          0: SLS leg via direct transfer
//   ADDITIONAL_EVA=0       extra EVA coverage for the SLS vault when INCREASE_SLS=1 (human units)
//   TOPUP=0                DWBTC to transfer deployer -> router before paying
//   REPEAT=1               run the payment N times (e.g. simulate several days in one go)
//   DRY_RUN=1              print the plan and current state, send nothing
//   DEMO_ADDR_FILE         address book (default demo-arbitrum-sepolia.json)
//
// PowerShell:  $env:AMOUNT="0.5"; $env:REPEAT="3"; npx hardhat run scripts/payRevenue.ts --network arbitrumSepolia
// Bash:        AMOUNT=0.5 REPEAT=3 npx hardhat run scripts/payRevenue.ts --network arbitrumSepolia
// ---------------------------------------------------------------------------

const f8 = (x: bigint) => ethers.formatUnits(x, 8);
const f18 = (x: bigint) => ethers.formatUnits(x, 18);

async function main() {
  const addrFile = process.env.DEMO_ADDR_FILE || "demo-arbitrum-sepolia.json";
  const a = JSON.parse(fs.readFileSync(addrFile, "utf8")).contracts;
  const amount = ethers.parseUnits(process.env.AMOUNT || "0.33", 8);
  const coreBps = Number(process.env.CORE_BPS ?? 1000);
  const slsBps = Number(process.env.SLS_BPS ?? 4500);
  const lockerBps = Number(process.env.LOCKER_BPS ?? 4500);
  const increaseSLS = (process.env.INCREASE_SLS ?? "1") === "1";
  const additionalEva = ethers.parseUnits(process.env.ADDITIONAL_EVA || "0", 18);
  const topup = ethers.parseUnits(process.env.TOPUP || "0", 8);
  const repeat = Math.max(1, Number(process.env.REPEAT ?? 1));
  const dryRun = process.env.DRY_RUN === "1";
  if (coreBps + slsBps + lockerBps !== 10000) throw new Error("bps must sum to 10000");

  const [me] = await ethers.getSigners();
  const wbtc = await ethers.getContractAt("DemoMintableToken", a.DWBTC);
  const router = await ethers.getContractAt("RevenueRouter", a.RevenueRouter);
  const locker = await ethers.getContractAt("DemoEVALocker", a.DemoEVALocker);
  const sls = await ethers.getContractAt("SLSburnVault", a.SLSburnVault);

  const snapshot = async () => ({
    core: await wbtc.balanceOf(a.EVABurnVault),
    sls: await wbtc.balanceOf(a.SLSburnVault),
    router: await wbtc.balanceOf(a.RevenueRouter),
    lockerOwed: await locker.totalUnclaimedRewards(),
    banked: await locker.undistributed(),
    shares: await locker.totalShares(),
    slsQuote: await sls.getBurningQuote(ethers.parseEther("1000")),
  });

  console.log(`caller ${me.address} | allowed: ${await router.isCallerAllowed(me.address)}`);
  const s0 = await snapshot();
  console.log(`state: core ${f8(s0.core)} | SLS ${f8(s0.sls)} (1000 DMO -> ${f8(s0.slsQuote)}) | router ${f8(s0.router)} | locker owed ${f8(s0.lockerOwed)} banked ${f8(s0.banked)} | shares ${f18(s0.shares)}`);
  console.log(`plan: ${repeat}x pay ${f8(amount)} DWBTC  core ${coreBps} / sls ${slsBps} / locker ${lockerBps} bps  ${increaseSLS ? "SLS via increaseBacking" : "SLS via transfer"}${additionalEva > 0n ? " +" + f18(additionalEva) + " EVA coverage" : ""}${topup > 0n ? "  (topup " + f8(topup) + " first)" : ""}${dryRun ? "  [DRY RUN]" : ""}`);
  if (s0.shares === 0n && lockerBps > 0) console.log("  !! locker has no weighted shares: its leg would bank into `undistributed`");
  if (s0.router + topup < amount * BigInt(repeat)) throw new Error(`router float too low: need ${f8(amount * BigInt(repeat))}, have ${f8(s0.router + topup)} (use TOPUP)`);
  if (dryRun) return;

  if (topup > 0n) {
    await (await wbtc.transfer(a.RevenueRouter, topup)).wait();
    console.log(`  topped up router with ${f8(topup)} DWBTC`);
  }
  for (let i = 1; i <= repeat; i++) {
    const tx = await router.pay(amount, coreBps, slsBps, lockerBps, increaseSLS, additionalEva);
    const r = await tx.wait();
    console.log(`  [${i}/${repeat}] pay tx ${tx.hash} (gas ${r!.gasUsed})`);
  }
  const s1 = await snapshot();
  console.log(`result: core +${f8(s1.core - s0.core)} | SLS +${f8(s1.sls - s0.sls)} (1000 DMO -> ${f8(s1.slsQuote)}) | router ${f8(s1.router)} | locker owed +${f8(s1.lockerOwed - s0.lockerOwed)} banked ${f8(s1.banked)}`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message || e);
  process.exitCode = 1;
});
