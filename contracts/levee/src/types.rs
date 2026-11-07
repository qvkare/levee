//! Types shared by the contract, its callback and its callers.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

/// Immutable per-chain configuration, fixed at `new`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainConfig {
    pub chain_id: u64,
    /// Aave v3 Pool.
    pub pool: String,
    pub usdc: String,
    /// Wei.
    pub max_fee_per_gas_ceiling: U128,
    /// Wei.
    pub max_priority_fee_ceiling: U128,
    pub gas_limit_approve: u64,
    pub gas_limit_repay: u64,
    /// Also used by `sweep_gas`. On Arbitrum a gas limit has to cover L1 data
    /// cost, so a flat 21000 would not get a value transfer included.
    pub gas_limit_transfer: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Position {
    pub owner: AccountId,
    pub keeper: AccountId,
    pub chain_id: u64,
    /// EVM address whose debt is repaid. Lowercase, and never changes.
    pub borrower: String,
    /// USDC base units.
    pub max_per_rescue: U128,
    pub max_per_day: U128,
    pub cooldown_secs: u32,
    pub paused: bool,
    pub spent_today: U128,
    /// UTC day of `spent_today`, in days since the Unix epoch.
    pub day: u64,
    /// Nanoseconds.
    pub last_rescue_at: u64,
    /// A loosening waiting out its delay.
    pub pending_loosen: Option<PendingLoosen>,
}

/// Caps that take effect once `ready_at` has passed.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingLoosen {
    pub max_per_rescue: U128,
    pub max_per_day: U128,
    pub cooldown_secs: u32,
    /// Nanoseconds.
    pub ready_at: u64,
}

/// The only transaction parameters a caller controls.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fees {
    pub nonce: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
}

/// What a `rescue` holds while its signature is outstanding.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reservation {
    pub amount: U128,
    /// The UTC day the amount was charged to.
    pub day: u64,
    /// `last_rescue_at` set by this rescue.
    pub at: u64,
    /// `last_rescue_at` before this rescue.
    pub previous_at: u64,
}

/// `preview_rescue` output.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewTx {
    /// `0x`-prefixed `0x02 || rlp(fields)`.
    pub unsigned_tx: String,
    /// `0x`-prefixed keccak256 of `unsigned_tx`.
    pub tx_hash: String,
}
