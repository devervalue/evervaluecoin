import { ethers } from "hardhat";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Fund ONE test wallet on the Sepolia replica: DMO, DWBTC and (optionally) Sepolia ETH for gas.
// Transfers from the deployer; never mints, so supply / backing ratios stay production-like.
//
//   npx hardhat run scripts/fundTester.ts --network arbitrumSepolia
//
// Env:
//   TO=0x…        recipient (required)
//   DMO=5000      DMO to send (human units, default 0)
//   DWBTC=0.5     DWBTC to send (human units, default 0)
//   ETH=0.01      Sepolia ETH to send for gas (default 0)
//   DRY_RUN=1     print only
//   DEMO_ADDR_FILE  address book (default demo-arbitrum-sepolia.json)
//
// PowerShell:  $env:TO="0x…"; $env:DMO="5000"; $env:DWBTC="0.5"; $env:ETH="0.01"; npx hardhat run scripts/fundTester.ts --network arbitrumSepolia
// Bash:        TO=0x… DMO=5000 DWBTC=0.5 ETH=0.01 npx hardhat run scripts/fundTester.ts --network arbitrumSepolia
// For many wallets at once use scripts/distributeTestBalances.ts with a recipients.json.
// ---------------------------------------------------------------------------

async function main() {
  const to = process.env.TO;
  if (!to || !ethers.isAddress(to)) throw new Error("TO must be a valid address");
  const dmo = ethers.parseUnits(process.env.DMO || "0", 18);
  const dwbtc = ethers.parseUnits(process.env.DWBTC || "0", 8);
  const eth = ethers.parseEther(process.env.ETH || "0");
  const dryRun = process.env.DRY_RUN === "1";
  if (dmo === 0n && dwbtc === 0n && eth === 0n) throw new Error("nothing to send: set DMO, DWBTC and/or ETH");

  const a = JSON.parse(fs.readFileSync(process.env.DEMO_ADDR_FILE || "demo-arbitrum-sepolia.json", "utf8")).contracts;
  const [me] = await ethers.getSigners();
  const dmoC = await ethers.getContractAt("DemoMintableToken", a.DMO);
  const wC = await ethers.getContractAt("DemoMintableToken", a.DWBTC);

  const [sDmo, sW, sEth] = await Promise.all([dmoC.balanceOf(me.address), wC.balanceOf(me.address), ethers.provider.getBalance(me.address)]);
  const [rDmo, rW, rEth] = await Promise.all([dmoC.balanceOf(to), wC.balanceOf(to), ethers.provider.getBalance(to)]);
  console.log(`sender    ${me.address}  DMO ${ethers.formatUnits(sDmo, 18)} | DWBTC ${ethers.formatUnits(sW, 8)} | ETH ${ethers.formatEther(sEth)}`);
  console.log(`recipient ${to}  DMO ${ethers.formatUnits(rDmo, 18)} | DWBTC ${ethers.formatUnits(rW, 8)} | ETH ${ethers.formatEther(rEth)}`);
  console.log(`plan: DMO ${ethers.formatUnits(dmo, 18)} | DWBTC ${ethers.formatUnits(dwbtc, 8)} | ETH ${ethers.formatEther(eth)}${dryRun ? "  [DRY RUN]" : ""}`);
  if (dmo > sDmo || dwbtc > sW || eth > sEth) throw new Error("insufficient sender balance");
  if (dryRun) return;

  if (dmo > 0n) { const tx = await dmoC.transfer(to, dmo); await tx.wait(); console.log(`  DMO sent    ${tx.hash}`); }
  if (dwbtc > 0n) { const tx = await wC.transfer(to, dwbtc); await tx.wait(); console.log(`  DWBTC sent  ${tx.hash}`); }
  if (eth > 0n) { const tx = await me.sendTransaction({ to, value: eth }); await tx.wait(); console.log(`  ETH sent    ${tx.hash}`); }

  const [nDmo, nW, nEth] = await Promise.all([dmoC.balanceOf(to), wC.balanceOf(to), ethers.provider.getBalance(to)]);
  console.log(`recipient now  DMO ${ethers.formatUnits(nDmo, 18)} | DWBTC ${ethers.formatUnits(nW, 8)} | ETH ${ethers.formatEther(nEth)}`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message || e);
  process.exitCode = 1;
});
