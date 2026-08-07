import { ethers } from "hardhat";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Scripted demo over an already-deployed DemoEVALocker stack (Arbitrum Sepolia).
// Reads addresses from demo-arbitrum-sepolia.json and walks the headline flow:
// mint -> lock -> distribute -> advanceTime -> claim -> list -> withdraw.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60;
const E18 = (n: string | number) => ethers.parseEther(n.toString());
const E8 = (n: string | number) => ethers.parseUnits(n.toString(), 8);
const fmt8 = (x: bigint) => ethers.formatUnits(x, 8);
const fmt18 = (x: bigint) => ethers.formatEther(x);

async function main() {
  const dep = JSON.parse(fs.readFileSync("demo-arbitrum-sepolia.json", "utf8"));
  const a = dep.contracts;
  const [me] = await ethers.getSigners();

  const eva = await ethers.getContractAt("DemoMintableToken", a.DMO);
  const wbtc = await ethers.getContractAt("DemoMintableToken", a.DWBTC);
  const locker = await ethers.getContractAt("DemoEVALocker", a.DemoEVALocker);
  const router = await ethers.getContractAt("RevenueRouter", a.RevenueRouter);
  const market = await ethers.getContractAt("PositionMarket", a.PositionMarket);

  const t = async () => Number(await locker.currentTime());
  console.log(`Actor: ${me.address}`);
  console.log(`Locker clock: ${new Date((await t()) * 1000).toISOString()}\n`);

  // 1) Faucet
  console.log("1) Minting test tokens (faucet)...");
  await (await eva.mint(me.address, E18("1000"))).wait();
  await (await wbtc.mint(me.address, E8("10"))).wait();

  // 2) Lock 100 DMO in tier 0 (3mo)
  console.log("2) Locking 100 DMO in tier 0 (3mo)...");
  await (await eva.approve(a.DemoEVALocker, ethers.MaxUint256)).wait();
  await (await locker.lock(0, E18("100"))).wait();
  const id = Number((await locker.nextPositionId()) - 1n);
  console.log(`   position #${id} minted, owner = ${await locker.ownerOf(id)}`);

  // 3) Distribute 5 DWBTC through the router (100% to the locker)
  console.log("3) Distributing 5 DWBTC via the router...");
  await (await wbtc.transfer(a.RevenueRouter, E8("5"))).wait();
  await (await router.pay(E8("5"), 0, 0, 10000, false, 0)).wait();
  console.log(`   pending on #${id}: ${fmt8(await locker.pending(id))} DWBTC`);

  // 4) Fast-forward 30 days, then claim
  console.log("4) advanceTime(30 days) then claim...");
  await (await locker.advanceTime(30 * DAY)).wait();
  const wbBefore = await wbtc.balanceOf(me.address);
  await (await locker.claim(id)).wait();
  console.log(`   claimed ${fmt8((await wbtc.balanceOf(me.address)) - wbBefore)} DWBTC`);

  // 5) List on the market, read the order book
  console.log("5) Listing #" + id + " at 1 DWBTC...");
  await (await locker.setApprovalForAll(a.PositionMarket, true)).wait();
  await (await market.list(id, E8("1"))).wait();
  const book = await market.getActiveListingsDetailed();
  console.log(`   order book: ${book.ids.length} listing(s), fulfillable=${book.valid[0]}`);
  await (await market.cancel(id)).wait(); // cancel so we can withdraw at maturity
  console.log("   (cancelled listing for the withdraw step)");

  // 6) Fast-forward past maturity and withdraw
  console.log("6) advanceTime(70 days) -> past 3mo maturity, then withdraw...");
  await (await locker.advanceTime(70 * DAY)).wait();
  const evBefore = await eva.balanceOf(me.address);
  await (await locker.withdraw(id)).wait();
  console.log(`   withdrew ${fmt18((await eva.balanceOf(me.address)) - evBefore)} DMO (full principal)`);

  console.log(`\nLocker clock now: ${new Date((await t()) * 1000).toISOString()}`);
  console.log("✅ Demo flow complete.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
