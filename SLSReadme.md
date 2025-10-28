## Secondary Liquidity Source (SLS)

### Introduction
Secondary Liquidity Source (SLS) extends the EverValueCoin (EVA) ecosystem with segmented, quote‑token‑specific exit liquidity guarantees. Each SLS vault commits a fixed EVA coverage against a designated ERC‑20 backing token (e.g., WBTC, USDT), enabling independent tranches with different prices, terms, and collateral.

- **Non‑decreasing redemption**: The redemption policy for users is non‑decreasing over time and may improve as global EVA supply shrinks.
- **Sentinel EVA safety**: Each vault holds 1 EVA to allow admin‑only finalization that unlocks residual backing after user coverage is exhausted or globally constrained.
- **Policy invariance**: Admins cannot change user redemption math post‑creation; actions are limited to creating vaults and supplying backing per vault.

#### Benefits
- **Diversified collateral and pricing** per tranche  
- **Deterministic exit liquidity** for covered EVA  
- **No global coordination in vault logic**, while allowing safe administrative finalization via the sentinel mechanism

#### Lifecycle (high level)
1. Create an SLS vault for a chosen backing token and fixed EVA coverage.
2. Fund the vault with backing tokens (optionally at creation).
3. Users redeem EVA against the vault according to the tranche policy.
4. Admin finalizes by burning the sentinel EVA and withdrawing residual backing once user coverage is exhausted or globally constrained.

## Features

- **Fixed EVA coverage per vault**: Each SLS vault commits a fixed EVA amount for redemption, reserving a 1 EVA sentinel for admin finalization (constructor subtracts `ONE_EVA` from `fixedEvaAmount`).
- **Non‑decreasing redemption**: User redemption cannot worsen; it may improve as global EVA supply shrinks, via `getEffectiveEvaAmount()`.
- **Any ERC‑20 backing**: Each vault is tied to a specific backing token (`backingTokenAddress`), enabling distinct tranches and pricing.
- **Proportional redemption**: Users call `backingWithdraw(amount)` to burn EVA and withdraw a proportional share of the vault’s backing.
- **Sentinel EVA finalization**: Vault owner calls `adminFinalWithdraw()` once `getEffectiveEvaAmount() == 0`; it burns the vault’s EVA balance (incl. sentinel) and withdraws remaining backing.
- **Factory‑managed lifecycle**:
  - `initializeOriginalVaultReservation()` (locks 1 EVA in factory for the legacy burn vault path).
  - `createVault(backingToken, fixedEvaAmount, initialBacking)` (deploys vault, optionally funds backing, transfers 1 EVA sentinel).
  - `setCreationPaused(paused)` (control new vault issuance).
  - `onVaultDepletion()` (called by vault; reduces global count).
  - `finalBurnVaultWithdraw()` (legacy burn vault final path).
- **Observability**
  - Factory (global): `getAllVaults()`, `getVaultsByBackingToken(token)`, `getTotalBackingByToken(token)`, `getVaultCount()`.
  - Vault (per‑vault): `backingTokenAddress()`, `getEffectiveEvaAmount()`.

### Roles & Permissions

- **Admin (Factory owner)**:
  - `initializeOriginalVaultReservation()`
  - `createVault(backingToken, fixedEvaAmount, initialBacking)`
  - `setCreationPaused(paused)`
  - `finalBurnVaultWithdraw()`
- **Admin (Vault owner)**:
  - `adminFinalWithdraw()`
- **User**:
  - `backingWithdraw(amount)`

## Contracts

### SLSburnVaultFactory

**Overview**  
Manages the lifecycle of SLS vaults, tracks global vault count, and provides views/utilities for querying vaults. It also holds references to `EverValueCoin` (`EVA`) and the original `EVABurnVault` for the legacy final-withdraw path.

- **Key state**
  - `eva` (`EverValueCoin`)
  - `wbtc` (`IERC20`)
  - `burnVault` (`EVABurnVault`)
  - `vaults` (address[])
  - `vaultInfo(vault)` → `{ backingToken, fixedEvaAmount, createdAt }`
  - `vaultsByBackingToken(token)` → address[]
  - `creationPaused` (bool)
  - `totalVaultCount` (uint256)
  - `originalVaultReserved` (bool)

- **Events**
  - `VaultCreated(address vault, address creator, address backingToken, uint256 fixedEvaAmount)`
  - `CreationPauseToggled(bool paused)`
  - `VaultDepleted(address vault)`
  - `OriginalVaultReserved()`
  - `LastBurnVaultWithdraw()`

- **Functions**
  - `constructor(address _evaAddress, address _burnVaultAddress, address _wbtcAddress)`
  - `initializeOriginalVaultReservation()` onlyOwner
  - `finalBurnVaultWithdraw()` onlyOwner
  - `createVault(address backingToken, uint256 fixedEvaAmount, uint256 initialBacking) returns (address vaultAddress)` onlyOwner
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
Per‑vault contract that guarantees redemption up to a fixed EVA amount (with 1 EVA reserved as sentinel). Users burn `EVA` to withdraw a proportional share of the backing token. The vault owner can finalize once user coverage is exhausted.

- **Key state**
  - `backingTokenAddress` (address)
  - `fixedEvaAmount` (uint256) — already excludes the 1 EVA sentinel
  - `hasBeenDepleted` (bool)

- **Events**
  - `burnMade(uint256 evaBurned, uint256 backingWithdrew)`

- **Functions**
  - `constructor(address _addrEva, address _addrBackingToken, uint256 _fixedEvaAmount, address _factory)`
  - `backingWithdraw(uint256 amount)` — burns `EVA` from caller and transfers proportional backing
  - `getEffectiveEvaAmount() → uint256` — min of remaining fixed coverage and global available EVA pool
  - `adminFinalWithdraw()` onlyOwner — requires `getEffectiveEvaAmount() == 0`, burns vault’s `EVA` balance (incl. sentinel), calls factory’s `onVaultDepletion()`, and transfers remaining backing to owner


### Dependencies

- `EverValueCoin` (EVA): fixed‑supply ERC20 with `burn`/`burnFrom`; `totalSupply()` is used in SLS math.
- `EVABurnVault`: original burn vault. The factory’s `finalBurnVaultWithdraw()` interacts with it for the legacy final-withdraw flow.

## Functional Requirements

### Roles
- **Factory Admin**: Owns `SLSburnVaultFactory`; initializes original reservation, creates vaults, pauses/unpauses creation, triggers legacy final burn-vault withdraw.
- **Vault Owner**: Receives ownership of each created `SLSburnVault`; can run `adminFinalWithdraw()` once user coverage is exhausted.
- **User**: Burns EVA to redeem proportional backing via `backingWithdraw(amount)`.

### Capabilities
- **Create vaults (Factory admin)**:
  - `createVault(backingToken, fixedEvaAmount, initialBacking)` deploys a new vault.
  - Transfers optional `initialBacking` to the vault and 1 EVA sentinel to the vault.
  - Tracks vault in `vaults`, `vaultsByBackingToken`, increments `totalVaultCount`.
- **Pause/unpause creation (Factory admin)**:
  - `setCreationPaused(bool)` to control new vault issuance.
- **Initialize original reservation (Factory admin)**:
  - `initializeOriginalVaultReservation()` requires factory to hold ≥ 1 EVA; enables legacy flow.
- **Legacy final burn vault withdraw (Factory admin)**:
  - `finalBurnVaultWithdraw()` interacts with `EVABurnVault` once conditions are met.
- **Redeem backing (User)**:
  - `backingWithdraw(amount)` burns user EVA and transfers a proportional share of the vault’s backing using effective coverage math.
- **Finalize vault (Vault owner)**:
  - `adminFinalWithdraw()` allowed only when `getEffectiveEvaAmount() == 0`.
  - Burns the vault’s EVA balance (incl. sentinel), calls `factory.onVaultDepletion()`, transfers remaining backing to owner.

### Use Cases
1. **Admin creates a WBTC-backed vault**:
   - Approves backing and EVA sentinel transfers; calls `createVault(WBTC, fixedEva, initialBacking)`.
2. **User redeems**:
   - Approves vault to spend EVA; calls `backingWithdraw(amount)`; receives proportional backing.
3. **Vault finalization**:
   - After user coverage is exhausted (or globally constrained), vault owner calls `adminFinalWithdraw()` to burn sentinel and claim residual backing.
4. **Operational controls**:
   - Admin pauses vault creation during maintenance; unpauses to resume.

---

## Technical Requirements

### Contracts & Key Functions

- `SLSburnVaultFactory`:
  - `constructor(address _evaAddress, address _burnVaultAddress, address _wbtcAddress)`
  - `initializeOriginalVaultReservation()` onlyOwner
  - `finalBurnVaultWithdraw()` onlyOwner
  - `createVault(address backingToken, uint256 fixedEvaAmount, uint256 initialBacking)` onlyOwner returns (address)
  - `onVaultDepletion()` external (called by a vault)
  - `setCreationPaused(bool paused)` onlyOwner
  - Views: `getAllVaults()`, `getVaultsByBackingToken(token)`, `getTotalBackingByToken(token)`, `getVaultCount()`, `isValidVault(vault)`

- `SLSburnVault`:
  - `constructor(address _addrEva, address _addrBackingToken, uint256 _fixedEvaAmount, address _factory)` — enforces `_fixedEvaAmount >= ONE_EVA`, sets `fixedEvaAmount = _fixedEvaAmount - ONE_EVA`
  - `backingWithdraw(uint256 amount)` — burns caller EVA; transfers proportional backing using `(amount * backingBalance) / (effectiveEva + ONE_EVA)`
  - `getEffectiveEvaAmount() → uint256` — `min(fixedEvaAmount, eva.totalSupply() - totalVaultCount * ONE_EVA)` (floored at zero)
  - `adminFinalWithdraw()` onlyOwner — requires `getEffectiveEvaAmount() == 0`; burns vault EVA balance; calls factory `onVaultDepletion()`; transfers remaining backing

### State/Constants
- `ONE_EVA = 1e18`
- Factory tracks:
  - `totalVaultCount` (includes original reservation; decremented on vault depletion)
  - `vaults`, `vaultsByBackingToken`, `vaultInfo`
  - `originalVaultReserved`, `creationPaused`
- Vault tracks:
  - `fixedEvaAmount` (excludes sentinel), `backingTokenAddress`, `hasBeenDepleted`

### Events
- Factory: `VaultCreated`, `CreationPauseToggled`, `VaultDepleted`, `OriginalVaultReserved`, `LastBurnVaultWithdraw`
- Vault: `burnMade(evaBurned, backingWithdrew)`

### Preconditions & Invariants
- Factory must hold ≥ 1 EVA to `initializeOriginalVaultReservation()`.
- `createVault` requires `fixedEvaAmount > 0`, non‑zero `backingToken`, and original reservation initialized.
- Vault constructor enforces `_fixedEvaAmount >= ONE_EVA` and `<= eva.totalSupply()`.
- User redemption bounded by `getEffectiveEvaAmount()`; cannot exceed remaining coverage.
- Finalization only when `getEffectiveEvaAmount() == 0`.

### External Integrations
- Uses OpenZeppelin `Ownable`, `IERC20`, `SafeERC20`.
- `EVABurnVault` referenced by factory for legacy final withdraw path.


## SLS Math

- The vault reserves 1 EVA (sentinel) for admin-only finalization. Users can only redeem up to the fixed coverage minus that sentinel.
- During user withdrawals, the payout denominator adds back the sentinel so users never consume it, leaving residual backing for the final admin withdraw.
- Finalization is allowed only when user coverage is exhausted; the vault then burns its EVA balance (including the sentinel) and transfers all remaining backing to the owner.

### Sentinel constant
```22:23:contracts/SLSburnVault.sol
uint256 public constant ONE_EVA = 1 * 10**18;
```

### Reserve 1 EVA at creation (subtract ONE_EVA)
```49:69:contracts/SLSburnVault.sol
/// @notice Constructor ... and reserves 1 EVA for the last withdrawal
constructor(address _addrEva, address _addrBackingToken, uint256 _fixedEvaAmount, address _factory) Ownable(msg.sender) {
    ...
    require(_fixedEvaAmount >= ONE_EVA, "Fixed EVA amount must be greater than or equal to 1 EVA");
    ...
    //Always reserve 1 EVA for the last withdrawal
    fixedEvaAmount = _fixedEvaAmount - ONE_EVA;
}
```
- Why: `fixedEvaAmount` stored is already net of the sentinel. Users cannot redeem this last 1 EVA share.

### Effective user coverage (global cap)
```96:108:contracts/SLSburnVault.sol
function getEffectiveEvaAmount() public view returns (uint256) {
    uint256 currentTotalSupply = eva.totalSupply();
    uint256 vaultCount = factory.totalVaultCount();        
    // Available EVA pool = totalSupply - vaultCount (reserving 1 EVA per vault)
    uint256 reservedEva = vaultCount * ONE_EVA;
    uint256 availableEvaPool = currentTotalSupply > reservedEva ? currentTotalSupply - reservedEva : 0;
    
    return fixedEvaAmount < availableEvaPool ? fixedEvaAmount : availableEvaPool;
}
```
- Why: Users can redeem only the lesser of this vault’s remaining coverage and globally available EVA (after reserving 1 EVA per vault).

### User withdrawal (add ONE_EVA in denominator)
```71:83:contracts/SLSburnVault.sol
function backingWithdraw(uint256 amount) public {
    uint256 effectiveEvaAmount = getEffectiveEvaAmount();
    require(effectiveEvaAmount > 0, "No EVA amount remaining in this vault");
    require(amount <= effectiveEvaAmount, "Amount exceeds remaining EVA in vault");
    require(backingToken.balanceOf(address(this)) > 0, "Nothing to withdraw");

    // Add 1 EVA to the effective EVA amount to account for the last withdrawal
    uint256 backingToTransfer = (amount * backingToken.balanceOf(address(this))) / (effectiveEvaAmount + ONE_EVA);
    require(backingToTransfer > 0, "Nothing to withdraw");

    fixedEvaAmount -= amount;
    eva.burnFrom(msg.sender, amount);
    backingToken.safeTransfer(msg.sender, backingToTransfer);

    emit burnMade(amount, backingToTransfer);
}
```
- Why: The `+ ONE_EVA` ensures users never consume the sentinel’s share of backing.

### Admin finalization (burn sentinel and sweep residual)
```110:131:contracts/SLSburnVault.sol
function adminFinalWithdraw() external onlyOwner {
    uint256 effectiveEvaAmount = getEffectiveEvaAmount();
    require(effectiveEvaAmount == 0, "Can only withdraw when effective EVA amount is 0");
    
    uint256 backingBalance = backingToken.balanceOf(address(this));
    uint256 evaBalance = eva.balanceOf(address(this));
    // Burn the locked EVA (always 1 EVA, guaranteed by factory at vault creation)
    eva.burn(evaBalance);
    if(!hasBeenDepleted) {
        factory.onVaultDepletion();
        hasBeenDepleted = true;
    }
    
    // Transfer all remaining backing to owner
    backingToken.safeTransfer(owner(), backingBalance);        
    emit burnMade(evaBalance, backingBalance);
}
```
- Why: Once no user coverage remains, the admin burns the vault’s EVA (including the sentinel) and withdraws the residual backing preserved by the `+ ONE_EVA` in user payouts.
- 
## Intended Usage

This system is centrally managed by the project, taking into account current market conditions, the EVA total supply, and the existence of other vaults when creating any new vault. The general policy is to keep the total EVA covered by secondary (SLS) vaults strictly below the current total supply. Operating under this constraint makes simultaneous “last EVA” extraction across multiple vaults extremely difficult or practically impossible, or the situation where we need burns from users to be able to unlock our vaults.