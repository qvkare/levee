//! Levee repays a borrower's debt from a reserve when their health factor crosses a
//! trigger. This contract holds the caps, and is the only thing that can ask the MPC
//! network to sign for a position's rescuer address. See `docs/SPEC.md` sections 2 to 4.
//!
//! It builds every EVM transaction itself. A caller supplies a position, an amount
//! and fees, never calldata, a target or a payload. There is no admin, no owner of
//! the contract and no upgrade path.

pub mod address;
pub mod events;
pub mod evm;
pub mod mpc;
pub mod policy;
pub mod rlp;
pub mod txs;
pub mod types;

#[cfg(test)]
mod tests;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault, Promise};

use crate::address::normalise_address;
use crate::events::LeveeEvent;
use crate::policy::{utc_day, LOOSEN_DELAY_NANOS};
use crate::types::{ChainConfig, PendingLoosen, Position};

/// Bytes of `Some(PendingLoosen)` over `None`.
const PENDING_LOOSEN_BYTES: u64 = 44;
/// The longest a NEAR account id can be.
const MAX_ACCOUNT_ID_LEN: u64 = 64;
/// The smallest gas limit an EVM transaction can have.
const MIN_EVM_GAS_LIMIT: u64 = 21_000;

pub const ERR_NO_CHAINS: &str = "at least one chain is required";
pub const ERR_DUPLICATE_CHAIN: &str = "duplicate chain id";
pub const ERR_ZERO_FEE_CEILING: &str = "max_fee_per_gas_ceiling must be above zero";
pub const ERR_GAS_LIMIT_TOO_LOW: &str = "gas limits must be at least 21000";
pub const ERR_UNKNOWN_CHAIN: &str = "unknown chain id";
pub const ERR_ZERO_CAP: &str = "max_per_rescue and max_per_day must be above zero";
pub const ERR_DEPOSIT_TOO_LOW: &str = "attached deposit does not cover storage";
pub const ERR_NO_POSITION: &str = "position not found";
pub const ERR_NOT_OWNER: &str = "caller is not the owner";

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Levee {
    mpc_contract: AccountId,
    chains: LookupMap<u64, ChainConfig>,
    positions: LookupMap<u64, Position>,
    next_id: u64,
}

/// `levee/v1/{id}`. With this contract as predecessor and domain 0, it fixes the
/// rescuer address of a position.
fn derivation_path(id: u64) -> String {
    format!("levee/v1/{id}")
}

fn or_panic<T>(result: Result<T, &'static str>) -> T {
    result.unwrap_or_else(|err| env::panic_str(err))
}

fn validated_chain(chain: ChainConfig) -> ChainConfig {
    require!(chain.max_fee_per_gas_ceiling.0 > 0, ERR_ZERO_FEE_CEILING);
    require!(
        chain
            .gas_limit_approve
            .min(chain.gas_limit_repay)
            .min(chain.gas_limit_transfer)
            >= MIN_EVM_GAS_LIMIT,
        ERR_GAS_LIMIT_TOO_LOW
    );
    ChainConfig {
        pool: or_panic(normalise_address(&chain.pool)),
        usdc: or_panic(normalise_address(&chain.usdc)),
        ..chain
    }
}

#[near]
impl Levee {
    /// Stores the immutable configuration. Private, so that nobody can get in
    /// between deployment and this call and point the contract at their own signer.
    #[init]
    #[private]
    pub fn new(mpc_contract: AccountId, chains: Vec<ChainConfig>) -> Self {
        require!(!chains.is_empty(), ERR_NO_CHAINS);
        let mut stored = LookupMap::new(b"c");
        for chain in chains {
            let chain = validated_chain(chain);
            require!(!stored.contains_key(&chain.chain_id), ERR_DUPLICATE_CHAIN);
            stored.insert(chain.chain_id, chain);
        }
        Self {
            mpc_contract,
            chains: stored,
            positions: LookupMap::new(b"p"),
            next_id: 1,
        }
    }

    /// Creates a position owned by the caller. The deposit pays for the most storage
    /// the position can ever use, and the surplus is refunded.
    #[payable]
    pub fn register(
        &mut self,
        chain_id: u64,
        borrower: String,
        keeper: AccountId,
        max_per_rescue: U128,
        max_per_day: U128,
        cooldown_secs: u32,
    ) -> u64 {
        require!(self.chains.contains_key(&chain_id), ERR_UNKNOWN_CHAIN);
        let borrower = or_panic(normalise_address(&borrower));
        require!(max_per_rescue.0 > 0 && max_per_day.0 > 0, ERR_ZERO_CAP);

        let owner = env::predecessor_account_id();
        let id = self.next_id;
        self.next_id += 1;

        let usage_before = env::storage_usage();
        self.positions.insert(
            id,
            Position {
                owner: owner.clone(),
                keeper: keeper.clone(),
                chain_id,
                borrower: borrower.clone(),
                max_per_rescue,
                max_per_day,
                cooldown_secs,
                paused: false,
                spent_today: U128(0),
                day: utc_day(env::block_timestamp()),
                last_rescue_at: 0,
                pending_loosen: None,
            },
        );
        self.positions.flush();

        // `set_keeper` and `queue_loosen` take no deposit but can grow the record, so
        // the room they may need is charged now. The contract never pays for storage.
        let growth_room =
            PENDING_LOOSEN_BYTES + MAX_ACCOUNT_ID_LEN - keeper.as_str().len() as u64;
        let bytes = env::storage_usage() - usage_before + growth_room;
        let cost = env::storage_byte_cost().saturating_mul(u128::from(bytes));
        let surplus = env::attached_deposit()
            .checked_sub(cost)
            .unwrap_or_else(|| env::panic_str(ERR_DEPOSIT_TOO_LOW));
        if !surplus.is_zero() {
            Promise::new(owner.clone()).transfer(surplus).detach();
        }

        LeveeEvent::PositionRegistered {
            id,
            owner,
            keeper,
            chain_id,
            borrower,
            max_per_rescue,
            max_per_day,
            cooldown_secs,
            storage_paid: U128(cost.as_yoctonear()),
        }
        .emit();
        id
    }

    pub fn set_keeper(&mut self, id: u64, keeper: AccountId) {
        let position = self.owned_position_mut(id);
        let old_keeper = std::mem::replace(&mut position.keeper, keeper.clone());
        LeveeEvent::KeeperChanged {
            id,
            old_keeper,
            new_keeper: keeper,
        }
        .emit();
    }

    /// Takes effect at once. Also cancels a queued loosening, which would otherwise
    /// undo this in less than the delay.
    pub fn tighten(
        &mut self,
        id: u64,
        max_per_rescue: U128,
        max_per_day: U128,
        cooldown_secs: u32,
    ) {
        let position = self.owned_position_mut(id);
        or_panic(policy::check_tighten(
            position,
            max_per_rescue.0,
            max_per_day.0,
            cooldown_secs,
        ));
        position.max_per_rescue = max_per_rescue;
        position.max_per_day = max_per_day;
        position.cooldown_secs = cooldown_secs;
        let loosen_cancelled = position.pending_loosen.take().is_some();
        LeveeEvent::CapsTightened {
            id,
            max_per_rescue,
            max_per_day,
            cooldown_secs,
            loosen_cancelled,
        }
        .emit();
    }

    /// Replaces any queued loosening and restarts the delay.
    pub fn queue_loosen(
        &mut self,
        id: u64,
        max_per_rescue: U128,
        max_per_day: U128,
        cooldown_secs: u32,
    ) {
        let position = self.owned_position_mut(id);
        or_panic(policy::check_loosen(
            position,
            max_per_rescue.0,
            max_per_day.0,
            cooldown_secs,
        ));
        let ready_at = env::block_timestamp() + LOOSEN_DELAY_NANOS;
        position.pending_loosen = Some(PendingLoosen {
            max_per_rescue,
            max_per_day,
            cooldown_secs,
            ready_at,
        });
        LeveeEvent::CapsLoosenQueued {
            id,
            max_per_rescue,
            max_per_day,
            cooldown_secs,
            ready_at,
        }
        .emit();
    }

    pub fn apply_loosen(&mut self, id: u64) {
        let position = self.owned_position_mut(id);
        let pending = or_panic(policy::ready_loosen(position, env::block_timestamp())).clone();
        position.max_per_rescue = pending.max_per_rescue;
        position.max_per_day = pending.max_per_day;
        position.cooldown_secs = pending.cooldown_secs;
        position.pending_loosen = None;
        LeveeEvent::CapsLoosened {
            id,
            max_per_rescue: pending.max_per_rescue,
            max_per_day: pending.max_per_day,
            cooldown_secs: pending.cooldown_secs,
        }
        .emit();
    }

    pub fn pause(&mut self, id: u64) {
        self.owned_position_mut(id).paused = true;
        LeveeEvent::Paused { id }.emit();
    }

    pub fn resume(&mut self, id: u64) {
        self.owned_position_mut(id).paused = false;
        LeveeEvent::Resumed { id }.emit();
    }

    /// The position as of now: `spent_today` and `day` show the current UTC day, even
    /// if the stored bucket is from an earlier one.
    pub fn get_position(&self, id: u64) -> Option<Position> {
        let mut position = self.positions.get(&id)?.clone();
        let today = utc_day(env::block_timestamp());
        position.spent_today = U128(policy::spent_on(&position, today));
        position.day = today;
        Some(position)
    }

    pub fn rescuer_path(&self, id: u64) -> String {
        derivation_path(id)
    }

    pub fn get_chain(&self, chain_id: u64) -> Option<ChainConfig> {
        self.chains.get(&chain_id).cloned()
    }

    pub fn get_mpc_contract(&self) -> AccountId {
        self.mpc_contract.clone()
    }
}

impl Levee {
    fn owned_position_mut(&mut self, id: u64) -> &mut Position {
        let position = self
            .positions
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str(ERR_NO_POSITION));
        require!(env::predecessor_account_id() == position.owner, ERR_NOT_OWNER);
        position
    }
}
