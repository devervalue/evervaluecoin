# EVA Locker System

Technical documentation for the EVA Locker subsystem: **EVALocker**, **PositionMarket**,
**RevenueRouter**. Solidity 0.8.20, OpenZeppelin 5.x, target chain **Arbitrum One**.

## 1. Scope

| Contract | File | Role |
|---|---|---|
| `EVALocker` | `contracts/EVALocker.sol` | Time-locked EVA staking; WBTC yield; ERC-721 positions |
| `PositionMarket` | `contracts/PositionMarket.sol` | Fixed-price, WBTC-settled marketplace for position NFTs |
| `RevenueRouter` | `contracts/RevenueRouter.sol` | Splits periodic WBTC revenue across core vault / SLS vault / locker |

**Out of scope (already deployed, immutable):** `EverValueCoin` (EVA, ERC-20), `EVABurnVault`
(core vault), the SLS system, WBTC. The locker system integrates with them but cannot change them.
The legacy contracts keep their original conventions (e.g. the vault's `burnMade` event name).

## 2. System overview

Holders lock EVA for a fixed term and receive a pro-rata share of protocol WBTC revenue. Positions
are ERC-721 tokens: tradable on any marketplace (the bundled `PositionMarket` or external ones),
except soulbound tiers. Exit paths: `withdraw` at maturity (full principal) or `earlyExit` at any
time before (a time-based curve splits the principal into a liquid part returned to the holder and a
part force-burned against the core vault, forwarding that backing to the holder).

```
protocol WBTC revenue
        │  pay(amount, coreBps, slsBps, lockerBps, ...)   [allowlisted callers]
        ▼
  RevenueRouter ──► core EVABurnVault (transfer)
        │      ──► active SLS vault (transfer or increaseBacking; folds to core if none)
        │      ──► EVALocker.distribute(amount)   [router must be locker.distributor]
        ▼
    EVALocker ──mints/burns──► Position NFTs ──approval-based listings──► PositionMarket
        ▲                                                                     │
        └───────────── transferFrom settles seller rewards ◄──── buy() ───────┘
```

### Confirmed deployment parameters (`ignition/modules/EVALocker.ts`)

| Tier | Duration | Weight | Curve | Transferable |
|---|---|---|---|---|
| 0 | 3 months | 1× | LINEAR | yes |
| 1 | 6 months | 2× | LINEAR | yes |
| 2 | 12 months | 3× | LINEAR | yes |
| 3 | 24 months | 4× | LINEAR | yes |
| 4 | 24 months | 0× | LINEAR | **no — soulbound founder tier** |

Tier count, weights, durations and transferability are **constructor-only (immutable)**. There is no
`addTier` function — the tier set can never grow. `lockFeeBps` (cap 500) and `minLockAmount` start
at 0 and are owner-settable.

## 3. Requirements

Numbered for reference. **FR** = functional (what the system must do), **TR** = technical (how it
must be built). The implementation is expected to satisfy every item below; the mechanisms that
realize them are described in the sections that follow.

### 3.1 Functional requirements

**Locking**
- **FR-1** Anyone can lock `>= minLockAmount` EVA into any enabled tier while new locks are not
  paused; the contract takes custody and mints an ERC-721 position NFT to the caller.
- **FR-2** A position's terms — principal, shares (`principal × tier weight`), endTime, early-exit
  curve, transferability — are snapshotted at lock time and can never be changed by the admin
  afterwards. The only mutation path is a renewal accepted by the owner (FR-14).
- **FR-3** If `lockFeeBps > 0`, the fee is skimmed from the deposit, burned against the core vault,
  and the redeemed backing forwarded to the distributor — all within the lock transaction. The fee
  MUST be waived (never revert the lock) when it would redeem to zero backing or when no
  distributor is set.
- **FR-4** A position must always mature in a future day-epoch (enforced in `lock` and
  `acceptRenewal`); no share may ever land in an already-processed expiry bucket.

**Rewards**
- **FR-5** Only the designated distributor can call `distribute()`; it allocates WBTC pro-rata to
  the weighted shares of positions live at distribution time, in O(1).
- **FR-6** Positions past maturity earn nothing from later distributions (day-epoch granularity;
  the <1-day approximation always favors the pool, never the matured position).
- **FR-7** Weight-0 tiers never earn and never dilute other lockers.
- **FR-8** Rewards are claimable at any time — single (`claim`), batch (`claimMany`), or all-owned
  (`claimAll`) — without closing the position; claims never touch principal.
- **FR-9** WBTC distributed while no weighted shares exist is banked (`undistributed`) and released
  into the next distribution that has shares; it is counted as liability throughout.
- **FR-10** Rewards are paid in WBTC only; the system never mints or inflates EVA.

**Exits**
- **FR-11** At/after `endTime` the owner can withdraw 100% of the principal plus final rewards; the
  NFT is burned.
- **FR-12** Before `endTime` the owner can exit at any moment: they keep `curve(elapsed/duration)`
  of the principal as liquid EVA; the remainder is force-burned against the core vault and the
  redeemed backing is forwarded to the owner; the NFT is burned. If the burn slice would redeem to
  zero sats (the vault rejects such burns), the vault call is skipped and that slice is returned as
  liquid EVA instead, so early exit can never revert through the vault (§4.4).
- **FR-13 (owner liveness)** Claiming, withdrawing, early-exiting and transferring must never be
  blockable — by the admin (no pause covers them), by the market or its participants, or by any
  third party. Races resolve in the owner's favor.

**Renewals**
- **FR-14** Only the admin can propose a renewal, escrowing any EVA/WBTC prize up front; only the
  position owner can accept, and only before the offer expires. Acceptance settles pending rewards,
  extends the term (may reactivate a matured position), compounds the EVA prize into principal,
  pays the WBTC prize instantly, and restarts the early-exit clock.
- **FR-15** A pending offer is auto-cancelled (escrow refunded to the admin) when the position is
  transferred, withdrawn or early-exited; the admin can also cancel at any time.

**Positions as NFTs / market**
- **FR-16** Positions in transferable tiers are freely tradable ERC-721s on any marketplace;
  soulbound tiers can be neither transferred nor listed.
- **FR-17** On any real transfer, accrued rewards settle to the previous owner; the new owner
  accrues from acquisition onward; the early-exit clock does NOT reset.
- **FR-18** Listings are approval-based (no escrow): the seller keeps custody and keeps earning
  until sale. `buy()` settles atomically at the listed price — WBTC to the seller, NFT to the
  buyer, accrued rewards to the seller — and the market contract never holds funds.
- **FR-19** A buy succeeds only if the listing is fulfillable: listed ∧ seller still owns ∧ market
  still approved ∧ not renewed since listing. Anyone can prune unfulfillable listings; a position
  must hold `>= minListAmount` EVA to be listed.
- **FR-19b (buyer price bound)** `buy(id, maxPrice)` reverts if the stored ask exceeds the buyer's
  `maxPrice`. The ask is read at execution and the seller can change it at any time, so without this
  bound a buyer with a standing WBTC allowance could be charged an arbitrarily raised price. A lowered
  ask settles at the lower stored price.

**Revenue routing**
- **FR-20** `pay()` splits a WBTC amount across core/SLS/locker by caller-supplied bps that must
  sum to exactly 10,000 (core absorbs rounding); callable only by allowlisted addresses.
- **FR-21** The SLS portion folds into the core leg when no active SLS vault exists; otherwise it
  is delivered by direct transfer or `increaseBacking`, per call.
- **FR-22** The locker leg approves and calls `distribute()` atomically in the same transaction.

**Administration**
- **FR-23** Admin powers only shape the terms of entry for future participants — lock fee (hard
  cap 5%), minimum lock, tier enable/curve for future locks, pausing of new locks — and never the
  terms of an existing position.
- **FR-24** Sweeps can extract only surplus above tracked liabilities (locked principal, unclaimed
  rewards, escrows); they can never touch user funds.
- **FR-25** The tier set (count, weights, durations, transferability) is immutable after
  deployment; no privileged tier can ever be added.

### 3.2 Technical requirements

- **TR-1 Platform.** Solidity 0.8.20 (checked arithmetic), OpenZeppelin 5.x, optimizer runs=200,
  EVM target paris; production chain Arbitrum One.
- **TR-2 Token assumptions.** EVA: standard 18-decimals ERC-20 with `burnFrom`, fixed 21M max
  supply, no hooks. WBTC: standard 8-decimals ERC-20, no transfer hooks. The system is explicitly
  NOT designed for fee-on-transfer, rebasing, or callback (ERC-777-style) tokens.
- **TR-3 Precision & rounding.** Accumulator scaled by 1e27; curves in 1e18 WAD. `perShare` floors
  at distribution; freshly-set `rewardDebt` ceils (`Math.ceilDiv`); settles and views saturate.
  Consequence (must hold): total credited ≤ total received, i.e. over-crediting is impossible
  (invariants §8).
- **TR-4 Liability tracking.** `totalUnclaimedRewards` moves by actual transfer amounts
  (`+= received`, `-= paid`) — never by per-share-rounded sums (drift-free by construction).
- **TR-5 Complexity bounds.** `distribute` O(1); `_processExpiries` O(days since last sweep) —
  amortized O(1) with ~daily payments, self-healing after inactivity; `claimAll` O(caller's
  positions) with `claimMany` as the chunked escape hatch; market operations O(1) (swap-and-pop).
- **TR-6 Reentrancy posture.** Every state-changing external entry point is `nonReentrant`,
  including the ERC-721 `transferFrom` override (OZ v5 `safeTransferFrom` routes through it); CEI
  ordering throughout; the market delivers NFTs via `transferFrom` (no `onERC721Received` callback
  to the buyer); no untrusted code is ever called on a value path.
- **TR-7 Time.** Single `_now()` virtual seam returning `block.timestamp` in production (demo
  builds override it for testnets); day-epoch = `timestamp / 1 days`; the admin has no control
  over time in production.
- **TR-8 No upgradeability.** All three contracts are non-proxied and immutable; mutability is
  limited to the settable knobs in the trust model (§7).
- **TR-9 Integration constraints.** `locker.distributor` must be the router before fees or locker
  payments are enabled (unset distributor waives fees rather than reverting); the router must be an
  authorized payer on the active SLS vault to use `increaseBacking`; the fee path mirrors
  `EVABurnVault.backingWithdraw`'s zero-payout revert and waives instead of reverting.
- **TR-10 Observability.** Every state change emits an event; the order book and per-owner
  position snapshots are single-call views — core UX requires no off-chain indexer.
- **TR-11 Standards.** EVALocker implements ERC-721 + ERC-721Enumerable (ERC-165 supported);
  `tokenURI = baseURI + tokenId`.
- **TR-12 Gas/DoS.** No unbounded loops over externally-growable sets in state-changing paths
  (the only user-scoped loops are the caller's own `claimAll`/`claimMany`); order-book spam is
  capital-gated by `minListAmount`; the expiry sweep is bounded by elapsed days.

## 4. Core mechanisms (EVALocker)

### 4.1 Weighted single-pool accumulator
MasterChef-style: `accRewardPerShare` (scaled by `ACC_PRECISION = 1e27`), position shares
`amount × tierWeight`. `distribute()` is O(1): `acc += pool·ACC / totalShares` (floored). Claims pay
`floor(shares·acc/ACC) − rewardDebt`.

**Solvency rounding rule (deliberate, load-bearing):**
- `perShare` is **floored** at distribution ⇒ total credited ≤ total received.
- Freshly-set `rewardDebt` (in `lock` and `acceptRenewal`) is **ceiled** (`Math.ceilDiv`) ⇒ a
  position's lifetime credit telescopes to `floor(x_end) − ceil(x_start)` ≤ its real entitlement.
  Over-crediting is impossible by construction.
- Settles and views **saturate** (`accumulated > debt ? accumulated − debt : 0`): a ceiled debt may
  briefly exceed the floored accumulated value inside one integer window; that settles to 0 and the
  debt is left untouched.
- History: an earlier floored-debt version allowed `Σ pending` to exceed the tracked liability by
  1 sat under a renewal-heavy fuzz sequence (found by `10-evaLockerSolvencyFuzz`); the ceil/saturate
  scheme is the fix. See §8.
- `totalUnclaimedRewards` tracks liability from **actual received amounts** (`+= amount` on
  distribute, `−= owed` on settle), not per-share-rounded sums — drift-free.

### 4.2 Epoch-bucketed expiry (matured positions stop earning)
- `EPOCH = 1 days`. Each position stores `expiryEpoch = endTime / EPOCH`; its shares are added to
  `expiringShares[expiryEpoch]` at creation.
- `_processExpiries()` runs at the start of **every state-changing call** (lock, claim*, withdraw,
  earlyExit, distribute, acceptRenewal, transfers). It walks each unprocessed day once, and for days
  with expiries: freezes `epochAcc[day] = accRewardPerShare` and subtracts the day's bucket from
  `totalShares`. It never revisits a processed day.
- `_effectiveAcc(p)`: positions with `expiryEpoch ≤ lastProcessedEpoch` settle against the frozen
  `epochAcc[expiryEpoch]`; live ones against the live accumulator. In `distribute()` the sweep runs
  **before** the accumulator increases, so a frozen snapshot excludes the payment being applied.
- **Epoch guards** (both `lock` and `acceptRenewal`): a position must mature in a **future** epoch
  (`expiryEpoch > lastProcessedEpoch`). Without this, shares landing in an already-processed bucket
  would be stranded in `totalShares` forever and the position would brick (its frozen accumulator
  would predate its own debt). Unreachable for real multi-day tiers via `lock`; reachable via
  sub-day renewals — hence the explicit guard.
- Granularity note (intentional): a position stops earning at the **start** of its maturity day
  (≤ endTime) but `withdraw` requires the exact `endTime` timestamp. The <1-day gap always favors
  the pool, never the exiting position.
- Cost: O(days since last call), not O(positions). With ~daily distributions this is O(1) amortized;
  after long inactivity the catch-up is a few hundred cheap iterations (self-healing, no DoS).

### 4.3 Lock fee (mirror-and-waive)
`fee = amount × lockFeeBps / BPS`, skimmed from the deposit; `principal = amount − fee` is what the
position records (shares, withdraw, curve all use principal). The fee is burned via
`coreVault.backingWithdraw(fee)` and the resulting WBTC forwarded to `distributor` in the same tx.

- The core vault **reverts on zero-payout burns** (`"Nothing to withdraw"`). `lock()` therefore
  **mirrors the vault's payout formula** (`fee × wbtc(vault) / eva.totalSupply()`) and **waives** the
  fee when the result is 0 — locking can never revert through the fee path. Also waived when
  `distributor` is unset (deployment ordering can't brick locking; see runbook §9).
- Accounting: `lockedEvaTotal += principal` (never the fee); the fee-WBTC is isolated by balance-diff
  and forwarded out entirely, so it never mixes with `totalUnclaimedRewards`/escrows.
- Economics (intentional): the burn redeems at the **core-floor rate**, so the WBTC captured is
  small; supply reduction is the primary effect. The fee applies to `lock()` only — not to renewal
  prize EVA.
- `Locked` event emits the **principal** (net amount locked), not the pre-fee deposit; indexers
  should treat it accordingly (`LockFeeCharged` carries the fee detail).

### 4.4 Early exit curves
`_applyCurve(curve, elapsed, duration)` returns the WAD fraction kept as liquid EVA: LINEAR `f`,
QUADRATIC `f²`, SQRT `√f` (f = elapsed/duration, clamped to 1). The remainder is force-burned via
`backingWithdraw`, whose WBTC proceeds go to the exiting holder. All launch tiers use LINEAR; the
other curves exist for possible future tiers (a tier's curve applies to **future locks only** —
each position snapshots its curve at lock time).

**Zero-sat burn waiver (mirror-and-waive, same rule as the lock fee).** The core vault reverts on a
burn whose payout `burnEva × B / S` floors to 0 (B = vault WBTC, S = EVA supply). Without a guard,
`earlyExit` would revert for any burn slice below `S/B` — dust positions permanently, and every
position in a thin window just before `endTime` — forcing the holder to wait for maturity. `earlyExit`
therefore mirrors the vault's formula and, when the payout would be 0, skips the vault and folds the
slice into the liquid EVA returned (`EarlyExited.evaBurned = 0`). This waiver cannot be gamed: the
vault's only outflow burns EVA pro-rata (`(B − a·B/S)/(S − a) = B/S`, slightly higher after the payout
floor) and revenue only adds to B, so `B/S` is monotonically non-decreasing and the `S/B` threshold
can only shrink. The waived slice is always worth < 1 sat of backing.

### 4.5 Renewals (opt-in, escrow-backed)
Admin `proposeRenewal(id, extraDuration, keepRemaining, rewardEva, rewardWbtc, offerExpiry)` escrows
the prize up front; only the position owner can `acceptRenewal`. Accept settles pending rewards,
extends the term (may reactivate a matured position), compounds the EVA prize into the principal,
pays the WBTC prize instantly, re-derives shares, resets the curve clock, and re-buckets expiry
(subject to the epoch guard). Transfers and closes cancel any open offer and refund the escrow to
the admin.

### 4.6 ERC-721 semantics
`_update` is the single choke point: real transfers require the tier be transferable (soulbound
enforcement), run `_processExpiries`, settle accrued rewards **to the seller**, and cancel/refund
any open offer. The curve clock does **not** reset on transfer. The public
`transferFrom` override is `nonReentrant`; in OZ v5 `safeTransferFrom` routes through it, so both
entrypoints are guarded. Metadata: `tokenURI = baseURI + tokenId` (off-chain server; base settable).

## 5. PositionMarket

Approval-based (no escrow): sellers keep custody — and keep earning — until sale. `list` snapshots
`position.startTime`; `isFulfillable(id)` = listed ∧ seller still owns ∧ market still approved ∧
`startTime` unchanged (i.e. not renewed since listing). `buy(id, maxPrice)` (nonReentrant) requires
`isFulfillable`, then requires the stored ask `<= maxPrice` (buyer-side bound: `isFulfillable` is
liveness-only and never reads price, so a seller's `updatePrice`/re-`list` between quote and
settlement cannot pull more than the buyer authorised), deletes the listing (effects first), pays the
seller (`safeTransferFrom` buyer → seller — the market never holds WBTC), then `transferFrom`s the
NFT (locker hook settles the seller's accrued rewards). The NFT transfer uses `transferFrom`, **not** `safeTransferFrom` — no
`onERC721Received` callback to the buyer, eliminating the classic marketplace reentrancy vector.
The locker's own guarded `transferFrom` is the final backstop on ownership/approval/soulbound.

Anti-spam: positions must hold ≥ `minListAmount` EVA to list (order book flooding costs locked
capital). `pruneStale` lets anyone remove unfulfillable entries. Enumerable order book
(`getActiveListingsDetailed`) serves clients in one call — no indexer required.

**Liveness guarantee (tested):** the market holds no state on the locker and the locker holds no
reference to the market; nothing the market or its participants do can ever block an owner from
claiming, transferring, withdrawing or early-exiting. Races resolve in the owner's favor (the buy
reverts). See `test/PositionMarket/3-marketLiveness.test.ts`.

## 6. RevenueRouter

Holds the protocol's WBTC float (funded by plain transfers). `pay(amount, coreBps, slsBps,
lockerBps, increaseSLS, additionalEva)` — allowlisted callers only; bps must sum to 10,000; core
receives the rounding remainder. SLS leg: `increaseBacking` (requires the router be an authorized
payer on the active vault) or direct transfer; **folds into core when no active SLS vault exists**.
Locker leg: approve + `distribute` atomically (router must be the locker's `distributor`).
`rescue(token, to, amount)` is an owner escape hatch over **any** token including the float — see
trust model.

## 7. Trust model & admin powers

Principle: **admin powers only shape terms of entry for future participants; they never change the
deal of an existing position.** Positions snapshot shares, curve, endTime and debt at lock time.

| Power | Contract | Bound |
|---|---|---|
| `setLockFee` | EVALocker | Hard cap `MAX_LOCK_FEE_BPS = 500` (5%); charged at entry only, never retroactive |
| `setMinLockAmount` | EVALocker | New locks only |
| `setTierCurve` / `setTierEnabled` / `setLocksPaused` | EVALocker | Future/new locks only; claims, withdrawals and exits are never pausable |
| `setDistributor` | EVALocker | Redirects future reward flow + fee destination; cannot touch accrued rewards (reserved) |
| `sweepWbtc` / `sweepEva` | EVALocker | Strays only: reserves `totalUnclaimedRewards + wbtcEscrow` / `lockedEvaTotal + evaEscrow` |
| `proposeRenewal` / `cancelRenewal` | EVALocker | Prize escrowed up front; holder must opt in; cancel refunds admin only |
| `setBaseURI` | EVALocker | Metadata only |
| `setMinListAmount` | PositionMarket | New listings only |
| `setCaller` | RevenueRouter | Gates `pay()` |
| `rescue` | RevenueRouter | ⚠ **Unbounded over the router's balance** — deliberate escape hatch; the float is operational funds, not user deposits. Mitigation: owner should be a multisig (ops requirement). |

Weights/durations/tier set: immutable, no setter, no `addTier` — the "no better tier can ever be
created" guarantee is structural.

Known accepted risk: a fee change between a user's read and their `lock` tx can skim up to the cap
(5%) unexpectedly. A `maxFeeBps` slippage-style parameter on `lock()` is a considered, currently
unimplemented option (pending team decision).

## 8. Invariants (enforced by the fuzz suites)

Checked after every step of random op sequences (`test/EVALocker/5-…` and strict v2 `10-…`, three
seeds, ops: lock, distribute, claim, earlyExit, withdraw, time travel, transfer, fee/min retuning,
renewals):

1. **WBTC solvency (strict equality):** `wbtc.balanceOf(locker) == totalUnclaimedRewards + wbtcEscrow`.
2. **EVA solvency (strict equality):** `eva.balanceOf(locker) == lockedEvaTotal + evaEscrow`.
3. **No over-promising:** `Σ pending(live) ≤ totalUnclaimedRewards`.
4. **Shares conservation:** `totalShares == Σ shares of positions with expiryEpoch > lastProcessedEpoch`.
5. **Liveness:** `pending()` never reverts; after maturing everything, **every** position withdraws
   successfully (no try/catch), then `lockedEvaTotal == 0` and `totalShares == 0`.
6. **Dust bound:** after full drain, `totalUnclaimedRewards − undistributed` < 10⁻⁴ WBTC (pure
   rounding dust; sweep-safe, unclaimable by design).

### Issues found and fixed during development
| Finding | Fix |
|---|---|
| `totalUnclaimedRewards` tracked per-share-rounded sums; `Σ pending` could exceed it by 1 wei (underflow risk on settle) | Track liability from actual transfer amounts |
| Floored fresh `rewardDebt` allowed ≤1 sat over-credit per lock/renewal; strict fuzz produced `Σ pending = liability + 1 sat` | Ceil fresh debts (`Math.ceilDiv`) + saturating settle/views (§4.1) |
| Sub-day renewal could land shares in an already-processed epoch bucket → stranded `totalShares` + bricked position | Future-epoch guards in `lock`/`acceptRenewal` (§4.2) |
| Zero-payout vault burn would revert `lock()` for dust fees | Mirror-and-waive (§4.3) |
| Zero-payout vault burn would revert `earlyExit()` for dust positions / thin pre-maturity window (audit F-2026-19108) | Mirror-and-waive in `earlyExit` (§4.4) |
| `buy()` had no buyer-side price bound; seller could raise the ask between quote and settlement (audit F-2026-19104) | `buy(id, maxPrice)` (§5) |

## 9. Deployment & wiring runbook (order matters)

1. Deploy `EVALocker(eva, wbtc, coreVault, weights, durations, curves, transferables)` (§2 table).
2. Deploy `PositionMarket(locker, wbtc, minListAmount)`.
3. Deploy `RevenueRouter(wbtc, coreVault, slsFactory, locker, initialCallers)`.
4. `locker.setDistributor(router)` — **before enabling any lock fee**: with no distributor the fee
   is silently waived (safe, but forfeits revenue).
5. If using `increaseSLS`: authorize the router as payer on the active SLS vault.
6. Optional: `locker.setLockFee(bps ≤ 500)`, `locker.setMinLockAmount(amount)`, `locker.setBaseURI(uri)`.
7. Fund the router with WBTC; router callers invoke `pay(...)` (bps sum = 10,000).
8. Transfer ownership of all three contracts to the operations multisig.

Ops rule: avoid `lockerBps > 0` while the locker holds only weight-0 positions — the WBTC banks
into `undistributed` (counted as liability, unrecoverable by sweep) until weighted shares exist.

## 10. Tests & coverage

`npx hardhat test test/EVALocker/*.test.ts test/PositionMarket/*.test.ts test/RevenueRouter/*.test.ts`
— **148 passing.** Coverage (`npx hardhat coverage --testfiles "test/{EVALocker,PositionMarket,RevenueRouter}/*.test.ts"`):

| Contract | Stmts | Branch | Funcs | Lines | Uncovered |
|---|---|---|---|---|---|
| PositionMarket | 100% | 100% | 100% | 100% | — |
| RevenueRouter | 100% | 97% | 100% | 100% | one defensive SLS-leg branch permutation |
| EVALocker | ~99% | ~94% | ~97% | ~99.6% | mandated `_increaseBalance` override (unreachable without ERC721Consecutive); false-sides of defensive guards (`supply > 0`, `received > 0`) |

Suite map: `0` core flows · `1` edge cases · `2` branch completion · `3` reentrancy (malicious token
modes 0–6, incl. `market.buy`) · `4` hard cases · `5` stateful invariant fuzz · `6` transfer/settle ·
`7` offer-on-burn · `8` lock fee & minimum · `9` epoch guards · `10` strict solvency/liveness fuzz
(3 seeds) — plus market `0–3` (incl. staleness and owner-liveness) and router suites.

## 11. Code conventions

The three locker-system contracts follow the official Solidity style guide (layout order, declaration
order, visibility ordering with view/pure last, CapWords/mixedCase/UPPER_CASE naming, double quotes,
4-space indent, ≤120-char lines, NatSpec on the public interface). Accepted deviations:

- **Constructor parameters with leading underscores** (`_eva`, `_wbtc`, …): OZ-idiomatic shadow
  avoidance; the guide reserves `_leading` for internals but does not forbid this common usage.
- **`require` strings instead of custom errors**: readability choice; consistent with the deployed
  legacy contracts the system integrates with.
- **Domain-grouped sections** (banners like USER ACTIONS / RENEWALS) within the mandated
  external → public → internal ordering.
- Legacy out-of-scope contracts (e.g. `EVABurnVault.burnMade`) predate these conventions and are
  immutable on-chain.
