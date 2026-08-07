import { ethers } from "hardhat";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Diagnose reverts against the LIVE Arbitrum Sepolia demo deployment.
//   Read-only checks always run (no gas, no state change).
//   Set RUN_FLOW=1 to also run a transaction flow that reproduces each demo
//   step and prints the exact revert reason of the first one that fails.
//
//   npx hardhat run scripts/diagnose.ts --network arbitrumSepolia
//   RUN_FLOW=1 npx hardhat run scripts/diagnose.ts --network arbitrumSepolia   (PowerShell: $env:RUN_FLOW=1; npx hardhat run ...)
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);
const f8 = (x: bigint) => ethers.formatUnits(x, 8);
const f18 = (x: bigint) => ethers.formatEther(x);

const reason = (e: any): string =>
  e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || String(e);

async function readSafe(label: string, fn: () => Promise<any>) {
  try {
    console.log(`  ${label}: ${await fn()}`);
  } catch (e) {
    console.log(`  ${label}: ⚠️ ${reason(e)}`);
  }
}

function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
}

async function main() {
  const dep = JSON.parse(fs.readFileSync("demo-arbitrum-sepolia.json", "utf8"));
  const a = dep.contracts;
  const [me] = await ethers.getSigners();
  const provider = ethers.provider;
  const net = await provider.getNetwork();

  console.log("=".repeat(66));
  console.log("DIAGNOSE — live demo deployment");
  console.log(`chainId: ${net.chainId}   caller: ${me.address}`);
  console.log("=".repeat(66));

  // --- 0. contracts exist on this chain ---
  console.log("\n[0] Bytecode present at each address");
  for (const [k, v] of Object.entries(a)) {
    const code = await provider.getCode(v as string);
    check(`${k} @ ${v}`, code !== "0x", code === "0x" ? "NO CODE (wrong address/network)" : "");
  }

  const eva = await ethers.getContractAt("DemoMintableToken", a.DMO);
  const wbtc = await ethers.getContractAt("DemoMintableToken", a.DWBTC);
  const locker = await ethers.getContractAt("DemoEVALocker", a.DemoEVALocker);
  const router = await ethers.getContractAt("RevenueRouter", a.RevenueRouter);
  const market = await ethers.getContractAt("PositionMarket", a.PositionMarket);
  const factory = await ethers.getContractAt("MockSLSFactoryForRouter", a.MockSLSFactory);

  // --- 1. balances ---
  console.log("\n[1] Caller balances");
  await readSafe("ETH", async () => f18(await provider.getBalance(me.address)));
  await readSafe("DMO", async () => f18(await eva.balanceOf(me.address)));
  await readSafe("DWBTC", async () => f8(await wbtc.balanceOf(me.address)));

  // --- 2. locker config ---
  console.log("\n[2] Locker config");
  let lockerOwner = "", distributor = "";
  await readSafe("owner", async () => (lockerOwner = await locker.owner()));
  await readSafe("distributor", async () => (distributor = await locker.distributor()));
  await readSafe("locksPaused", async () => await locker.locksPaused());
  await readSafe("nextPositionId", async () => (await locker.nextPositionId()).toString());
  await readSafe("currentTime", async () => new Date(Number(await locker.currentTime()) * 1000).toISOString());
  const tierCount = Number(await locker.tierCount());
  for (let i = 0; i < tierCount; i++) {
    const t = await locker.tiers(i);
    console.log(
      `  tier ${i}: weight=${t.weight} duration=${Number(t.duration) / DAY}d curve=${t.defaultCurve} enabled=${t.enabled} transferable=${t.transferable}`
    );
  }

  // --- 3. router config ---
  console.log("\n[3] Router config");
  let rLocker = "", rBacking = "", rCore = "", rFactory = "";
  await readSafe("locker", async () => (rLocker = await router.locker()));
  await readSafe("backingToken", async () => (rBacking = await router.backingToken()));
  await readSafe("coreVault", async () => (rCore = await router.coreVault()));
  await readSafe("factory", async () => (rFactory = await router.factory()));
  await readSafe("isCallerAllowed(caller)", async () => await router.isCallerAllowed(me.address));

  // --- 4. market config ---
  console.log("\n[4] Market config");
  let mNft = "", mWbtc = "";
  await readSafe("positionNft", async () => (mNft = await market.positionNft()));
  await readSafe("wbtc", async () => (mWbtc = await market.wbtc()));
  await readSafe("minListAmount (EVA)", async () => f18(await market.minListAmount()));
  await readSafe("activeListingCount", async () => (await market.activeListingCount()).toString());

  // --- 5. SLS factory + core vault ---
  console.log("\n[5] SLS factory & core vault");
  await readSafe("factory.activeVault", async () => await factory.activeVault());
  await readSafe("core vault DWBTC balance", async () => f8(await wbtc.balanceOf(a.EVABurnVault)));

  // --- 6. allowances / approvals (the usual revert culprits) ---
  console.log("\n[6] Approvals from caller");
  await readSafe("DMO -> locker allowance", async () => f18(await eva.allowance(me.address, a.DemoEVALocker)));
  await readSafe("DWBTC -> router allowance", async () => f8(await wbtc.allowance(me.address, a.RevenueRouter)));
  await readSafe("DWBTC -> market allowance", async () => f8(await wbtc.allowance(me.address, a.PositionMarket)));
  await readSafe("locker NFT approvedForAll(market)", async () => await locker.isApprovedForAll(me.address, a.PositionMarket));

  // --- 7. wiring consistency ---
  console.log("\n[7] Wiring consistency");
  check("locker.distributor == router", distributor.toLowerCase() === a.RevenueRouter.toLowerCase(), distributor);
  check("router.locker == locker", rLocker.toLowerCase() === a.DemoEVALocker.toLowerCase());
  check("router.coreVault == core", rCore.toLowerCase() === a.EVABurnVault.toLowerCase());
  check("router.factory == factory", rFactory.toLowerCase() === a.MockSLSFactory.toLowerCase());
  check("router.backingToken == DWBTC", rBacking.toLowerCase() === a.DWBTC.toLowerCase());
  check("market.positionNft == locker", mNft.toLowerCase() === a.DemoEVALocker.toLowerCase());
  check("market.wbtc == DWBTC", mWbtc.toLowerCase() === a.DWBTC.toLowerCase());
  check("caller is locker owner (for advanceTime/admin)", lockerOwner.toLowerCase() === me.address.toLowerCase());

  // --- 7b. existing positions vs the (warped) clock ---
  console.log("\n[7b] Existing positions (state vs locker clock)");
  const nowT = Number(await locker.currentTime());
  await readSafe("router DWBTC balance", async () => f8(await wbtc.balanceOf(a.RevenueRouter)));
  const next = Number(await locker.nextPositionId());
  if (next === 0) console.log("  (no positions minted yet)");
  for (let id = 0; id < next; id++) {
    try {
      const p = await locker.positions(id);
      let owner = "burned/none";
      try {
        owner = await locker.ownerOf(id);
      } catch {}
      const end = Number(p.endTime);
      const matured = nowT >= end;
      const pend = await locker.pending(id);
      console.log(
        `  #${id}: owner=${owner.slice(0, 10)}… tier=${p.tierId} amount=${f18(p.amount)} ` +
          `end=${new Date(end * 1000).toISOString()} ${matured ? "MATURED (use withdraw)" : "ACTIVE (early-exit)"} pending=${f8(pend)}`
      );
    } catch (e) {
      console.log(`  #${id}: ⚠️ ${reason(e)}`);
    }
  }

  if (!process.env.RUN_FLOW) {
    console.log("\n(read-only diagnostics done. Set RUN_FLOW=1 to reproduce the tx flow.)");
    return;
  }

  // --- 8. transaction flow (stops at the first failing step) ---
  console.log("\n[8] Transaction flow (reproducing the demo)");
  const step = async (label: string, fn: () => Promise<any>) => {
    try {
      const r = await fn();
      if (r && typeof r.wait === "function") await r.wait();
      console.log(`  ✅ ${label}`);
      return r;
    } catch (e) {
      console.log(`  ❌ ${label}\n     REVERT: ${reason(e)}`);
      throw e;
    }
  };

  try {
    await step("mint 1000 DMO", () => eva.mint(me.address, E18("1000")));
    await step("mint 10 DWBTC", () => wbtc.mint(me.address, E8("10")));
    await step("approve locker for DMO", () => eva.approve(a.DemoEVALocker, ethers.MaxUint256));
    await step("lock 100 DMO in tier 0", () => locker.lock(0, E18("100")));
    const id = Number((await locker.nextPositionId()) - 1n);
    console.log(`     -> position #${id}`);
    await step("transfer 5 DWBTC to router", () => wbtc.transfer(a.RevenueRouter, E8("5")));
    await step("router.pay 100% to locker", () => router.pay(E8("5"), 0, 0, 10000, false, 0));
    console.log(`     pending #${id}: ${f8(await locker.pending(id))} DWBTC`);
    await step("advanceTime 30d", () => locker.advanceTime(30 * DAY));
    await step("claim #" + id, () => locker.claim(id));
    await step("setApprovalForAll(market)", () => locker.setApprovalForAll(a.PositionMarket, true));
    await step("list #" + id + " at 1 DWBTC", () => market.list(id, E8("1")));
    console.log(`     isFulfillable(#${id}): ${await market.isFulfillable(id)}`);
    await step("cancel listing", () => market.cancel(id));
    await step("advanceTime 70d", () => locker.advanceTime(70 * DAY));
    await step("withdraw #" + id, () => locker.withdraw(id));
    console.log("\n✅ Full flow succeeded — no revert reproduced with the deployer wallet.");
  } catch {
    console.log("\n⛔ Flow stopped at the failing step above — that's the culprit.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
