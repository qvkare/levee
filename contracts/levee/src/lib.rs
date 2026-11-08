//! Levee repays a borrower's debt when their health factor crosses a trigger, from a
//! reserve or by selling a slice of the borrower's own collateral. This contract holds
//! the caps, and is the only thing that can ask the MPC network to sign for a
//! position's rescuer address. See `docs/SPEC.md` sections 2 to 4 and 9.
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
use near_sdk::{env, near, require, AccountId, Gas, PanicOnDefault, Promise, PromiseError};

use crate::address::normalise_address;
use crate::events::{FailureReason, LeveeEvent, SignFailure, SignKind, SignedTx};
use crate::evm::{signing_hash, Eip1559Tx};
use crate::mpc::{
    ext_mpc, parse_signature, SignPayload, SignRequest, ECDSA_DOMAIN_ID, MAX_RESPONSE_BYTES,
    SIGN_DEPOSIT,
};
use crate::policy::{utc_day, LOOSEN_DELAY_NANOS};
use crate::types::{
    ChainConfig, CollateralConfig, Fees, PendingLoosen, Position, PreviewTx, Reservation,
};

/// Static gas for `sign`. See `docs/SPEC.md`, section "Gas".
pub const SIGN_GAS: Gas = Gas::from_tgas(20);
/// Static gas for `on_signed`.
pub const ON_SIGNED_GAS: Gas = Gas::from_tgas(10);
/// Least gas a signing method must be called with.
pub const MIN_SIGNING_GAS: Gas = Gas::from_tgas(35);

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
pub const ERR_NOT_KEEPER: &str = "caller is not the keeper";
pub const ERR_GAS_TOO_LOW: &str = "not enough gas attached to reach the signer";

/// What `on_signed` needs to know about the signature it is waiting for.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingSignature {
    pub kind: SignKind,
    pub id: u64,
    pub unsigned_tx: String,
    pub tx_hash: String,
    /// Set only for `rescue` and `rescue_from_collateral`, the two kinds that hold
    /// budget.
    pub reservation: Option<Reservation>,
}

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

fn hex_of(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn or_panic<T>(result: Result<T, &'static str>) -> T {
    result.unwrap_or_else(|err| env::panic_str(err))
}

fn pending_signature(
    kind: SignKind,
    id: u64,
    tx: &Eip1559Tx,
    reservation: Option<Reservation>,
) -> PendingSignature {
    let unsigned = tx.unsigned_bytes();
    PendingSignature {
        kind,
        id,
        tx_hash: hex_of(&signing_hash(&unsigned)),
        unsigned_tx: hex_of(&unsigned),
        reservation,
    }
}

fn check_signing_gas(prepaid: Gas) -> Result<(), &'static str> {
    if prepaid < MIN_SIGNING_GAS {
        return Err(ERR_GAS_TOO_LOW);
    }
    Ok(())
}

fn validated_chain(chain: ChainConfig) -> ChainConfig {
    require!(chain.max_fee_per_gas_ceiling.0 > 0, ERR_ZERO_FEE_CEILING);
    require!(
        chain
            .gas_limit_approve
            .min(chain.gas_limit_repay)
            .min(chain.gas_limit_transfer)
            .min(chain.gas_limit_unwind)
            >= MIN_EVM_GAS_LIMIT,
        ERR_GAS_LIMIT_TOO_LOW
    );
    ChainConfig {
        pool: or_panic(normalise_address(&chain.pool)),
        usdc: or_panic(normalise_address(&chain.usdc)),
        unwind: or_panic(normalise_address(&chain.unwind)),
        ..chain
    }
}

/// How a keeper's rescue is paid for. Both share one budget, one cooldown and one
/// set of events.
#[derive(Clone, Copy)]
enum Mode {
    /// `rescue`: `Pool.repay` from the rescuer's USDC.
    Reserve,
    /// `rescue_from_collateral`: `LeveeUnwind.unwind`, which sells the borrower's
    /// collateral to repay.
    Collateral,
}

impl Mode {
    fn kind(self) -> SignKind {
        match self {
            Mode::Reserve => SignKind::Rescue,
            Mode::Collateral => SignKind::Unwind,
        }
    }
}

/// Rules 2 to 6, plus the collateral config for an unwind, and the transaction to
/// sign. Rule 1 needs the caller, so the method checks it.
fn checked_rescue(
    mode: Mode,
    chain: &ChainConfig,
    position: &Position,
    amount: u128,
    fees: &Fees,
    now: u64,
) -> Result<(Reservation, Eip1559Tx), &'static str> {
    match mode {
        Mode::Reserve => {
            let reservation = policy::check_rescue(position, chain, amount, fees, now)?;
            Ok((reservation, txs::repay_tx(chain, position, amount, fees)))
        }
        Mode::Collateral => {
            let collateral = policy::collateral_of(position)?;
            let reservation = policy::check_rescue(position, chain, amount, fees, now)?;
            let tx = txs::unwind_tx(chain, position, collateral, amount, fees);
            Ok((reservation, tx))
        }
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
    ///
    /// `collateral` may be left out, and then `rescue_from_collateral` refuses the
    /// position. Like the borrower, it can never change.
    #[allow(clippy::too_many_arguments)]
    #[payable]
    pub fn register(
        &mut self,
        chain_id: u64,
        borrower: String,
        keeper: AccountId,
        max_per_rescue: U128,
        max_per_day: U128,
        cooldown_secs: u32,
        collateral: Option<CollateralConfig>,
    ) -> u64 {
        let chain = self
            .chains
            .get(&chain_id)
            .unwrap_or_else(|| env::panic_str(ERR_UNKNOWN_CHAIN));
        let borrower = or_panic(normalise_address(&borrower));
        let collateral =
            collateral.map(|config| or_panic(policy::validate_collateral(chain, config)));
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
                collateral: collateral.clone(),
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

        // The record is measured as stored, collateral config included, since that
        // never changes. `set_keeper` and `queue_loosen` take no deposit but can grow
        // the record, so the room they may need is charged now. The contract never
        // pays for storage.
        let growth_room = PENDING_LOOSEN_BYTES + MAX_ACCOUNT_ID_LEN - keeper.as_str().len() as u64;
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
            collateral,
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

    /// Signs `USDC.approve(Pool, amount)` from the rescuer. Owner only, so a stolen keeper
    /// key cannot burn rescuer gas on approvals. An amount of zero revokes the allowance.
    pub fn prepare_allowance(&mut self, id: u64, amount: U128, fees: Fees) -> Promise {
        let position = self.owned_position(id);
        require!(
            amount.0 <= policy::max_allowance(position),
            policy::ERR_OVER_MAX_ALLOWANCE
        );
        let chain = self.chain(position);
        or_panic(policy::check_fees(chain, &fees));
        let tx = txs::approve_tx(chain, amount.0, &fees);
        self.request_signature(pending_signature(SignKind::Allowance, id, &tx, None))
    }

    /// Signs `Pool.repay(USDC, amount, 2, borrower)` within the position's caps.
    pub fn rescue(&mut self, id: u64, amount: U128, fees: Fees) -> Promise {
        self.keeper_rescue(Mode::Reserve, id, amount, fees)
    }

    /// Signs `LeveeUnwind.unwind(borrower, collateral, amount, pool_fee)` within the
    /// position's caps. Same rules, budget and cooldown as `rescue`: `amount` is USDC
    /// base units, charged to the same `max_per_rescue` and `max_per_day`. Refused for
    /// a position registered without a collateral config.
    pub fn rescue_from_collateral(&mut self, id: u64, amount: U128, fees: Fees) -> Promise {
        self.keeper_rescue(Mode::Collateral, id, amount, fees)
    }

    /// Signs `USDC.transfer(borrower, amount)`. The destination is fixed.
    pub fn withdraw_float(&mut self, id: u64, amount: U128, fees: Fees) -> Promise {
        let position = self.owned_position(id);
        let chain = self.chain(position);
        or_panic(policy::check_fees(chain, &fees));
        let tx = txs::transfer_tx(chain, position, amount.0, &fees);
        self.request_signature(pending_signature(SignKind::WithdrawFloat, id, &tx, None))
    }

    /// Signs a value transfer to the borrower. The destination is fixed.
    pub fn sweep_gas(&mut self, id: u64, amount_wei: U128, fees: Fees) -> Promise {
        let position = self.owned_position(id);
        let chain = self.chain(position);
        or_panic(policy::check_fees(chain, &fees));
        let tx = txs::sweep_tx(chain, position, amount_wei.0, &fees);
        self.request_signature(pending_signature(SignKind::SweepGas, id, &tx, None))
    }

    /// Receives the MPC result, and returns everything needed to broadcast, or `null`
    /// if there is no signature. A failure has to return normally: a panic here would
    /// roll back the release.
    #[private]
    pub fn on_signed(&mut self, pending: PendingSignature) -> Option<SignedTx> {
        let response = env::promise_result_checked(0, MAX_RESPONSE_BYTES);
        let signature = response.as_deref().ok().and_then(parse_signature);
        if let Some(signature) = signature {
            let signed = SignedTx {
                kind: pending.kind,
                id: pending.id,
                unsigned_tx: pending.unsigned_tx,
                tx_hash: pending.tx_hash,
                big_r: signature.big_r,
                s: signature.s,
                recovery_id: signature.recovery_id,
            };
            let event = match signed.kind {
                SignKind::Rescue | SignKind::Unwind => LeveeEvent::RescueSigned(signed.clone()),
                SignKind::Allowance => LeveeEvent::AllowanceSigned(signed.clone()),
                SignKind::WithdrawFloat => LeveeEvent::FloatWithdrawn(signed.clone()),
                SignKind::SweepGas => LeveeEvent::GasSwept(signed.clone()),
            };
            event.emit();
            return Some(signed);
        }

        // Only a failed call proves nothing was signed. If the call succeeded but the
        // response is unreadable, a signature may exist, so its budget stays charged.
        let (reason, released) = match response {
            Err(PromiseError::Failed) => (FailureReason::MpcFailed, self.release(&pending)),
            _ => (FailureReason::MalformedResponse, 0),
        };
        let failure = SignFailure {
            kind: pending.kind,
            id: pending.id,
            tx_hash: pending.tx_hash,
            reason,
            released: U128(released),
        };
        match failure.kind {
            SignKind::Rescue | SignKind::Unwind => LeveeEvent::RescueFailed(failure).emit(),
            _ => LeveeEvent::SignFailed(failure).emit(),
        }
        None
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

    /// The transaction `rescue` would sign now, failing with the same error it would.
    /// A view has no caller, so rule 1 is the one rule this cannot check.
    pub fn preview_rescue(&self, id: u64, amount: U128, fees: Fees) -> PreviewTx {
        self.preview(Mode::Reserve, id, amount, fees)
    }

    /// The transaction `rescue_from_collateral` would sign now, failing with the same
    /// error it would, except for rule 1.
    pub fn preview_rescue_from_collateral(&self, id: u64, amount: U128, fees: Fees) -> PreviewTx {
        self.preview(Mode::Collateral, id, amount, fees)
    }

    pub fn get_chain(&self, chain_id: u64) -> Option<ChainConfig> {
        self.chains.get(&chain_id).cloned()
    }

    pub fn get_mpc_contract(&self) -> AccountId {
        self.mpc_contract.clone()
    }
}

impl Levee {
    fn position(&self, id: u64) -> &Position {
        self.positions
            .get(&id)
            .unwrap_or_else(|| env::panic_str(ERR_NO_POSITION))
    }

    fn owned_position(&self, id: u64) -> &Position {
        let position = self.position(id);
        require!(
            env::predecessor_account_id() == position.owner,
            ERR_NOT_OWNER
        );
        position
    }

    fn owned_position_mut(&mut self, id: u64) -> &mut Position {
        let position = self
            .positions
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str(ERR_NO_POSITION));
        require!(
            env::predecessor_account_id() == position.owner,
            ERR_NOT_OWNER
        );
        position
    }

    /// A chain is checked at `register` and chains never change, so this always finds it.
    fn chain(&self, position: &Position) -> &ChainConfig {
        self.chains
            .get(&position.chain_id)
            .unwrap_or_else(|| env::panic_str(ERR_UNKNOWN_CHAIN))
    }

    /// `rescue` and `rescue_from_collateral`: rule 1, then the rest, then the budget
    /// and cooldown are reserved before the signer is asked.
    fn keeper_rescue(&mut self, mode: Mode, id: u64, amount: U128, fees: Fees) -> Promise {
        let position = self.position(id);
        require!(
            env::predecessor_account_id() == position.keeper,
            ERR_NOT_KEEPER
        );
        let chain = self.chain(position);
        let (reservation, tx) = or_panic(checked_rescue(
            mode,
            chain,
            position,
            amount.0,
            &fees,
            env::block_timestamp(),
        ));
        let kind = mode.kind();
        let pending = pending_signature(kind, id, &tx, Some(reservation.clone()));

        let position = self
            .positions
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str(ERR_NO_POSITION));
        policy::reserve(position, &reservation);
        LeveeEvent::RescueRequested {
            id,
            kind,
            amount,
            nonce: fees.nonce,
            tx_hash: pending.tx_hash.clone(),
        }
        .emit();
        self.request_signature(pending)
    }

    fn preview(&self, mode: Mode, id: u64, amount: U128, fees: Fees) -> PreviewTx {
        let position = self.position(id);
        let chain = self.chain(position);
        let (_, tx) = or_panic(checked_rescue(
            mode,
            chain,
            position,
            amount.0,
            &fees,
            env::block_timestamp(),
        ));
        let unsigned = tx.unsigned_bytes();
        PreviewTx {
            tx_hash: hex_of(&signing_hash(&unsigned)),
            unsigned_tx: hex_of(&unsigned),
        }
    }

    /// Asks the MPC contract to sign from the position's rescuer. Nothing a caller
    /// supplied reaches it directly: the payload is the hash of a transaction this
    /// contract built.
    fn request_signature(&self, pending: PendingSignature) -> Promise {
        or_panic(check_signing_gas(env::prepaid_gas()));
        let request = SignRequest {
            path: derivation_path(pending.id),
            domain_id: ECDSA_DOMAIN_ID,
            payload_v2: SignPayload::Ecdsa(pending.tx_hash[2..].to_string()),
        };
        // `sign` takes the unused gas: the signer's requirement is its own config, and
        // this contract can never be upgraded, so a future rise has to be meetable by
        // attaching more. The callback's share is fixed, so `sign` cannot take it.
        ext_mpc::ext(self.mpc_contract.clone())
            .with_attached_deposit(SIGN_DEPOSIT)
            .with_static_gas(SIGN_GAS)
            .with_unused_gas_weight(1)
            .sign(request)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_SIGNED_GAS)
                    .with_unused_gas_weight(0)
                    .on_signed(pending),
            )
    }

    fn release(&mut self, pending: &PendingSignature) -> u128 {
        let reservation = pending.reservation.as_ref();
        let position = self.positions.get_mut(&pending.id);
        match (position, reservation) {
            (Some(position), Some(reservation)) => policy::release(position, reservation),
            _ => 0,
        }
    }
}
