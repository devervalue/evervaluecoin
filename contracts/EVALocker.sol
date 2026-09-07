// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title Minimal interface for the core EVABurnVault.
 * @notice Used on early exit: the locker burns the position's EVA against the core
 *         vault and receives the proportional backing (WBTC), which it forwards to the user.
 */
interface IEVABurnVault {
    function backingWithdraw(uint256 amount) external;
}

/**
 * @title EVALocker
 * @notice Time-locked EVA staking with WBTC yield distributed via a weighted single-pool accumulator.
 *         Positions are ERC-721 tokens and may be traded on a secondary market (per-tier opt-in).
 * @dev Design summary (see project discussion):
 *      - Custodial lock: the contract holds the user's EVA; that custody is what prevents selling/transfer.
 *      - Reward accounting: one global accumulator (`accRewardPerShare`). A position's shares are
 *        `amount * tierWeight`. Distributions are O(1); the project tier has weight 0 (earns nothing,
 *        dilutes no one).
 *      - Expiry: matured positions stop earning. Expiring shares are bucketed by day-epoch and retired
 *        lazily at the start of each distribution (and any state-changing call), with the accumulator
 *        snapshotted at retirement so matured positions freeze at the correct rate.
 *      - Early exit: redeem against the core burn vault. A time-based curve sets the fraction returned as
 *        liquid EVA vs the fraction force-burned for backing. At t=0 burn 100%, at maturity burn 0%.
 *      - Renewals: the admin escrows a prize and proposes new terms for a specific position; the owner
 *        opts in. EVA prize compounds into the position; WBTC prize pays out instantly. The early-exit
 *        curve clock restarts at acceptance.
 *      - Tradeable positions: each position is an ERC-721. On transfer the seller's rewards are settled,
 *        any open renewal offer is cancelled/refunded to the admin, and the curve clock is NOT reset.
 *        Tiers may be marked non-transferable (soulbound), e.g. the project/trust tier.
 */
contract EVALocker is ERC721, ERC721Enumerable, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---- type declarations ----

    /// @notice Early-exit penalty curves; value = fraction RETURNED as liquid EVA at exit time.
    enum Curve {
        LINEAR, // kept = f
        QUADRATIC, // kept = f^2     (stickier: harsher early exit)
        SQRT // kept = sqrt(f)  (gentler early exit)
    }

    /// @notice A lock tier's configuration; fixed at deployment except `defaultCurve` and `enabled`.
    struct Tier {
        uint256 weight; // immutable share multiplier (0 = project/trust tier)
        uint256 duration; // lock length in seconds
        Curve defaultCurve; // early-exit curve assigned to NEW locks (admin-settable)
        bool enabled; // whether new locks may open in this tier
        bool transferable; // whether positions in this tier can be traded (soulbound if false)
    }

    /// @notice A live locked position; all terms are snapshotted here at lock/renewal time.
    struct Position {
        uint256 tierId;
        uint256 amount; // EVA locked
        uint256 shares; // amount * tier.weight (snapshot)
        uint256 startTime;
        uint256 endTime;
        uint256 expiryEpoch; // endTime / EPOCH
        uint256 rewardDebt; // shares * acc / ACC at last settle (rounded UP when freshly set)
        Curve curve; // snapshot of tier.defaultCurve at lock time
    }

    /// @notice An admin-proposed renewal awaiting the position owner's acceptance; prize is escrowed.
    struct RenewalOffer {
        uint256 extraDuration;
        bool keepRemaining; // true: newEnd = oldEnd + extra; false: newEnd = now + extra
        uint256 rewardEva; // EVA added to the locked position
        uint256 rewardWbtc; // WBTC paid out instantly on accept
        uint256 offerExpiry;
        bool active;
    }

    /// @notice Read-only snapshot of a position, for UIs / portfolio indexers.
    struct PositionView {
        uint256 id;
        uint256 tierId;
        uint256 amount;
        uint256 shares;
        uint256 startTime;
        uint256 endTime; // unlock time
        uint256 pending; // claimable WBTC
        bool transferable;
    }

    // ---- constants ----

    /// @notice Fixed-point precision for the reward accumulator.
    uint256 public constant ACC_PRECISION = 1e27;
    /// @notice Fixed-point unit for curve fractions.
    uint256 public constant WAD = 1e18;
    /// @notice Granularity at which position expiry is recognized.
    uint256 public constant EPOCH = 1 days;
    /// @notice Basis-points denominator for the lock fee.
    uint16 public constant BPS = 10_000;
    /// @notice Hard cap on the lock fee (5%). The owner can never set a fee above this.
    uint16 public constant MAX_LOCK_FEE_BPS = 500;

    // ---- wiring ----

    /// @notice The locked (staked) token.
    IERC20 public immutable eva;
    /// @notice The reward / backing token.
    IERC20 public immutable wbtc;
    /// @notice Core burn vault used for early-exit redemption and fee burns.
    IEVABurnVault public immutable coreVault;
    /// @notice The RevenueRouter; only it may call distribute(), and it receives the lock-fee wBTC.
    address public distributor;

    // ---- tiers ----

    /// @notice Tier configuration, fixed at deployment (no tier can ever be added or reweighted).
    Tier[] public tiers;

    // ---- reward accounting (single weighted pool) ----

    /// @notice Global reward accumulator, scaled by ACC_PRECISION.
    uint256 public accRewardPerShare;
    /// @notice Sum of shares of all live (not yet expired/closed) positions.
    uint256 public totalShares;
    /// @notice WBTC banked while totalShares == 0; released into the next distribution.
    uint256 public undistributed;

    // ---- expiry bookkeeping ----

    /// @notice epoch => shares expiring in that epoch.
    mapping(uint256 => uint256) public expiringShares;
    /// @notice epoch => accRewardPerShare frozen when that epoch's shares were retired.
    mapping(uint256 => uint256) public epochAcc;
    /// @notice Last day-epoch already swept by _processExpiries.
    uint256 public lastProcessedEpoch;

    // ---- positions (id == ERC-721 tokenId) ----

    /// @notice Position state by id (id == ERC-721 tokenId).
    mapping(uint256 => Position) public positions;
    /// @notice Next position id to be minted.
    uint256 public nextPositionId;

    // ---- renewals ----

    /// @notice Pending renewal offer by position id.
    mapping(uint256 => RenewalOffer) public offers;

    // ---- liability tracking (for safe dust sweeps) ----

    /// @notice WBTC owed to lockers (claimable + banked); tracked from actual received amounts.
    uint256 public totalUnclaimedRewards;
    /// @notice EVA principal backing live positions.
    uint256 public lockedEvaTotal;
    /// @notice EVA escrowed for pending renewal offers.
    uint256 public evaEscrow;
    /// @notice WBTC escrowed for pending renewal offers.
    uint256 public wbtcEscrow;

    // ---- pause ----

    /// @notice Pauses NEW locks only; claim/withdraw/exit are never pausable.
    bool public locksPaused;

    // ---- lock fee & minimum ----

    /// @notice Fee on new locks (bps of amount); burned via the core vault, wBTC sent to distributor.
    uint16 public lockFeeBps;
    /// @notice Minimum EVA required to open a position (anti-spam / anti-dust).
    uint256 public minLockAmount;

    // ---- metadata ----

    string private _baseTokenURI; // off-chain metadata base; tokenURI = baseURI + tokenId

    /// @notice A new position was opened. `amount` is the net principal locked (post-fee).
    event Locked(
        uint256 indexed id, address indexed owner, uint256 indexed tierId, uint256 amount, uint256 shares, uint256 endTime
    );
    /// @notice Accrued WBTC rewards were paid out for a position.
    event Claimed(uint256 indexed id, address indexed owner, uint256 wbtcAmount);
    /// @notice A matured position was closed and its full principal returned.
    event Withdrawn(uint256 indexed id, address indexed owner, uint256 evaReturned);
    /// @notice A position exited before maturity: part returned liquid, part burned for backing.
    event EarlyExited(
        uint256 indexed id, address indexed owner, uint256 evaReturned, uint256 evaBurned, uint256 wbtcReceived
    );
    /// @notice WBTC revenue was distributed across all live shares.
    event Distributed(uint256 amount, uint256 perShareAdded);
    /// @notice The admin proposed new terms for a position, escrowing the prize.
    event RenewalProposed(
        uint256 indexed id, uint256 extraDuration, bool keepRemaining, uint256 rewardEva, uint256 rewardWbtc, uint256 offerExpiry
    );
    /// @notice A pending renewal offer was cancelled and its escrow refunded to the admin.
    event RenewalCancelled(uint256 indexed id);
    /// @notice The position owner accepted a renewal offer.
    event RenewalAccepted(
        uint256 indexed id, uint256 newEndTime, uint256 newAmount, uint256 newShares, uint256 wbtcPaid
    );
    /// @notice The early-exit curve for FUTURE locks in a tier was changed.
    event TierCurveUpdated(uint256 indexed tierId, Curve curve);
    /// @notice New locks in a tier were enabled/disabled.
    event TierEnabledUpdated(uint256 indexed tierId, bool enabled);
    /// @notice The authorized distributor (RevenueRouter) was changed.
    event DistributorUpdated(address distributor);
    /// @notice Opening of new locks was paused/unpaused.
    event LocksPausedUpdated(bool paused);
    /// @notice The off-chain metadata base URI was changed.
    event BaseURIUpdated(string uri);
    /// @notice The lock fee (bps) for future locks was changed.
    event LockFeeUpdated(uint16 bps);
    /// @notice The minimum lock amount for future locks was changed.
    event MinLockAmountUpdated(uint256 amount);
    /// @notice A lock fee was charged: EVA burned via the core vault, wBTC forwarded to the distributor.
    event LockFeeCharged(uint256 indexed id, uint256 evaBurned, uint256 wbtcToRouter);

    /**
     * @param _eva EVA token address.
     * @param _wbtc WBTC (backing/reward) token address.
     * @param _coreVault Core EVABurnVault used for early-exit redemption.
     * @param weights Per-tier share multipliers (immutable). 0 is allowed (project tier).
     * @param durations Per-tier lock durations in seconds (> 0).
     * @param curves Per-tier default early-exit curves.
     * @param transferables Per-tier transferability (false = soulbound).
     */
    constructor(
        address _eva,
        address _wbtc,
        address _coreVault,
        uint256[] memory weights,
        uint256[] memory durations,
        Curve[] memory curves,
        bool[] memory transferables
    ) ERC721("EVA Locked Position", "EVALOCK") Ownable(msg.sender) {
        require(_eva != address(0) && _wbtc != address(0) && _coreVault != address(0), "zero address");
        require(
            weights.length == durations.length &&
                weights.length == curves.length &&
                weights.length == transferables.length,
            "tier length mismatch"
        );
        require(weights.length > 0, "no tiers");

        eva = IERC20(_eva);
        wbtc = IERC20(_wbtc);
        coreVault = IEVABurnVault(_coreVault);

        for (uint256 i = 0; i < weights.length; i++) {
            require(durations[i] > 0, "duration zero");
            tiers.push(
                Tier({
                    weight: weights[i],
                    duration: durations[i],
                    defaultCurve: curves[i],
                    enabled: true,
                    transferable: transferables[i]
                })
            );
        }

        lastProcessedEpoch = _now() / EPOCH;
    }

    // =========================================================================
    //                              USER ACTIONS
    // =========================================================================

    /**
     * @notice Lock `amount` EVA into `tierId`, minting a position NFT. Requires prior EVA approval.
     * @param tierId Index into `tiers`; the tier must be enabled.
     * @param amount Gross EVA to pull from the caller (>= minLockAmount); any lock fee is skimmed
     *        from it and the net principal is locked.
     * @return id The new position id (tokenId).
     */
    function lock(uint256 tierId, uint256 amount) external nonReentrant returns (uint256 id) {
        require(!locksPaused, "locks paused");
        require(amount > 0, "amount zero");
        require(amount >= minLockAmount, "below min lock");
        Tier storage t = tiers[tierId];
        require(t.enabled, "tier disabled");

        _processExpiries();
        // A position must mature in a FUTURE epoch. Otherwise its shares land in an already-processed
        // expiry bucket that _processExpiries never revisits — stranding them in totalShares and bricking
        // the position. Always true for real (multi-day) tiers; guards against a misconfigured short tier.
        require((_now() + t.duration) / EPOCH > lastProcessedEpoch, "expiry in current epoch");

        eva.safeTransferFrom(msg.sender, address(this), amount);

        id = nextPositionId++;

        // Lock fee: skimmed from `amount`, burned against the core vault, and the resulting wBTC
        // forwarded to the distributor (RevenueRouter). Waived when it would redeem to 0 sats — the
        // vault rejects zero-payout burns, so charging it there would revert the whole lock.
        uint256 principal = amount;
        uint256 fee = (amount * lockFeeBps) / BPS;
        uint256 supply = eva.totalSupply();
        if (fee > 0 && distributor != address(0) && supply > 0) {
            uint256 out = (fee * wbtc.balanceOf(address(coreVault))) / supply;
            if (out > 0) {
                eva.forceApprove(address(coreVault), fee);
                uint256 balBefore = wbtc.balanceOf(address(this));
                coreVault.backingWithdraw(fee);
                uint256 received = wbtc.balanceOf(address(this)) - balBefore;
                if (received > 0) {
                    wbtc.safeTransfer(distributor, received);
                }
                principal = amount - fee;
                emit LockFeeCharged(id, fee, received);
            }
        }

        lockedEvaTotal += principal;

        uint256 shares = principal * t.weight;
        uint256 end = _now() + t.duration;
        uint256 eEpoch = end / EPOCH;

        positions[id] = Position({
            tierId: tierId,
            amount: principal,
            shares: shares,
            startTime: _now(),
            endTime: end,
            expiryEpoch: eEpoch,
            // Fresh debt rounds UP: a floored debt would let the position later claim the discarded
            // fraction (over-crediting the pool by up to 1 sat per lock). Ceiling guarantees
            // credited <= real entitlement; the sub-sat difference stays as sweep-safe dust.
            rewardDebt: Math.ceilDiv(shares * accRewardPerShare, ACC_PRECISION),
            curve: t.defaultCurve
        });

        if (shares > 0) {
            totalShares += shares;
            expiringShares[eEpoch] += shares;
        }

        _safeMint(msg.sender, id);
        emit Locked(id, msg.sender, tierId, principal, shares, end);
    }

    /// @notice Claim accrued WBTC rewards for a position without closing it.
    /// @param id The position id (caller must own it).
    function claim(uint256 id) external nonReentrant {
        _processExpiries();
        _claimOne(id);
    }

    /// @notice Claim rewards for several positions in one transaction (caller must own each).
    /// @param ids The position ids to claim for.
    function claimMany(uint256[] calldata ids) external nonReentrant {
        _processExpiries();
        for (uint256 i = 0; i < ids.length; i++) {
            _claimOne(ids[i]);
        }
    }

    /// @notice Claim rewards for every position the caller currently owns.
    /// @dev Gas scales with the caller's position count; use claimMany to claim in chunks if needed.
    function claimAll() external nonReentrant {
        _processExpiries();
        uint256 n = balanceOf(msg.sender);
        for (uint256 i = 0; i < n; i++) {
            _claimOne(tokenOfOwnerByIndex(msg.sender, i));
        }
    }

    /// @notice Withdraw a matured position: pay final rewards and return 100% of the locked EVA.
    /// @param id The position id (caller must own it; requires now >= endTime).
    function withdraw(uint256 id) external nonReentrant {
        require(ownerOf(id) == msg.sender, "not owner");
        _processExpiries();
        Position storage p = positions[id];
        require(_now() >= p.endTime, "not matured");

        if (offers[id].active) _refundOffer(id); // release any pending offer's escrow to the admin
        _settleTo(id, msg.sender);
        _removeShares(p);

        uint256 amount = p.amount;
        lockedEvaTotal -= amount;
        delete positions[id];
        _burn(id);

        eva.safeTransfer(msg.sender, amount);
        emit Withdrawn(id, msg.sender, amount);
    }

    /**
     * @notice Exit a position before maturity. Pays accrued rewards, returns `curve(f)` of the EVA as
     *         liquid tokens, and force-burns the remainder against the core vault, forwarding the backing.
     * @param id The position id (caller must own it; requires now < endTime).
     */
    function earlyExit(uint256 id) external nonReentrant {
        require(ownerOf(id) == msg.sender, "not owner");
        _processExpiries();
        Position storage p = positions[id];
        require(_now() < p.endTime, "matured; use withdraw");

        if (offers[id].active) _refundOffer(id); // release any pending offer's escrow to the admin
        _settleTo(id, msg.sender);

        uint256 elapsed = _now() - p.startTime;
        uint256 duration = p.endTime - p.startTime;
        uint256 keptFrac = _applyCurve(p.curve, elapsed, duration);

        uint256 amount = p.amount;
        uint256 keepEva = (amount * keptFrac) / WAD;
        uint256 burnEva = amount - keepEva;

        _removeShares(p);
        lockedEvaTotal -= amount;
        delete positions[id];
        _burn(id);

        // Mirror-and-waive (same rule as the lock fee): the core vault reverts on a zero-sat payout, so a
        // burn slice below S/B would brick the exit until maturity. Skip the vault and return that slice
        // as liquid EVA instead. The vault's backing ratio B/S is monotonically non-decreasing (its only
        // outflow burns EVA pro-rata), so this waiver is permanently confined to sub-satoshi value.
        if (burnEva > 0) {
            uint256 supply = eva.totalSupply();
            uint256 out = supply == 0 ? 0 : (burnEva * wbtc.balanceOf(address(coreVault))) / supply;
            if (out == 0) {
                keepEva += burnEva;
                burnEva = 0;
            }
        }

        if (keepEva > 0) {
            eva.safeTransfer(msg.sender, keepEva);
        }

        uint256 received;
        if (burnEva > 0) {
            eva.forceApprove(address(coreVault), burnEva);
            uint256 balBefore = wbtc.balanceOf(address(this));
            coreVault.backingWithdraw(burnEva);
            received = wbtc.balanceOf(address(this)) - balBefore;
            if (received > 0) {
                wbtc.safeTransfer(msg.sender, received);
            }
        }

        emit EarlyExited(id, msg.sender, keepEva, burnEva, received);
    }

    // =========================================================================
    //                              DISTRIBUTION
    // =========================================================================

    /**
     * @notice Distribute `amount` WBTC across all live shares. Pulled from the distributor (RevenueRouter).
     * @param amount WBTC to pull from the caller and credit to the pool.
     * @dev Retires expired shares first so matured positions receive nothing from this payment.
     */
    function distribute(uint256 amount) external nonReentrant {
        require(msg.sender == distributor, "not distributor");
        require(amount > 0, "amount zero");

        _processExpiries();
        wbtc.safeTransferFrom(msg.sender, address(this), amount);
        // Track liability from the actual amount received (drift-free). Since accRewardPerShare is
        // floored, total ever paid out <= total ever received, so this never underflows on settle and
        // is always >= the true sum of claimable rewards.
        totalUnclaimedRewards += amount;

        uint256 pool = amount + undistributed;
        if (totalShares == 0) {
            undistributed = pool; // banked WBTC stays counted in totalUnclaimedRewards
            return;
        }
        undistributed = 0;

        uint256 perShare = (pool * ACC_PRECISION) / totalShares;
        accRewardPerShare += perShare;

        emit Distributed(amount, perShare);
    }

    // =========================================================================
    //                                RENEWALS
    // =========================================================================

    /**
     * @notice Admin proposes new terms for a specific position, escrowing the prize up front.
     * @param id The position id the offer targets.
     * @param extraDuration Seconds to extend by (see `keepRemaining`).
     * @param keepRemaining true: newEnd = oldEnd + extra; false: newEnd = now + extra at acceptance.
     *        A renewal can only ever extend: with `false`, `extra` must be at least the time remaining on
     *        a live position (checked here and, bindingly, at acceptance). Matured positions may be
     *        reactivated with any future end.
     * @param rewardEva EVA prize compounded into the position on accept (escrowed now).
     * @param rewardWbtc WBTC prize paid instantly on accept (escrowed now).
     * @param offerExpiry Timestamp after which the offer can no longer be accepted.
     * @dev The position owner must accept. Either reward may be zero, but the offer must do something.
     */
    function proposeRenewal(
        uint256 id,
        uint256 extraDuration,
        bool keepRemaining,
        uint256 rewardEva,
        uint256 rewardWbtc,
        uint256 offerExpiry
    ) external onlyOwner nonReentrant {
        require(_ownerOf(id) != address(0), "no position");
        require(!offers[id].active, "offer exists");
        require(offerExpiry > _now(), "bad expiry");
        require(extraDuration > 0 || rewardEva > 0 || rewardWbtc > 0, "empty offer");
        // Early feedback for the admin: a "reset from now" offer that would shorten a live position can
        // never be accepted (acceptRenewal enforces newEnd >= endTime), so don't escrow a prize into it.
        // If this holds at proposal it holds at any later acceptance, so it never blocks a valid offer.
        if (!keepRemaining) {
            require(_now() + extraDuration >= positions[id].endTime, "must not shorten");
        }

        if (rewardEva > 0) {
            eva.safeTransferFrom(msg.sender, address(this), rewardEva);
            evaEscrow += rewardEva;
        }
        if (rewardWbtc > 0) {
            wbtc.safeTransferFrom(msg.sender, address(this), rewardWbtc);
            wbtcEscrow += rewardWbtc;
        }

        offers[id] = RenewalOffer({
            extraDuration: extraDuration,
            keepRemaining: keepRemaining,
            rewardEva: rewardEva,
            rewardWbtc: rewardWbtc,
            offerExpiry: offerExpiry,
            active: true
        });

        emit RenewalProposed(id, extraDuration, keepRemaining, rewardEva, rewardWbtc, offerExpiry);
    }

    /// @notice Admin cancels a pending offer and reclaims the escrow.
    /// @param id The position id whose offer to cancel.
    function cancelRenewal(uint256 id) external onlyOwner nonReentrant {
        require(offers[id].active, "no offer");
        _refundOffer(id);
        emit RenewalCancelled(id);
    }

    /**
     * @notice Position owner accepts a renewal: settles accrued rewards, extends the term, compounds any
     *         EVA prize into the position, pays any WBTC prize instantly, and restarts the early-exit clock.
     *         Can reactivate an already-matured position.
     * @param id The position id (caller must own it; a non-expired offer must exist).
     */
    function acceptRenewal(uint256 id) external nonReentrant {
        require(ownerOf(id) == msg.sender, "not owner");
        _processExpiries();
        RenewalOffer memory o = offers[id];
        require(o.active, "no offer");
        require(_now() <= o.offerExpiry, "offer expired");

        _settleTo(id, msg.sender);
        Position storage p = positions[id];
        _removeShares(p);

        uint256 newEnd = o.keepRemaining ? p.endTime + o.extraDuration : _now() + o.extraDuration;
        require(newEnd > _now(), "must extend future");
        // A renewal can only extend, never shorten (audit F-2026-19110). Without this, a "reset from now"
        // offer on a live position could bring its maturity forward and let it withdraw at 100% with no
        // early-exit burn — an admin+holder path to a better deal than any other locker can get, which
        // would also void the soulbound founder tier's commitment. Matured positions (endTime in the
        // past) always pass, so reactivation is unaffected.
        require(newEnd >= p.endTime, "must not shorten");
        // Must mature in a future epoch (same reason as in lock): a sub-day renewal ending in the
        // current, already-processed epoch would strand the position's shares and brick it.
        require(newEnd / EPOCH > lastProcessedEpoch, "renewal ends this epoch");

        if (o.rewardEva > 0) {
            evaEscrow -= o.rewardEva;
            p.amount += o.rewardEva; // EVA already held via escrow
            lockedEvaTotal += o.rewardEva;
        }

        uint256 newShares = p.amount * tiers[p.tierId].weight;
        uint256 newEpoch = newEnd / EPOCH;

        p.shares = newShares;
        p.startTime = _now(); // restart early-exit curve clock
        p.endTime = newEnd;
        p.expiryEpoch = newEpoch;
        // Fresh start at the current rate; rounds UP for the same solvency reason as in lock().
        p.rewardDebt = Math.ceilDiv(newShares * accRewardPerShare, ACC_PRECISION);

        if (newShares > 0) {
            totalShares += newShares;
            expiringShares[newEpoch] += newShares;
        }

        uint256 paidWbtc = o.rewardWbtc;
        delete offers[id];
        if (paidWbtc > 0) {
            wbtcEscrow -= paidWbtc;
            wbtc.safeTransfer(msg.sender, paidWbtc);
        }

        emit RenewalAccepted(id, newEnd, p.amount, newShares, paidWbtc);
    }

    // =========================================================================
    //                                 ADMIN
    // =========================================================================

    /// @notice Set the curve assigned to FUTURE locks in a tier (does not affect existing positions).
    function setTierCurve(uint256 tierId, Curve curve) external onlyOwner {
        tiers[tierId].defaultCurve = curve;
        emit TierCurveUpdated(tierId, curve);
    }

    /// @notice Enable/disable new locks in a tier.
    function setTierEnabled(uint256 tierId, bool enabled) external onlyOwner {
        tiers[tierId].enabled = enabled;
        emit TierEnabledUpdated(tierId, enabled);
    }

    /// @notice Set the authorized distributor (the RevenueRouter).
    function setDistributor(address _distributor) external onlyOwner {
        require(_distributor != address(0), "zero address");
        distributor = _distributor;
        emit DistributorUpdated(_distributor);
    }

    /// @notice Pause/unpause opening of new locks. Exits, claims and withdrawals stay open.
    function setLocksPaused(bool paused) external onlyOwner {
        locksPaused = paused;
        emit LocksPausedUpdated(paused);
    }

    /// @notice Set the fee (bps) charged on new locks; skimmed from the amount, burned via the core
    ///         vault, and the resulting wBTC forwarded to the distributor. Capped at MAX_LOCK_FEE_BPS.
    function setLockFee(uint16 bps) external onlyOwner {
        require(bps <= MAX_LOCK_FEE_BPS, "fee too high");
        lockFeeBps = bps;
        emit LockFeeUpdated(bps);
    }

    /// @notice Set the minimum EVA required to open a position (anti-spam / anti-dust).
    function setMinLockAmount(uint256 amount) external onlyOwner {
        minLockAmount = amount;
        emit MinLockAmountUpdated(amount);
    }

    /// @notice Set the base URI for off-chain token metadata (tokenURI = baseURI + tokenId).
    function setBaseURI(string calldata uri) external onlyOwner {
        _baseTokenURI = uri;
        emit BaseURIUpdated(uri);
    }

    /// @notice Sweep only stray WBTC (neither owed to lockers/banked, nor escrowed for offers).
    /// @param to Recipient of the swept surplus.
    /// @dev `totalUnclaimedRewards` already includes banked (undistributed) WBTC, so it is not added again.
    function sweepWbtc(address to) external onlyOwner {
        require(to != address(0), "zero address");
        uint256 reserved = totalUnclaimedRewards + wbtcEscrow;
        uint256 bal = wbtc.balanceOf(address(this));
        require(bal > reserved, "nothing to sweep");
        wbtc.safeTransfer(to, bal - reserved);
    }

    /// @notice Sweep only EVA that is neither locked nor escrowed (strays).
    /// @param to Recipient of the swept surplus.
    function sweepEva(address to) external onlyOwner {
        require(to != address(0), "zero address");
        uint256 reserved = lockedEvaTotal + evaEscrow;
        uint256 bal = eva.balanceOf(address(this));
        require(bal > reserved, "nothing to sweep");
        eva.safeTransfer(to, bal - reserved);
    }

    // =========================================================================
    //                                 VIEWS
    // =========================================================================

    /// @notice Claimable WBTC for a position right now.
    /// @param id The position id (returns 0 for burned/nonexistent positions).
    /// @return The WBTC amount a claim would pay at this moment.
    function pending(uint256 id) external view returns (uint256) {
        if (_ownerOf(id) == address(0)) return 0;
        Position storage p = positions[id];
        uint256 acc = _effectiveAcc(p);
        uint256 accumulated = (p.shares * acc) / ACC_PRECISION;
        return accumulated > p.rewardDebt ? accumulated - p.rewardDebt : 0;
    }

    /// @notice Number of configured tiers.
    function tierCount() external view returns (uint256) {
        return tiers.length;
    }

    /// @notice The position ids currently owned by `owner_`.
    /// @param owner_ The address to enumerate.
    /// @return ids The owned tokenIds, in enumeration order.
    function getPositionIds(address owner_) external view returns (uint256[] memory ids) {
        uint256 n = balanceOf(owner_);
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            ids[i] = tokenOfOwnerByIndex(owner_, i);
        }
    }

    /// @notice Full snapshot of every position `owner_` holds, in one call.
    /// @param owner_ The address to enumerate.
    /// @return list One PositionView per owned position.
    /// @dev Convenience aggregation for UIs and portfolio indexers (e.g. a DeBank "locked" adapter):
    ///      maps to supply (amount), unlock_at (endTime) and reward (pending) per position.
    function getPositionsOf(address owner_) external view returns (PositionView[] memory list) {
        uint256 n = balanceOf(owner_);
        list = new PositionView[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 id = tokenOfOwnerByIndex(owner_, i);
            Position storage p = positions[id];
            uint256 acc = _effectiveAcc(p);
            uint256 accumulated = (p.shares * acc) / ACC_PRECISION;
            list[i] = PositionView({
                id: id,
                tierId: p.tierId,
                amount: p.amount,
                shares: p.shares,
                startTime: p.startTime,
                endTime: p.endTime,
                pending: accumulated > p.rewardDebt ? accumulated - p.rewardDebt : 0,
                transferable: tiers[p.tierId].transferable
            });
        }
    }

    // =========================================================================
    //                          ERC-721 TRANSFER HOOK
    // =========================================================================

    /// @dev Guard the public transfer entrypoints; safeTransferFrom routes through transferFrom.
    function transferFrom(
        address from,
        address to,
        uint256 tokenId
    ) public override(ERC721, IERC721) nonReentrant {
        super.transferFrom(from, to, tokenId);
    }

    /// @dev Resolves the ERC721 / ERC721Enumerable diamond; no behavior added.
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    /**
     * @dev Single choke point for mint/transfer/burn. On a real transfer (not mint/burn) we enforce
     *      tier transferability, settle the seller's rewards, and cancel/refund any open renewal offer.
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override(ERC721, ERC721Enumerable) returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            require(tiers[positions[tokenId].tierId].transferable, "tier soulbound");
            _processExpiries();
            _settleTo(tokenId, from); // pay accrued rewards to the seller
            if (offers[tokenId].active) {
                _refundOffer(tokenId); // cancel + refund any open offer to the admin
            }
        }
        return super._update(to, tokenId, auth);
    }

    /// @dev Resolves the ERC721 / ERC721Enumerable diamond; no behavior added.
    function _increaseBalance(address account, uint128 value) internal override(ERC721, ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    /// @dev Off-chain metadata base; ERC721.tokenURI returns `_baseURI() + tokenId`.
    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    // =========================================================================
    //                                INTERNAL
    // =========================================================================

    /// @dev Claim one position's rewards to its owner (the caller). Reverts if the caller isn't the owner.
    function _claimOne(uint256 id) internal {
        require(ownerOf(id) == msg.sender, "not owner");
        uint256 owed = _settleTo(id, msg.sender);
        emit Claimed(id, msg.sender, owed);
    }

    /// @dev Settle a position's accrued rewards to `to`, updating its debt (CEI). Returns amount paid.
    ///      Saturating: a freshly-ceiled debt may briefly exceed the floored accumulated value within
    ///      the same integer window — that settles to 0, and the debt is left untouched.
    function _settleTo(uint256 id, address to) internal returns (uint256 owed) {
        Position storage p = positions[id];
        uint256 acc = _effectiveAcc(p);
        uint256 accumulated = (p.shares * acc) / ACC_PRECISION;
        if (accumulated > p.rewardDebt) {
            owed = accumulated - p.rewardDebt;
            p.rewardDebt = accumulated; // effect before interaction
            totalUnclaimedRewards -= owed; // effect
            wbtc.safeTransfer(to, owed); // interaction
        }
    }

    /// @dev Cancel an offer and return its escrow to the admin.
    function _refundOffer(uint256 id) internal {
        RenewalOffer memory o = offers[id];
        delete offers[id];
        if (o.rewardEva > 0) {
            evaEscrow -= o.rewardEva;
            eva.safeTransfer(owner(), o.rewardEva);
        }
        if (o.rewardWbtc > 0) {
            wbtcEscrow -= o.rewardWbtc;
            wbtc.safeTransfer(owner(), o.rewardWbtc);
        }
    }

    /// @dev Remove a live position's shares from the pool, unless they were already retired at expiry.
    function _removeShares(Position storage p) internal {
        if (p.shares == 0) return;
        if (p.expiryEpoch > lastProcessedEpoch) {
            totalShares -= p.shares;
            expiringShares[p.expiryEpoch] -= p.shares;
        }
        // else: already subtracted by _processExpiries as part of the epoch lump.
    }

    /// @dev Retire shares whose expiry epoch has passed, freezing the accumulator for each such epoch.
    function _processExpiries() internal {
        uint256 cur = _now() / EPOCH;
        uint256 e = lastProcessedEpoch;
        while (e < cur) {
            e++;
            uint256 sh = expiringShares[e];
            if (sh > 0) {
                epochAcc[e] = accRewardPerShare;
                totalShares -= sh;
            }
        }
        lastProcessedEpoch = cur;
    }

    /// @dev Current time source. Returns block.timestamp in production; overridden by demo builds
    ///      to allow fast-forwarding on testnets. Behavior-neutral here.
    function _now() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    /// @dev The accumulator value a position settles against: frozen if matured, live otherwise.
    function _effectiveAcc(Position storage p) internal view returns (uint256) {
        if (p.expiryEpoch <= lastProcessedEpoch) {
            return epochAcc[p.expiryEpoch];
        }
        return accRewardPerShare;
    }

    /// @dev Fraction (WAD) of a position returned as liquid EVA on early exit at elapsed/duration.
    function _applyCurve(Curve c, uint256 elapsed, uint256 duration) internal pure returns (uint256) {
        if (duration == 0) return WAD;
        uint256 f = (elapsed * WAD) / duration;
        if (f > WAD) f = WAD;
        if (c == Curve.LINEAR) {
            return f;
        } else if (c == Curve.QUADRATIC) {
            return (f * f) / WAD;
        } else {
            // SQRT: sqrt(f) in WAD fixed point.
            return Math.sqrt(f * WAD);
        }
    }
}
