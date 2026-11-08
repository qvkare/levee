//! NEP-297 events, standard `levee`, version `1.0.0`.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use crate::types::CollateralConfig;

/// Which transaction a signature belongs to. `unwind` is `rescue_from_collateral`'s:
/// it shares `rescue`'s budget, release and events.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SignKind {
    Rescue,
    Unwind,
    Allowance,
    WithdrawFloat,
    SweepGas,
}

/// What the callback returns and logs. It holds everything needed to assemble and
/// broadcast the signed transaction, so anyone can do that, not only the keeper.
/// All hex is `0x`-prefixed and lowercase.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedTx {
    pub kind: SignKind,
    pub id: u64,
    /// `0x02 || rlp(fields)`.
    pub unsigned_tx: String,
    /// The hash that was signed. The broadcast transaction has a different hash,
    /// because that one covers the signature too.
    pub tx_hash: String,
    /// Compressed point, 33 bytes. `r` is bytes 1..33.
    pub big_r: String,
    pub s: String,
    /// The EIP-1559 `y_parity`.
    pub recovery_id: u8,
}

/// Why no signature came back.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    /// The MPC call failed or timed out. Any reservation has been released.
    MpcFailed,
    /// The MPC call succeeded but its response could not be read. Any reservation
    /// stands, because a signature may exist.
    MalformedResponse,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignFailure {
    pub kind: SignKind,
    pub id: u64,
    pub tx_hash: String,
    pub reason: FailureReason,
    /// USDC base units returned to today's budget.
    pub released: U128,
}

#[near(event_json(standard = "levee"))]
pub enum LeveeEvent {
    #[event_version("1.0.0")]
    PositionRegistered {
        id: u64,
        owner: AccountId,
        keeper: AccountId,
        chain_id: u64,
        borrower: String,
        max_per_rescue: U128,
        max_per_day: U128,
        cooldown_secs: u32,
        /// What `rescue_from_collateral` may sell, if anything.
        collateral: Option<CollateralConfig>,
        /// Yoctonear kept for storage. The rest of the deposit was refunded.
        storage_paid: U128,
    },
    /// Logged by `rescue` and `rescue_from_collateral`. `kind` says which.
    #[event_version("1.0.0")]
    RescueRequested {
        id: u64,
        kind: SignKind,
        amount: U128,
        nonce: u64,
        tx_hash: String,
    },
    /// A `rescue` or `rescue_from_collateral` signature. `kind` says which.
    #[event_version("1.0.0")]
    RescueSigned(SignedTx),
    #[event_version("1.0.0")]
    RescueFailed(SignFailure),
    #[event_version("1.0.0")]
    AllowanceSigned(SignedTx),
    #[event_version("1.0.0")]
    FloatWithdrawn(SignedTx),
    #[event_version("1.0.0")]
    GasSwept(SignedTx),
    /// A signature failed for anything other than a rescue of either kind.
    #[event_version("1.0.0")]
    SignFailed(SignFailure),
    #[event_version("1.0.0")]
    CapsTightened {
        id: u64,
        max_per_rescue: U128,
        max_per_day: U128,
        cooldown_secs: u32,
        loosen_cancelled: bool,
    },
    #[event_version("1.0.0")]
    CapsLoosenQueued {
        id: u64,
        max_per_rescue: U128,
        max_per_day: U128,
        cooldown_secs: u32,
        ready_at: u64,
    },
    #[event_version("1.0.0")]
    CapsLoosened {
        id: u64,
        max_per_rescue: U128,
        max_per_day: U128,
        cooldown_secs: u32,
    },
    #[event_version("1.0.0")]
    KeeperChanged {
        id: u64,
        old_keeper: AccountId,
        new_keeper: AccountId,
    },
    #[event_version("1.0.0")]
    Paused { id: u64 },
    #[event_version("1.0.0")]
    Resumed { id: u64 },
}
