import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// DEMO deployment for Arbitrum Sepolia (chainId 421614) — production-like replica.
//
// Deploys the time-warpable DemoEVALocker + owner-minted faucet tokens + the REAL SLS factory/vault +
// router + market, wires everything, seeds balances and positions to mirror Arbitrum One as of
// 2026-10-01, saves addresses, and verifies on Etherscan.
//
//   Mainnet reference (2026-10-01): EVA supply 18.0M | core vault 381 WBTC (floor ~2,118 sats/EVA)
//   SLS vault 40.1 WBTC covering 74.4k EVA | daily payment ~0.33 WBTC, split 20/80 core/SLS today;
//   target split with the locker: 10% core / 45% SLS ("boost") / 45% locker.
//
// NEVER run this against mainnet — it deploys demo-only contracts and refuses mainnet chain ids.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

// Curve: 0 = LINEAR, 1 = QUADRATIC, 2 = SQRT
// Tiers (CONFIRMED mainnet params, see ignition/modules/EVALocker.ts):
//   3mo 1x, 6mo 2x, 12mo 3x, 24mo 4x (all tradable & paying) + 24mo founder (weight 0, soulbound)
const TIERS = {
  weights: [1, 2, 3, 4, 0],
  durations: [90 * DAY, 180 * DAY, 365 * DAY, 730 * DAY, 730 * DAY],
  curves: [0, 0, 0, 0, 0],
  transferables: [true, true, true, true, false],
};

// --- production-like seeding ---
const SUPPLY_DMO = E18("18000000"); // ~ EVA supply on Arbitrum One
const CORE_BACKING = E8("381"); // ~ core vault WBTC -> floor ~2,117 sats/DMO
const SLS_BACKING = E8("40"); // ~ active SLS vault WBTC
const SLS_FIXED_EVA = E18("74000"); // ~ EVA covered by the SLS vault (price ~54k sats/EVA)
const ROUTER_FLOAT = E8("30"); // ~90 days of payments at 0.33/day
const DAILY_PAYMENT = E8("0.33"); // reference only (used by demoOps/runDemo)
const SPLIT_BPS = { core: 1000, sls: 4500, locker: 4500 }; // 10 / 45 / 45

// Seed positions so the first distribution has weighted shares (never bank into `undistributed`).
const SEED_POSITIONS: { tier: number; amount: bigint }[] = [
  { tier: 0, amount: E18("50000") },
  { tier: 1, amount: E18("50000") },
  { tier: 2, amount: E18("100000") },
  { tier: 3, amount: E18("200000") },
  { tier: 4, amount: E18("1000000") }, // founder tier: soulbound, weight 0
];

// --- operational knobs ---
const MIN_LOCK_AMOUNT = E18("1"); // 1 DMO
const LOCK_FEE_BPS = 0; // left at 0 (readme default)
const MIN_LIST_AMOUNT = E18("10"); // market anti-spam floor: 10 DMO to list

async function deploy(name: string, args: any[]) {
  const factory = await ethers.getContractFactory(name);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  ${name} -> ${addr}`);
  return { c, addr };
}

async function verify(address: string, constructorArguments: any[], contract?: string) {
  try {
    await hre.run("verify:verify", { address, constructorArguments, ...(contract ? { contract } : {}) });
    console.log(`  ✅ verified ${address}`);
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (msg.toLowerCase().includes("already verified")) console.log(`  ℹ️  already verified ${address}`);
    else console.log(`  ⚠️  verify failed ${address}: ${msg.split("\n")[0]}`);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log("=".repeat(64));
  console.log("EVA Locker — DEMO deployment (production-like replica)");
  console.log(`Network chainId: ${net.chainId}`);
  console.log(`Deployer:        ${deployer.address}`);
  console.log(`Balance:         ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log("=".repeat(64));

  // Safety: never deploy these demo-only contracts to a mainnet.
  const MAINNETS = [1n, 42161n]; // Ethereum, Arbitrum One
  if (MAINNETS.includes(net.chainId)) {
    console.log(`\n⛔ Refusing to deploy demo contracts to mainnet (chainId ${net.chainId}). Aborting.`);
    process.exit(1);
  }
  const isLive = net.chainId !== 31337n; // skip Etherscan verify on the local hardhat network

  // --- Tokens (owner-only faucets) ---
  console.log("\n[1/7] Faucet tokens (owner-only mint)");
  const { c: eva, addr: evaAddr } = await deploy("DemoMintableToken", ["DMO", "DMO", 18]);
  const { c: wbtc, addr: wbtcAddr } = await deploy("DemoMintableToken", ["DWBTC", "DWBTC", 8]);

  // --- Core burn vault (early-exit redemption target) ---
  console.log("\n[2/7] Core EVABurnVault");
  const { c: coreVault, addr: coreAddr } = await deploy("EVABurnVault", [evaAddr, wbtcAddr]);

  // --- DemoEVALocker (time-warpable) ---
  console.log("\n[3/7] DemoEVALocker (5 tiers, mainnet params)");
  const { c: locker, addr: lockerAddr } = await deploy("DemoEVALocker", [
    evaAddr,
    wbtcAddr,
    coreAddr,
    TIERS.weights,
    TIERS.durations,
    TIERS.curves,
    TIERS.transferables,
  ]);

  // --- Real SLS factory + active vault ---
  console.log("\n[4/7] SLSburnVaultFactory + active SLS vault");
  const { c: slsFactory, addr: slsFactoryAddr } = await deploy("SLSburnVaultFactory", [evaAddr]);

  // --- RevenueRouter (constructor verifies core vault + locker are wired to DWBTC) ---
  console.log("\n[5/7] RevenueRouter");
  const { c: router, addr: routerAddr } = await deploy("RevenueRouter", [
    wbtcAddr,
    coreAddr,
    slsFactoryAddr,
    lockerAddr,
    [deployer.address],
  ]);

  // --- PositionMarket ---
  console.log("\n[6/7] PositionMarket");
  const { c: market, addr: marketAddr } = await deploy("PositionMarket", [lockerAddr, wbtcAddr, MIN_LIST_AMOUNT]);

  // --- Mint supply to the deployer ---
  console.log("\n[7/7] Minting");
  await (await eva.mint(deployer.address, SUPPLY_DMO)).wait();
  await (await wbtc.mint(deployer.address, CORE_BACKING + SLS_BACKING + ROUTER_FLOAT + E8("100"))).wait();
  console.log(`  minted ${ethers.formatUnits(SUPPLY_DMO, 18)} DMO and DWBTC for vaults/router (+100 spare) to deployer`);

  // --- Wiring ---
  console.log("\n🔧 Wiring");
  await (await locker.setDistributor(routerAddr)).wait();
  console.log("  locker.setDistributor(router)");
  await (await locker.setMinLockAmount(MIN_LOCK_AMOUNT)).wait();
  console.log(`  locker.setMinLockAmount(${ethers.formatUnits(MIN_LOCK_AMOUNT, 18)} DMO)`);
  if (LOCK_FEE_BPS > 0) {
    await (await locker.setLockFee(LOCK_FEE_BPS)).wait();
    console.log(`  locker.setLockFee(${LOCK_FEE_BPS})`);
  } else {
    console.log("  locker.lockFeeBps left at 0");
  }

  // Create the active SLS vault (factory pulls initialBacking from the deployer), then authorize the
  // router as payer so pay(..., increaseSLS=true) works end-to-end.
  await (await wbtc.approve(slsFactoryAddr, SLS_BACKING)).wait();
  await (await slsFactory.createVault(wbtcAddr, SLS_FIXED_EVA, SLS_BACKING)).wait();
  const slsVaultAddr: string = await slsFactory.activeVault();
  const slsVault = await ethers.getContractAt("SLSburnVault", slsVaultAddr);
  await (await slsVault.setPayer(routerAddr, true)).wait();
  console.log(
    `  SLS vault ${slsVaultAddr}: ${ethers.formatUnits(SLS_BACKING, 8)} DWBTC covering ` +
      `${ethers.formatUnits(SLS_FIXED_EVA, 18)} DMO; router authorized as payer`
  );

  // --- Seed balances ---
  console.log("\n🌱 Seeding balances");
  await (await wbtc.transfer(coreAddr, CORE_BACKING)).wait();
  await (await wbtc.transfer(routerAddr, ROUTER_FLOAT)).wait();
  console.log(
    `  core vault ${ethers.formatUnits(CORE_BACKING, 8)} DWBTC | router float ${ethers.formatUnits(ROUTER_FLOAT, 8)} DWBTC`
  );

  // --- Seed positions (deployer) ---
  console.log("\n🔒 Seeding positions");
  await (await eva.approve(lockerAddr, ethers.MaxUint256)).wait();
  for (const s of SEED_POSITIONS) {
    await (await locker.lock(s.tier, s.amount)).wait();
    console.log(`  lock tier ${s.tier}: ${ethers.formatUnits(s.amount, 18)} DMO`);
  }
  console.log(`  totalShares = ${await locker.totalShares()}`);

  // --- Save addresses ---
  const out = {
    network: "arbitrumSepolia",
    chainId: Number(net.chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      DMO: evaAddr,
      DWBTC: wbtcAddr,
      EVABurnVault: coreAddr,
      DemoEVALocker: lockerAddr,
      SLSburnVaultFactory: slsFactoryAddr,
      SLSburnVault: slsVaultAddr,
      RevenueRouter: routerAddr,
      PositionMarket: marketAddr,
    },
    tiers: TIERS,
    params: {
      minLockAmount: MIN_LOCK_AMOUNT.toString(),
      lockFeeBps: LOCK_FEE_BPS,
      minListAmount: MIN_LIST_AMOUNT.toString(),
      dailyPayment: DAILY_PAYMENT.toString(),
      splitBps: SPLIT_BPS,
    },
    seed: {
      supplyDmo: SUPPLY_DMO.toString(),
      coreBacking: CORE_BACKING.toString(),
      slsBacking: SLS_BACKING.toString(),
      slsFixedEva: SLS_FIXED_EVA.toString(),
      routerFloat: ROUTER_FLOAT.toString(),
      positions: SEED_POSITIONS.map((s) => ({ tier: s.tier, amount: s.amount.toString() })),
    },
  };
  // Local dry runs write to a separate file so they never clobber the live Sepolia address book.
  const outFile = isLive ? "demo-arbitrum-sepolia.json" : "demo-local-dryrun.json";
  if (!isLive) out.network = "hardhat-local";
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\n💾 Saved addresses to ${outFile}`);

  // --- Verify (best-effort; skipped on the local network) ---
  if (!isLive) {
    console.log("\n(skipping Etherscan verification on local network)");
    console.log("\n✅ DEMO DEPLOYMENT COMPLETE (local dry-run)");
    console.log(JSON.stringify(out.contracts, null, 2));
    return;
  }
  console.log("\n🔎 Verifying on Etherscan (best-effort)...");
  await verify(evaAddr, ["DMO", "DMO", 18]);
  await verify(wbtcAddr, ["DWBTC", "DWBTC", 8]);
  await verify(coreAddr, [evaAddr, wbtcAddr]);
  await verify(lockerAddr, [
    evaAddr,
    wbtcAddr,
    coreAddr,
    TIERS.weights,
    TIERS.durations,
    TIERS.curves,
    TIERS.transferables,
  ]);
  await verify(slsFactoryAddr, [evaAddr]);
  await verify(slsVaultAddr, [evaAddr, wbtcAddr, SLS_FIXED_EVA, slsFactoryAddr], "contracts/SLSburnVault.sol:SLSburnVault");
  await verify(routerAddr, [wbtcAddr, coreAddr, slsFactoryAddr, lockerAddr, [deployer.address]]);
  await verify(marketAddr, [lockerAddr, wbtcAddr, MIN_LIST_AMOUNT]);

  console.log("\n✅ DEMO DEPLOYMENT COMPLETE");
  console.log(JSON.stringify(out.contracts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
