## Secondary Liquidity Source (SLS)

### Introduction
Secondary Liquidity Source (SLS) extends the EverValueCoin (EVA) ecosystem with segmented, backing‑token‑specific exit liquidity guarantees. Each SLS vault commits a fixed EVA coverage against a designated ERC‑20 backing token (e.g., WBTC, USDT), enabling independent tranches with different prices, terms, and collateral.

- **Non‑decreasing redemption**: User redemption cannot worsen; price can only hold or improve when backing increases or EVA coverage is added with sufficient backing.
- **Policy invariance**: Redemption math is fixed at creation; payers can only add backing (and optionally EVA coverage) while respecting a price guard.
- **Single‑active‑vault model**: The factory enforces one active SLS vault at a time; depletion clears the active slot.

#### Lifecycle (high level)
1. Factory owner creates an SLS vault for a chosen backing token and fixed EVA coverage; optionally funds initial backing.
2. Users redeem EVA against the vault proportionally to its backing.
3. Vault auto‑marks depletion at zero coverage; any stray assets can be recovered via emergency functions.

## Features

- **Fixed EVA coverage per vault**: Each vault commits a fixed EVA amount for redemption.
- **Price guard on top‑ups**: `increaseBacking` enforces non‑decreasing price when adding coverage and backing.
- **Payer authorization**: Owner-managed `isPayer` mapping controls who can call `increaseBacking`.
- **Proportional redemption**: Users call `backingWithdraw(amount)` to burn EVA and withdraw proportional backing.
- **Emergency handling**: Post‑depletion backing sweep; EVA sweep anytime.
- **Factory‑managed lifecycle**:
  - `createVault(backingToken, fixedEvaAmount, initialBacking)` (deploys vault, optionally funds backing).
  - `setCreationPaused(paused)` (control new vault issuance).
  - `onVaultDepletion()` (called by vault; clears active slot and decrements count).
- **Observability**
  - Factory: `getAllVaults()`, `getVaultsByBackingToken(token)`, `getTotalBackingByToken(token)`, `getVaultCount()`, `isValidVault(vault)`.
  - Vault: `getEffectiveEvaAmount()`.

### Roles & Permissions

- **Admin (Factory owner)**:
  - `createVault(backingToken, fixedEvaAmount, initialBacking)`
  - `setCreationPaused(paused)`
- **Vault owner**:
  - `setPayer(address,bool)` to manage payers for `increaseBacking`
  - Emergency withdrawals after depletion
- **Payer**:
  - `increaseBacking(additionalEva, backingAmount)` (authorized by owner)
- **User**:
  - `backingWithdraw(amount)`

## Contracts

### SLSburnVaultFactory

**Overview**  
Manages the lifecycle of SLS vaults, tracks vault count, and provides views/utilities for querying vaults. Enforces a single active vault at a time.

- **Key state**
  - `eva` (`EverValueCoin`)
  - `vaults` (address[])
  - `vaultInfo(vault)` → `{ backingToken, fixedEvaAmount, createdAt }`
  - `vaultsByBackingToken(token)` → address[]
  - `creationPaused` (bool)
  - `totalVaultCount` (uint256) — counts SLS vaults
  - `activeVault` (address) — only one at a time

- **Events**
  - `VaultCreated(address vault, address creator, address backingToken, uint256 fixedEvaAmount)`
  - `CreationPauseToggled(bool paused)`
  - `VaultDepleted(address vault)`

- **Functions**
  - `constructor(address _evaAddress)`
  - `createVault(address backingToken, uint256 fixedEvaAmount, uint256 initialBacking)` onlyOwner
  - `onVaultDepletion()` external (called by a vault)
  - `setCreationPaused(bool paused)` onlyOwner

- **Views**
  - `getAllVaults() → address[]`
  - `getVaultsByBackingToken(address token) → address[]`
  - `getTotalBackingByToken(address token) → uint256`
  - `getVaultCount() → uint256`
  - `isValidVault(address vault) → bool`

### SLSburnVault

**Overview**  
Per‑vault contract that guarantees redemption up to a fixed EVA amount. Users burn `EVA` to withdraw a proportional share of the backing token. Authorized payers can add backing and optionally EVA coverage with a price guard.

- **Key state**
  - `backingToken` (address)
  - `fixedEvaAmount` (uint256)
  - `hasBeenDepleted` (bool)
  - `isPayer(address) → bool`

- **Events**
  - `BurnMade(uint256 evaBurned, uint256 backingWithdrew)`
  - `BackingIncreased(uint256 additionalEva, uint256 backingAdded)`
  - `PayerUpdated(address payer, bool allowed)`

- **Functions**
  - `constructor(address _addrEva, address _addrBackingToken, uint256 _fixedEvaAmount, address _factory)`
  - `backingWithdraw(uint256 amount)` — burns `EVA` from caller and transfers proportional backing
  - `getEffectiveEvaAmount() → uint256` — remaining allocation
  - `increaseBacking(uint256 additionalEva, uint256 backingAmount)` — authorized payers; price guard; optional EVA increase
  - `setPayer(address payer, bool allowed)` onlyOwner — manage payer list
  - `emergencyWithdrawBacking()` onlyOwner — after depletion
  - `emergencyWithdrawEVA()` onlyOwner — anytime

### Dependencies

- `EverValueCoin` (EVA): fixed‑supply ERC20 with `burn`/`burnFrom`.
- Uses OpenZeppelin `Ownable`, `IERC20`, `SafeERC20`.

## Functional Requirements

### Roles
- **Factory Admin**: Owns `SLSburnVaultFactory`; creates vaults, pauses/unpauses creation.
- **Vault Owner**: Manages payer list; can use emergency withdrawals post‑depletion.
- **Payer**: Calls `increaseBacking` (if authorized).
- **User**: Burns EVA to redeem proportional backing via `backingWithdraw(amount)`.

### Capabilities
- **Create vaults (Factory admin)**:
  - `createVault(backingToken, fixedEvaAmount, initialBacking)` deploys a new vault.
  - Tracks vault in `vaults`, `vaultsByBackingToken`, increments `totalVaultCount`, sets `activeVault`.
- **Pause/unpause creation (Factory admin)**:
  - `setCreationPaused(bool)` to control new vault issuance.
- **Top-up / cover more (Payers set by owner)**:
  - `increaseBacking(additionalEva, backingAmount)` with price guard; optional EVA coverage increase.
- **Redeem backing (User)**:
  - `backingWithdraw(amount)` burns user EVA and transfers a proportional share of the vault’s backing using current coverage.
- **Emergency (Vault owner)**:
  - `emergencyWithdrawBacking()` after depletion.
  - `emergencyWithdrawEVA()` anytime.

### Use Cases
1. **Admin creates a WBTC-backed vault**:
   - Approves backing; calls `createVault(WBTC, fixedEva, initialBacking)`.
2. **User redeems**:
   - Approves vault to spend EVA; calls `backingWithdraw(amount)`; receives proportional backing.
3. **Payer top-up**:
   - Owner sets payer; payer calls `increaseBacking` to add backing and optionally coverage (non‑decreasing price).
4. **Operational controls**:
   - Admin pauses vault creation during maintenance; unpauses to resume.

---

## Technical Requirements

### Contracts & Key Functions

- `SLSburnVaultFactory`:
  - `constructor(address _evaAddress)`
  - `createVault(address backingToken, uint256 fixedEvaAmount, uint256 initialBacking)` onlyOwner returns (address)
  - `onVaultDepletion()` external (called by a vault)
  - `setCreationPaused(bool paused)` onlyOwner
  - Views: `getAllVaults()`, `getVaultsByBackingToken(token)`, `getTotalBackingByToken(token)`, `getVaultCount()`, `isValidVault(vault)`

- `SLSburnVault`:
  - `constructor(address _addrEva, address _addrBackingToken, uint256 _fixedEvaAmount, address _factory)` — enforces `_fixedEvaAmount >= ONE_EVA`, sets `fixedEvaAmount = _fixedEvaAmount`
  - `backingWithdraw(uint256 amount)` — burns caller EVA; transfers proportional backing using `(amount * backingBalance) / effectiveEvaAmount`
  - `getEffectiveEvaAmount() → uint256` — remaining allocation
  - `increaseBacking(uint256 additionalEva, uint256 backingAmount)` — authorized payers; price guard; optional EVA increase
  - `setPayer(address,bool)` onlyOwner — manage payer list
  - `emergencyWithdrawBacking()` onlyOwner — after depletion
  - `emergencyWithdrawEVA()` onlyOwner — anytime

### State/Constants
- `ONE_EVA = 1e18`
- Factory tracks:
  - `totalVaultCount` (SLS vaults), `vaults`, `vaultsByBackingToken`, `vaultInfo`, `creationPaused`, `activeVault`
- Vault tracks:
  - `fixedEvaAmount`, `backingToken`, `hasBeenDepleted`, `isPayer`

### Events
- Factory: `VaultCreated`, `CreationPauseToggled`, `VaultDepleted`
- Vault: `BurnMade`, `BackingIncreased`, `PayerUpdated`

### Preconditions & Invariants
- `createVault` requires `fixedEvaAmount > 0`, non‑zero `backingToken`.
- Vault constructor enforces `_fixedEvaAmount >= ONE_EVA` and `<= eva.totalSupply()`.
- User redemption bounded by `getEffectiveEvaAmount()`; cannot exceed remaining coverage.
- `increaseBacking` requires authorized payer, non‑decreasing price, and supply cap respected.
- Emergency backing withdrawal only after depletion.

### External Integrations
- Uses OpenZeppelin `Ownable`, `IERC20`, `SafeERC20`.

## SLS Math

- Users redeem proportionally to remaining coverage: `backingToTransfer = amount * backingBalance / effectiveEvaAmount`.
- Price guard on `increaseBacking` when `additionalEva > 0`: `backingAmount * fixedEvaAmount >= currentBacking * additionalEva`.
- Supply cap: `fixedEvaAmount` cannot exceed `eva.totalSupply()`.

### Intended Usage

This system is centrally managed by the project, taking into account current market conditions and the existence of other vaults when creating and funding new vaults. The general policy is to keep total EVA covered by SLS vaults strictly below current total supply. Payers are explicitly authorized by the vault owner to add backing (and optionally coverage) without reducing price, and only one SLS vault is active at any time.

