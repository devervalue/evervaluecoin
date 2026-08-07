// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Read-only view into EVALocker used to validate listings.
interface IEVALockerView {
    function positions(uint256 id)
        external
        view
        returns (
            uint256 tierId,
            uint256 amount,
            uint256 shares,
            uint256 startTime,
            uint256 endTime,
            uint256 expiryEpoch,
            uint256 rewardDebt,
            uint8 curve
        );

    function tiers(uint256 tierId)
        external
        view
        returns (uint256 weight, uint256 duration, uint8 defaultCurve, bool enabled, bool transferable);
}

/**
 * @title PositionMarket
 * @notice Minimal fixed-price marketplace for EVALocker position NFTs, settled in WBTC.
 * @dev Approval-based (no escrow): sellers keep their position — and keep earning its rewards — until it
 *      sells, having granted this contract an ERC-721 approval. A buy atomically pays the seller in WBTC
 *      and transfers the NFT; the locker's transfer hook settles the position's accrued rewards to the
 *      seller at that moment.
 *
 *      Active listings are tracked in an on-chain array so a client can fetch the whole order book in a
 *      single view call — no events/indexer required. To keep that array un-floodable, a position must
 *      hold at least `minListAmount` EVA to be listed: spamming the book then costs real locked capital.
 */
contract PositionMarket is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice A fixed-price sale offer; the NFT stays with the seller until it sells.
    struct Listing {
        address seller;
        uint256 price; // WBTC (8 decimals)
        uint256 startSnapshot; // position.startTime at list time; changes only on renewal
    }

    /// @notice The EVALocker, as the position NFT collection.
    IERC721 public immutable positionNft;
    /// @notice The EVALocker again, as the view interface used to validate listings.
    IEVALockerView public immutable locker;
    /// @notice The settlement token.
    IERC20 public immutable wbtc;

    /// @notice Minimum EVA a position must hold to be listed (anti-spam floor).
    uint256 public minListAmount;

    /// @notice tokenId => listing (seller == address(0) means not listed).
    mapping(uint256 => Listing) public listings;

    /// @dev Enumerable set of listed tokenIds for single-call order-book reads.
    uint256[] private activeListings;
    /// @dev tokenId => (index in activeListings) + 1; 0 means not listed.
    mapping(uint256 => uint256) private listingIndex;

    /// @notice A position was listed (or re-listed) at a fixed WBTC price.
    event Listed(uint256 indexed id, address indexed seller, uint256 price);
    /// @notice A listing's price was changed by its seller.
    event PriceUpdated(uint256 indexed id, uint256 price);
    /// @notice A listing was removed (by the seller, or pruned as stale).
    event Cancelled(uint256 indexed id);
    /// @notice A listed position was bought: WBTC to the seller, NFT to the buyer, atomically.
    event Sold(uint256 indexed id, address indexed seller, address indexed buyer, uint256 price);
    /// @notice The minimum listable position size was changed.
    event MinListAmountUpdated(uint256 amount);

    /**
     * @param _locker EVALocker address (both the position NFT and its view interface).
     * @param _wbtc WBTC settlement token address.
     * @param _minListAmount Minimum EVA a position must hold to be listed.
     */
    constructor(address _locker, address _wbtc, uint256 _minListAmount) Ownable(msg.sender) {
        require(_locker != address(0) && _wbtc != address(0), "zero address");
        positionNft = IERC721(_locker);
        locker = IEVALockerView(_locker);
        wbtc = IERC20(_wbtc);
        minListAmount = _minListAmount;
    }

    // =========================================================================
    //                              SELLER ACTIONS
    // =========================================================================

    /**
     * @notice List a position for sale at a fixed WBTC price (or re-list / update an existing one).
     * @param id The position tokenId (caller must own it).
     * @param price Asking price in WBTC (8 decimals), > 0.
     * @dev The position must hold at least `minListAmount` EVA and be in a transferable tier. The seller
     *      must also approve this contract on the EVALocker NFT (setApprovalForAll or approve) before a buy
     *      can succeed. The current owner may always (re)list — overwriting any stale entry left by a prior
     *      owner — so no one can be locked out of selling a position they own.
     */
    function list(uint256 id, uint256 price) external {
        // No nonReentrant guard: list only makes view calls to the trusted locker
        // (ownerOf/positions/tiers) and no transfers/callbacks, so there is no re-entrancy vector.
        require(positionNft.ownerOf(id) == msg.sender, "not owner");
        require(price > 0, "price is zero");

        (uint256 tierId, uint256 amount, , uint256 startTime, , , , ) = locker.positions(id);
        require(amount >= minListAmount, "position below min size");
        (, , , , bool transferable) = locker.tiers(tierId);
        require(transferable, "tier soulbound");

        listings[id] = Listing({seller: msg.sender, price: price, startSnapshot: startTime});
        if (listingIndex[id] == 0) {
            activeListings.push(id);
            listingIndex[id] = activeListings.length; // index + 1
        }

        emit Listed(id, msg.sender, price);
    }

    /// @notice Update the price of an existing listing.
    /// @param id The listed tokenId (caller must be its seller).
    /// @param newPrice New asking price in WBTC, > 0.
    function updatePrice(uint256 id, uint256 newPrice) external {
        require(listings[id].seller == msg.sender, "not seller");
        require(newPrice > 0, "price is zero");
        listings[id].price = newPrice;
        emit PriceUpdated(id, newPrice);
    }

    /// @notice Remove a listing.
    /// @param id The listed tokenId (caller must be its seller).
    function cancel(uint256 id) external {
        require(listings[id].seller == msg.sender, "not seller");
        _removeListing(id);
        emit Cancelled(id);
    }

    /**
     * @notice Permissionless cleanup: remove a listing that can no longer be fulfilled (the seller
     *         transferred or burned the position, or it was renewed since listing). Lets a keeper / the UI
     *         keep the on-chain order book free of dead entries.
     * @param id The listed tokenId to prune; must currently be unfulfillable.
     */
    function pruneStale(uint256 id) external {
        require(listingIndex[id] != 0, "not listed");
        require(!isFulfillable(id), "listing still valid");
        _removeListing(id);
        emit Cancelled(id);
    }

    // =========================================================================
    //                                BUYER ACTION
    // =========================================================================

    /**
     * @notice Buy a listed position. Pays the seller in WBTC and receives the position NFT atomically.
     * @param id The listed tokenId to buy; must be fulfillable (see isFulfillable).
     * @dev Requires the buyer to have approved this contract for `price` WBTC, and the seller to have
     *      approved this contract on the NFT. The NFT transfer settles the position's accrued rewards to
     *      the seller via the locker's transfer hook.
     */
    function buy(uint256 id) external nonReentrant {
        // Single source of truth: listed + seller still owns + market approved + not renewed.
        // The locker's transferFrom is the final backstop on ownership/approval.
        require(isFulfillable(id), "not buyable");

        Listing memory l = listings[id];
        address seller = l.seller;
        uint256 price = l.price;

        _removeListing(id); // effects before interactions

        wbtc.safeTransferFrom(msg.sender, seller, price); // buyer pays seller
        positionNft.transferFrom(seller, msg.sender, id); // deliver NFT (settles rewards to seller)

        emit Sold(id, seller, msg.sender, price);
    }

    // =========================================================================
    //                                  ADMIN
    // =========================================================================

    /// @notice Update the minimum position size required to list.
    /// @param amount New minimum locked-EVA size for future listings.
    function setMinListAmount(uint256 amount) external onlyOwner {
        minListAmount = amount;
        emit MinListAmountUpdated(amount);
    }

    // =========================================================================
    //                                  VIEWS
    // =========================================================================

    /// @notice Number of active listings (includes any not-yet-pruned stale entries).
    /// @return The length of the on-chain order book array.
    function activeListingCount() external view returns (uint256) {
        return activeListings.length;
    }

    /// @notice The full order book in one call: ids, sellers, prices, and a per-entry validity flag.
    /// @dev `valid[i]` mirrors isFulfillable(ids[i]); clients should display only entries where it's true.
    function getActiveListingsDetailed()
        external
        view
        returns (uint256[] memory ids, address[] memory sellers, uint256[] memory prices, bool[] memory valid)
    {
        uint256 n = activeListings.length;
        ids = new uint256[](n);
        sellers = new address[](n);
        prices = new uint256[](n);
        valid = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 id = activeListings[i];
            ids[i] = id;
            sellers[i] = listings[id].seller;
            prices[i] = listings[id].price;
            valid[i] = isFulfillable(id);
        }
    }

    /**
     * @notice True if listing `id` can currently be bought, i.e. all of:
     *         it's listed; the seller still owns the position; this market is still approved to move it;
     *         and the position has not been renewed since it was listed.
     * @param id The tokenId to check.
     * @return Whether a buy(id) would currently succeed.
     * @dev Primitive for clients (to show only buyable listings) and keepers (to decide what to prune).
     */
    function isFulfillable(uint256 id) public view returns (bool) {
        Listing memory l = listings[id];
        if (l.seller == address(0)) return false;

        address currentOwner;
        try positionNft.ownerOf(id) returns (address o) {
            currentOwner = o;
        } catch {
            return false; // position burned (withdrawn / early-exited)
        }
        if (currentOwner != l.seller) return false; // transferred away

        // the seller must still have this market approved to move the NFT
        if (
            !positionNft.isApprovedForAll(l.seller, address(this)) &&
            positionNft.getApproved(id) != address(this)
        ) {
            return false; // approval revoked
        }

        (, , , uint256 startTime, , , , ) = locker.positions(id);
        return startTime == l.startSnapshot; // false if renewed since listing
    }

    // =========================================================================
    //                                INTERNAL
    // =========================================================================

    /// @dev O(1) removal from the active set via swap-and-pop, and clears the listing.
    function _removeListing(uint256 id) internal {
        // Only ever called by cancel()/buy(), both of which require the listing exists first,
        // so listingIndex[id] is always non-zero here.
        uint256 idx = listingIndex[id] - 1;
        uint256 lastIdx = activeListings.length - 1;
        if (idx != lastIdx) {
            uint256 lastId = activeListings[lastIdx];
            activeListings[idx] = lastId;
            listingIndex[lastId] = idx + 1;
        }
        activeListings.pop();
        delete listingIndex[id];
        delete listings[id];
    }
}
