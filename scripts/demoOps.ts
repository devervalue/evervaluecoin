import { ethers } from "hardhat";
import * as fs from "fs";

// Basic live operations on the Arbitrum Sepolia demo: open a position, distribute a payment, advance time.
const DAY = 24 * 60 * 60;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);
const f8 = (x: bigint) => ethers.formatUnits(x, 8);
const f18 = (x: bigint) => ethers.formatEther(x);
const iso = (t: number | bigint) => new Date(Number(t) * 1000).toISOString();

// --- tweakable params ---
const LOCK_TIER = 0; // 3-month tier
const LOCK_AMOUNT = E18("100000"); // DMO to lock
const PAY_AMOUNT = E8("20"); // DWBTC to distribute (100% to the locker)
const ADVANCE = 45 * DAY; // seconds to fast-forward

async function tx(label: string, p: Promise<any>) {
  const r = await p;
  await r.wait();
  console.log(`  ✅ ${label}`);
  return r;
}

async function main() {
  const a = JSON.parse(fs.readFileSync("demo-arbitrum-sepolia.json", "utf8")).contracts;
  const [me] = await ethers.getSigners();
  const eva = await ethers.getContractAt("DemoMintableToken", a.DMO);
  const wbtc = await ethers.getContractAt("DemoMintableToken", a.DWBTC);
  const locker = await ethers.getContractAt("DemoEVALocker", a.DemoEVALocker);
  const router = await ethers.getContractAt("RevenueRouter", a.RevenueRouter);

  console.log(`Caller: ${me.address}`);
  console.log(`Clock (before): ${iso(await locker.currentTime())}\n`);

  // ---- 1. OPEN A POSITION ----
  console.log("1) OPEN POSITION");
  await tx(`mint ${f18(LOCK_AMOUNT)} DMO`, eva.mint(me.address, LOCK_AMOUNT));
  await tx("approve locker for DMO", eva.approve(a.DemoEVALocker, ethers.MaxUint256));
  await tx(`lock ${f18(LOCK_AMOUNT)} DMO in tier ${LOCK_TIER}`, locker.lock(LOCK_TIER, LOCK_AMOUNT));
  const id = Number((await locker.nextPositionId()) - 1n);
  const p = await locker.positions(id);
  console.log(`   -> position #${id}: amount=${f18(p.amount)} DMO, ends ${iso(p.endTime)}, pending=${f8(await locker.pending(id))} DWBTC\n`);

  // ---- 2. PERFORM A PAYMENT (distribute via the router) ----
  console.log("2) PAYMENT / DISTRIBUTION");
  await tx(`mint ${f8(PAY_AMOUNT)} DWBTC`, wbtc.mint(me.address, PAY_AMOUNT));
  await tx(`fund router with ${f8(PAY_AMOUNT)} DWBTC`, wbtc.transfer(a.RevenueRouter, PAY_AMOUNT));
  await tx("router.pay -> 100% to locker", router.pay(PAY_AMOUNT, 0, 0, 10000, false, 0));
  console.log(`   -> pending on #${id} now: ${f8(await locker.pending(id))} DWBTC (its weighted share of the pool)\n`);

  // ---- 3. ADVANCE TIME ----
  console.log("3) ADVANCE TIME");
  await tx(`advanceTime(${ADVANCE / DAY} days)`, locker.advanceTime(ADVANCE));
  const now = Number(await locker.currentTime());
  console.log(`   Clock (after): ${iso(now)}`);
  console.log(`   #${id} end ${iso(p.endTime)} -> ${now >= Number(p.endTime) ? "MATURED (withdraw)" : "ACTIVE (early-exit)"}`);

  console.log("\n✅ Done. Opened #" + id + ", distributed " + f8(PAY_AMOUNT) + " DWBTC, advanced " + ADVANCE / DAY + " days.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
