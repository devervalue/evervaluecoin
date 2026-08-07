import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// DEMO deployment for Arbitrum Sepolia (chainId 421614).
// Deploys the time-warpable DemoEVALocker + faucet tokens + router + market,
// wires them, seeds the deployer, saves addresses, and verifies on Etherscan.
// NEVER run this against mainnet — it deploys demo-only contracts.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);

// Curve: 0 = LINEAR, 1 = QUADRATIC, 2 = SQRT
// Tiers: 3mo, 6mo, 12mo, 24mo (all tradable & paying) + 24mo admin (weight 0, soulbound)
const TIERS = {
  weights: [1, 2, 4, 8, 0],
  durations: [90 * DAY, 180 * DAY, 365 * DAY, 730 * DAY, 730 * DAY],
  curves: [0, 0, 0, 0, 0],
  transferables: [true, true, true, true, false],
};

const MIN_LIST_AMOUNT = E18("10"); // market anti-spam floor: 10 EVA to list

async function deploy(name: string, args: any[]) {
  const factory = await ethers.getContractFactory(name);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  ${name} -> ${addr}`);
  return { c, addr };
}

async function verify(address: string, constructorArguments: any[]) {
  try {
    await hre.run("verify:verify", { address, constructorArguments });
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
  console.log("EVA Locker — DEMO deployment");
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

  // --- Tokens (faucets) ---
  console.log("\n[1/6] Faucet tokens");
  const { c: eva, addr: evaAddr } = await deploy("DemoMintableToken", ["DMO", "DMO", 18]);
  const { c: wbtc, addr: wbtcAddr } = await deploy("DemoMintableToken", ["DWBTC", "DWBTC", 8]);

  // --- Core burn vault (early-exit redemption target) ---
  console.log("\n[2/6] Core EVABurnVault");
  const { c: coreVault, addr: coreAddr } = await deploy("EVABurnVault", [evaAddr, wbtcAddr]);

  // --- DemoEVALocker (time-warpable) ---
  console.log("\n[3/6] DemoEVALocker (5 tiers)");
  const { c: locker, addr: lockerAddr } = await deploy("DemoEVALocker", [
    evaAddr,
    wbtcAddr,
    coreAddr,
    TIERS.weights,
    TIERS.durations,
    TIERS.curves,
    TIERS.transferables,
  ]);

  // --- SLS factory mock (router needs an activeVault() source; returns 0 -> SLS leg folds into core) ---
  console.log("\n[4/6] Mock SLS factory (activeVault = 0)");
  const { c: factory, addr: factoryAddr } = await deploy("MockSLSFactoryForRouter", []);

  // --- RevenueRouter ---
  console.log("\n[5/6] RevenueRouter");
  const { c: router, addr: routerAddr } = await deploy("RevenueRouter", [
    wbtcAddr,
    coreAddr,
    factoryAddr,
    lockerAddr,
    [deployer.address],
  ]);

  // --- PositionMarket ---
  console.log("\n[6/6] PositionMarket");
  const { c: market, addr: marketAddr } = await deploy("PositionMarket", [lockerAddr, wbtcAddr, MIN_LIST_AMOUNT]);

  // --- Wiring ---
  console.log("\n🔧 Wiring");
  await (await locker.setDistributor(routerAddr)).wait();
  console.log("  locker.setDistributor(router)");

  // --- Seed the deployer + core vault so the demo can run immediately ---
  console.log("\n🌱 Seeding balances");
  await (await eva.mint(deployer.address, E18("1000000"))).wait();
  await (await wbtc.mint(deployer.address, E8("1000"))).wait();
  await (await wbtc.transfer(coreAddr, E8("50"))).wait(); // backing for early-exit redemption
  console.log("  minted 1,000,000 DMO + 1,000 DWBTC to deployer; funded core vault with 50 DWBTC");

  // --- Save addresses ---
  const out = {
    network: "arbitrumSepolia",
    chainId: Number(net.chainId),
    deployer: deployer.address,
    contracts: {
      DMO: evaAddr,
      DWBTC: wbtcAddr,
      EVABurnVault: coreAddr,
      DemoEVALocker: lockerAddr,
      MockSLSFactory: factoryAddr,
      RevenueRouter: routerAddr,
      PositionMarket: marketAddr,
    },
    tiers: TIERS,
    minListAmount: MIN_LIST_AMOUNT.toString(),
  };
  fs.writeFileSync("demo-arbitrum-sepolia.json", JSON.stringify(out, null, 2));
  console.log("\n💾 Saved addresses to demo-arbitrum-sepolia.json");

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
  await verify(factoryAddr, []);
  await verify(routerAddr, [wbtcAddr, coreAddr, factoryAddr, lockerAddr, [deployer.address]]);
  await verify(marketAddr, [lockerAddr, wbtcAddr, MIN_LIST_AMOUNT]);

  console.log("\n✅ DEMO DEPLOYMENT COMPLETE");
  console.log(JSON.stringify(out.contracts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
