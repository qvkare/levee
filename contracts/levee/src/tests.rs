//! Contract-level unit tests. The rules themselves are tested on their boundaries in
//! `policy.rs`. These tests prove the methods are wired to those rules, and check what
//! actually leaves the contract: receipts, gas, deposits, logs and return values.

use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, NearToken, PromiseResult, RuntimeFeesConfig};

use super::*;
use crate::policy::{
    ERR_COOLDOWN, ERR_LOOSEN_NOT_READY, ERR_MAX_FEE_CEILING, ERR_NO_PENDING_LOOSEN,
    ERR_OVER_DAILY_BUDGET, ERR_OVER_MAX_ALLOWANCE, ERR_OVER_MAX_PER_RESCUE, ERR_PAUSED,
    ERR_PRIORITY_FEE_CEILING, ERR_PRIORITY_OVER_MAX_FEE, ERR_TIGHTEN_COOLDOWN,
    ERR_TIGHTEN_MAX_PER_DAY, ERR_TIGHTEN_MAX_PER_RESCUE, ERR_ZERO_AMOUNT, NANOS_PER_DAY,
    NANOS_PER_SEC,
};

const CONTRACT: &str = "levee.near";
const SIGNER: &str = "signer.near";
const OWNER: &str = "owner.near";
const KEEPER: &str = "keeper.near";
const STRANGER: &str = "stranger.near";
const BORROWER: &str = "0x1234567890abcdef1234567890abcdef12345678";
const BASE_POOL: &str = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
const BASE_USDC: &str = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const MAX_PER_RESCUE: u128 = 100;
const MAX_PER_DAY: u128 = 250;
const COOLDOWN_SECS: u32 = 60;
const MAX_FEE_CEILING: u128 = 1_000;
const PRIORITY_CEILING: u128 = 100;

/// 2026-11-07 12:00:00 UTC.
const NOON: u64 = 1_794_052_800 * NANOS_PER_SEC;
const HOUR: u64 = 3_600 * NANOS_PER_SEC;

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn context(caller: &str, now: u64) -> VMContextBuilder {
    let mut context = VMContextBuilder::new();
    context
        .current_account_id(account(CONTRACT))
        .signer_account_id(account(caller))
        .predecessor_account_id(account(caller))
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(300));
    context
}

fn act_as(caller: &str, now: u64) {
    testing_env!(context(caller, now).build());
}

fn base() -> ChainConfig {
    ChainConfig {
        chain_id: 8453,
        pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5".into(),
        usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".into(),
        max_fee_per_gas_ceiling: U128(MAX_FEE_CEILING),
        max_priority_fee_ceiling: U128(PRIORITY_CEILING),
        gas_limit_approve: 70_000,
        gas_limit_repay: 350_000,
        gas_limit_transfer: 80_000,
    }
}

fn arbitrum() -> ChainConfig {
    ChainConfig {
        chain_id: 42161,
        pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD".into(),
        usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831".into(),
        ..base()
    }
}

fn new_contract() -> Levee {
    act_as(CONTRACT, NOON);
    Levee::new(account(SIGNER), vec![base(), arbitrum()])
}

fn register(contract: &mut Levee, keeper: &str) -> u64 {
    testing_env!(context(OWNER, NOON)
        .attached_deposit(NearToken::from_near(1))
        .build());
    contract.register(
        8453,
        BORROWER.into(),
        account(keeper),
        U128(MAX_PER_RESCUE),
        U128(MAX_PER_DAY),
        COOLDOWN_SECS,
    )
}

fn setup() -> (Levee, u64) {
    let mut contract = new_contract();
    let id = register(&mut contract, KEEPER);
    (contract, id)
}

fn fees() -> Fees {
    Fees {
        nonce: 7,
        max_fee_per_gas: U128(MAX_FEE_CEILING),
        max_priority_fee_per_gas: U128(PRIORITY_CEILING),
    }
}

fn spent(contract: &Levee, id: u64) -> u128 {
    contract.get_position(id).unwrap().spent_today.0
}

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| serde_json::from_str(json).unwrap())
        .collect()
}

fn last_event() -> Value {
    events().pop().expect("no event was logged")
}

struct Call {
    receiver: AccountId,
    method: String,
    args: Value,
    deposit: NearToken,
    gas: Gas,
    weight: u64,
}

/// The function calls the contract just scheduled, in order.
fn calls() -> Vec<Call> {
    get_created_receipts()
        .into_iter()
        .flat_map(|receipt| {
            let receiver = receipt.receiver_id.clone();
            receipt
                .actions
                .into_iter()
                .filter_map(move |action| match action {
                    MockAction::FunctionCallWeight {
                        method_name,
                        args,
                        attached_deposit,
                        prepaid_gas,
                        gas_weight,
                        ..
                    } => Some(Call {
                        receiver: receiver.clone(),
                        method: String::from_utf8(method_name).unwrap(),
                        args: serde_json::from_slice(&args).unwrap(),
                        deposit: attached_deposit,
                        gas: prepaid_gas,
                        weight: gas_weight.0,
                    }),
                    _ => None,
                })
        })
        .collect()
}

fn transfers() -> Vec<(AccountId, NearToken)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|receipt| {
            let receiver = receipt.receiver_id.clone();
            receipt
                .actions
                .into_iter()
                .filter_map(move |action| match action {
                    MockAction::Transfer { deposit, .. } => Some((receiver.clone(), deposit)),
                    _ => None,
                })
        })
        .collect()
}

/// The `PendingSignature` the last signing call handed to the callback.
fn pending() -> PendingSignature {
    let calls = calls();
    let callback = calls
        .iter()
        .find(|call| call.method == "on_signed")
        .expect("no on_signed call");
    serde_json::from_value(callback.args["pending"].clone()).unwrap()
}

fn real_signature() -> Vec<u8> {
    let fixture: Value =
        serde_json::from_str(include_str!("../fixtures/mpc_sign_response.json")).unwrap();
    serde_json::to_vec(&fixture["response"]).unwrap()
}

/// Delivers `result` to `on_signed` at time `now`.
fn deliver(
    contract: &mut Levee,
    pending: PendingSignature,
    result: PromiseResult,
    now: u64,
) -> Option<SignedTx> {
    testing_env!(
        context(CONTRACT, now).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    contract.on_signed(pending)
}

fn rescue(contract: &mut Levee, id: u64, amount: u128, now: u64) -> PendingSignature {
    act_as(KEEPER, now);
    let _ = contract.rescue(id, U128(amount), fees());
    pending()
}

mod init {
    use super::*;

    #[test]
    fn stores_the_signer_and_normalised_chains() {
        let contract = new_contract();
        assert_eq!(contract.get_mpc_contract(), account(SIGNER));
        let chain = contract.get_chain(8453).unwrap();
        assert_eq!(chain.pool, BASE_POOL);
        assert_eq!(chain.usdc, BASE_USDC);
        assert!(contract.get_chain(42161).is_some());
        assert!(contract.get_chain(1).is_none());
    }

    #[test]
    #[should_panic(expected = "duplicate chain id")]
    fn rejects_a_duplicate_chain_id() {
        act_as(CONTRACT, NOON);
        Levee::new(account(SIGNER), vec![base(), arbitrum(), base()]);
    }

    #[test]
    #[should_panic(expected = "at least one chain is required")]
    fn rejects_an_empty_chain_list() {
        act_as(CONTRACT, NOON);
        Levee::new(account(SIGNER), vec![]);
    }

    #[test]
    #[should_panic(expected = "address must be 0x followed by 40 hex characters")]
    fn rejects_a_malformed_pool() {
        act_as(CONTRACT, NOON);
        let chain = ChainConfig {
            pool: "0x1234".into(),
            ..base()
        };
        Levee::new(account(SIGNER), vec![chain]);
    }

    #[test]
    #[should_panic(expected = "the zero address is not allowed")]
    fn rejects_a_zero_usdc() {
        act_as(CONTRACT, NOON);
        let chain = ChainConfig {
            usdc: format!("0x{}", "0".repeat(40)),
            ..base()
        };
        Levee::new(account(SIGNER), vec![chain]);
    }

    #[test]
    #[should_panic(expected = "max_fee_per_gas_ceiling must be above zero")]
    fn rejects_a_zero_fee_ceiling() {
        act_as(CONTRACT, NOON);
        let chain = ChainConfig {
            max_fee_per_gas_ceiling: U128(0),
            ..base()
        };
        Levee::new(account(SIGNER), vec![chain]);
    }

    #[test]
    #[should_panic(expected = "gas limits must be at least 21000")]
    fn rejects_a_gas_limit_below_the_intrinsic_cost() {
        act_as(CONTRACT, NOON);
        let chain = ChainConfig {
            gas_limit_transfer: 20_999,
            ..base()
        };
        Levee::new(account(SIGNER), vec![chain]);
    }

    #[test]
    fn accepts_a_gas_limit_at_the_intrinsic_cost() {
        act_as(CONTRACT, NOON);
        let chain = ChainConfig {
            gas_limit_transfer: 21_000,
            ..base()
        };
        Levee::new(account(SIGNER), vec![chain]);
    }
}

mod registration {
    use super::*;

    fn register_with(contract: &mut Levee, deposit: NearToken) -> u64 {
        testing_env!(context(OWNER, NOON).attached_deposit(deposit).build());
        contract.register(
            8453,
            BORROWER.into(),
            account(KEEPER),
            U128(MAX_PER_RESCUE),
            U128(MAX_PER_DAY),
            COOLDOWN_SECS,
        )
    }

    /// A contract and what one more position costs in it. Ids take a fixed eight
    /// bytes, so every position with the same keeper costs the same.
    fn contract_and_storage_cost() -> (Levee, NearToken) {
        let mut contract = new_contract();
        register_with(&mut contract, NearToken::from_near(1));
        let paid: U128 =
            serde_json::from_value(last_event()["data"]["storage_paid"].clone()).unwrap();
        (contract, NearToken::from_yoctonear(paid.0))
    }

    #[test]
    fn ids_are_sequential_from_one() {
        let mut contract = new_contract();
        assert_eq!(register(&mut contract, KEEPER), 1);
        assert_eq!(register(&mut contract, KEEPER), 2);
        assert_eq!(register(&mut contract, KEEPER), 3);
    }

    #[test]
    fn the_caller_owns_the_position() {
        let (contract, id) = setup();
        let position = contract.get_position(id).unwrap();
        assert_eq!(position.owner, account(OWNER));
        assert_eq!(position.keeper, account(KEEPER));
        assert_eq!(position.chain_id, 8453);
        assert_eq!(position.max_per_rescue, U128(MAX_PER_RESCUE));
        assert_eq!(position.max_per_day, U128(MAX_PER_DAY));
        assert_eq!(position.cooldown_secs, COOLDOWN_SECS);
        assert!(!position.paused);
        assert_eq!(position.spent_today, U128(0));
        assert_eq!(position.last_rescue_at, 0);
        assert_eq!(position.pending_loosen, None);
    }

    #[test]
    fn the_borrower_is_stored_normalised() {
        let mut contract = new_contract();
        testing_env!(context(OWNER, NOON)
            .attached_deposit(NearToken::from_near(1))
            .build());
        let id = contract.register(
            8453,
            "0x1234567890AbcdEF1234567890aBcdef12345678".into(),
            account(KEEPER),
            U128(1),
            U128(1),
            0,
        );
        assert_eq!(contract.get_position(id).unwrap().borrower, BORROWER);
    }

    #[test]
    fn logs_position_registered() {
        let mut contract = new_contract();
        register(&mut contract, KEEPER);
        let event = last_event();
        assert_eq!(event["standard"], "levee");
        assert_eq!(event["version"], "1.0.0");
        assert_eq!(event["event"], "position_registered");
        assert_eq!(event["data"]["id"], 1);
        assert_eq!(event["data"]["owner"], OWNER);
        assert_eq!(event["data"]["borrower"], BORROWER);
    }

    #[test]
    #[should_panic(expected = "unknown chain id")]
    fn rejects_an_unconfigured_chain() {
        let mut contract = new_contract();
        testing_env!(context(OWNER, NOON)
            .attached_deposit(NearToken::from_near(1))
            .build());
        contract.register(1, BORROWER.into(), account(KEEPER), U128(1), U128(1), 0);
    }

    #[test]
    #[should_panic(expected = "address must be 0x followed by 40 hex characters")]
    fn rejects_a_malformed_borrower() {
        let mut contract = new_contract();
        testing_env!(context(OWNER, NOON)
            .attached_deposit(NearToken::from_near(1))
            .build());
        contract.register(
            8453,
            "1234567890abcdef1234567890abcdef12345678".into(),
            account(KEEPER),
            U128(1),
            U128(1),
            0,
        );
    }

    #[test]
    #[should_panic(expected = "the zero address is not allowed")]
    fn rejects_the_zero_borrower() {
        let mut contract = new_contract();
        testing_env!(context(OWNER, NOON)
            .attached_deposit(NearToken::from_near(1))
            .build());
        contract.register(
            8453,
            format!("0x{}", "0".repeat(40)),
            account(KEEPER),
            U128(1),
            U128(1),
            0,
        );
    }

    #[test]
    #[should_panic(expected = "max_per_rescue and max_per_day must be above zero")]
    fn rejects_a_zero_rescue_cap() {
        let mut contract = new_contract();
        testing_env!(context(OWNER, NOON)
            .attached_deposit(NearToken::from_near(1))
            .build());
        contract.register(8453, BORROWER.into(), account(KEEPER), U128(0), U128(1), 0);
    }

    #[test]
    #[should_panic(expected = "max_per_rescue and max_per_day must be above zero")]
    fn rejects_a_zero_daily_cap() {
        let mut contract = new_contract();
        testing_env!(context(OWNER, NOON)
            .attached_deposit(NearToken::from_near(1))
            .build());
        contract.register(8453, BORROWER.into(), account(KEEPER), U128(1), U128(0), 0);
    }

    #[test]
    fn an_exact_deposit_refunds_nothing() {
        let (mut contract, cost) = contract_and_storage_cost();
        register_with(&mut contract, cost);
        assert!(transfers().is_empty());
    }

    #[test]
    fn a_surplus_goes_back_to_the_caller() {
        let (mut contract, cost) = contract_and_storage_cost();
        let surplus = NearToken::from_yoctonear(12_345);
        register_with(&mut contract, cost.saturating_add(surplus));
        assert_eq!(transfers(), vec![(account(OWNER), surplus)]);
    }

    #[test]
    #[should_panic(expected = "attached deposit does not cover storage")]
    fn one_yocto_short_is_rejected() {
        let (mut contract, cost) = contract_and_storage_cost();
        let short = cost.saturating_sub(NearToken::from_yoctonear(1));
        register_with(&mut contract, short);
    }

    #[test]
    fn the_pending_loosen_constant_is_exact() {
        let none: Option<PendingLoosen> = None;
        let some = Some(PendingLoosen {
            max_per_rescue: U128(1),
            max_per_day: U128(1),
            cooldown_secs: 1,
            ready_at: 1,
        });
        let grown = near_sdk::borsh::to_vec(&some).unwrap().len()
            - near_sdk::borsh::to_vec(&none).unwrap().len();
        assert_eq!(grown as u64, PENDING_LOOSEN_BYTES);
    }

    #[test]
    fn paid_storage_covers_the_largest_the_record_can_grow() {
        let mut contract = new_contract();
        let usage_before = env::storage_usage();
        let id = register(&mut contract, "k.near");
        let paid: U128 =
            serde_json::from_value(last_event()["data"]["storage_paid"].clone()).unwrap();
        let paid_bytes = paid.0 / env::storage_byte_cost().as_yoctonear();

        // The longest keeper a NEAR account id allows, and a queued loosening.
        let longest = format!("{}.near", "k".repeat(59));
        assert_eq!(longest.len(), 64);
        act_as(OWNER, NOON);
        contract.set_keeper(id, account(&longest));
        contract.queue_loosen(id, U128(u128::MAX), U128(u128::MAX), 0);
        contract.positions.flush();

        let grown_to = env::storage_usage() - usage_before;
        assert!(
            u128::from(grown_to) <= paid_bytes,
            "{grown_to} > {paid_bytes}"
        );
    }
}

mod owner_only {
    use super::*;

    #[test]
    #[should_panic(expected = "caller is not the owner")]
    fn set_keeper() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        contract.set_keeper(id, account(STRANGER));
    }

    #[test]
    #[should_panic(expected = "caller is not the owner")]
    fn tighten() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        contract.tighten(id, U128(1), U128(1), COOLDOWN_SECS);
    }

    #[test]
    #[should_panic(expected = "caller is not the owner")]
    fn queue_loosen() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        contract.queue_loosen(id, U128(1_000), U128(1_000), 0);
    }

    #[test]
    #[should_panic(expected = "caller is not the owner")]
    fn apply_loosen() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.queue_loosen(id, U128(1_000), U128(1_000), 0);
        act_as(KEEPER, NOON + NANOS_PER_DAY);
        contract.apply_loosen(id);
    }

    #[test]
    #[should_panic(expected = "caller is not the owner")]
    fn pause() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        contract.pause(id);
    }

    #[test]
    #[should_panic(expected = "caller is not the owner")]
    fn resume() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        contract.resume(id);
    }

    #[test]
    #[should_panic(expected = "caller is not the owner")]
    fn withdraw_float() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        let _ = contract.withdraw_float(id, U128(1), fees());
    }

    #[test]
    #[should_panic(expected = "caller is not the owner")]
    fn sweep_gas() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        let _ = contract.sweep_gas(id, U128(1), fees());
    }
}

mod unknown_position {
    use super::*;

    #[test]
    #[should_panic(expected = "position not found")]
    fn rescue() {
        let mut contract = new_contract();
        act_as(KEEPER, NOON);
        let _ = contract.rescue(99, U128(1), fees());
    }

    #[test]
    #[should_panic(expected = "position not found")]
    fn pause() {
        let mut contract = new_contract();
        act_as(OWNER, NOON);
        contract.pause(99);
    }

    #[test]
    #[should_panic(expected = "position not found")]
    fn preview() {
        let contract = new_contract();
        act_as(KEEPER, NOON);
        contract.preview_rescue(99, U128(1), fees());
    }

    #[test]
    fn get_position_returns_none() {
        let contract = new_contract();
        assert_eq!(contract.get_position(99), None);
    }
}

mod keeper {
    use super::*;

    #[test]
    fn set_keeper_swaps_who_can_rescue() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.set_keeper(id, account(STRANGER));
        let event = last_event();
        assert_eq!(event["event"], "keeper_changed");
        assert_eq!(event["data"]["old_keeper"], KEEPER);
        assert_eq!(event["data"]["new_keeper"], STRANGER);

        act_as(STRANGER, NOON);
        let _ = contract.rescue(id, U128(1), fees());
        assert_eq!(spent(&contract, id), 1);
    }

    #[test]
    #[should_panic(expected = "caller is not the keeper")]
    fn the_old_keeper_is_locked_out() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.set_keeper(id, account(STRANGER));
        act_as(KEEPER, NOON);
        let _ = contract.rescue(id, U128(1), fees());
    }
}

mod rescue_rules {
    use super::*;

    #[test]
    #[should_panic(expected = "caller is not the keeper")]
    fn rule_1_a_stranger_is_rejected() {
        let (mut contract, id) = setup();
        act_as(STRANGER, NOON);
        let _ = contract.rescue(id, U128(1), fees());
    }

    #[test]
    #[should_panic(expected = "caller is not the keeper")]
    fn rule_1_the_owner_is_not_the_keeper() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        let _ = contract.rescue(id, U128(1), fees());
    }

    #[test]
    #[should_panic(expected = "position is paused")]
    fn rule_2_paused() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.pause(id);
        rescue(&mut contract, id, 1, NOON);
    }

    #[test]
    fn rule_2_resume_lifts_the_pause() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.pause(id);
        assert_eq!(last_event()["event"], "paused");
        contract.resume(id);
        assert_eq!(last_event()["event"], "resumed");
        rescue(&mut contract, id, 1, NOON);
        assert_eq!(spent(&contract, id), 1);
    }

    #[test]
    #[should_panic(expected = "amount must be above zero")]
    fn rule_3_zero() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, 0, NOON);
    }

    #[test]
    #[should_panic(expected = "amount exceeds max_per_rescue")]
    fn rule_3_over_the_cap() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, MAX_PER_RESCUE + 1, NOON);
    }

    #[test]
    fn rule_3_at_the_cap() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, MAX_PER_RESCUE, NOON);
        assert_eq!(spent(&contract, id), MAX_PER_RESCUE);
    }

    #[test]
    #[should_panic(expected = "amount exceeds the daily budget")]
    fn rule_4_over_the_budget() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, 100, NOON);
        rescue(&mut contract, id, 100, NOON + HOUR);
        rescue(&mut contract, id, 51, NOON + 2 * HOUR);
    }

    #[test]
    fn rule_4_exactly_the_budget() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, 100, NOON);
        rescue(&mut contract, id, 100, NOON + HOUR);
        rescue(&mut contract, id, 50, NOON + 2 * HOUR);
        assert_eq!(spent(&contract, id), MAX_PER_DAY);
    }

    #[test]
    fn rule_4_a_new_utc_day_starts_a_new_budget() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, 100, NOON);
        rescue(&mut contract, id, 100, NOON + HOUR);
        rescue(&mut contract, id, 100, NOON + NANOS_PER_DAY);
        assert_eq!(contract.get_position(id).unwrap().spent_today, U128(100));
    }

    #[test]
    #[should_panic(expected = "cooldown has not elapsed")]
    fn rule_5_inside_the_cooldown() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, 1, NOON);
        rescue(&mut contract, id, 1, NOON + 60 * NANOS_PER_SEC - 1);
    }

    #[test]
    fn rule_5_at_the_end_of_the_cooldown() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, 1, NOON);
        rescue(&mut contract, id, 1, NOON + 60 * NANOS_PER_SEC);
        assert_eq!(spent(&contract, id), 2);
    }

    #[test]
    #[should_panic(expected = "max_fee_per_gas exceeds the chain ceiling")]
    fn rule_6_max_fee() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        let mut high = fees();
        high.max_fee_per_gas = U128(MAX_FEE_CEILING + 1);
        let _ = contract.rescue(id, U128(1), high);
    }

    #[test]
    #[should_panic(expected = "max_priority_fee_per_gas exceeds the chain ceiling")]
    fn rule_6_priority_fee() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        let mut high = fees();
        high.max_priority_fee_per_gas = U128(PRIORITY_CEILING + 1);
        let _ = contract.rescue(id, U128(1), high);
    }

    #[test]
    fn a_rule_failure_changes_nothing() {
        let (contract, id) = setup();
        let before = contract.get_position(id);
        act_as(KEEPER, NOON);
        let result = policy::check_rescue(
            contract.position(id),
            contract.get_chain(8453).as_ref().unwrap(),
            MAX_PER_RESCUE + 1,
            &fees(),
            NOON,
        );
        assert_eq!(result, Err(ERR_OVER_MAX_PER_RESCUE));
        assert_eq!(contract.get_position(id), before);
    }

    #[test]
    fn the_error_constants_are_the_ones_callers_see() {
        // The `should_panic` strings above are literals. Pin them to the constants so
        // a reworded error cannot leave a test passing on a stale message.
        assert_eq!(ERR_PAUSED, "position is paused");
        assert_eq!(ERR_ZERO_AMOUNT, "amount must be above zero");
        assert_eq!(ERR_OVER_MAX_PER_RESCUE, "amount exceeds max_per_rescue");
        assert_eq!(ERR_OVER_DAILY_BUDGET, "amount exceeds the daily budget");
        assert_eq!(ERR_COOLDOWN, "cooldown has not elapsed");
        assert_eq!(
            ERR_MAX_FEE_CEILING,
            "max_fee_per_gas exceeds the chain ceiling"
        );
        assert_eq!(
            ERR_PRIORITY_FEE_CEILING,
            "max_priority_fee_per_gas exceeds the chain ceiling"
        );
        assert_eq!(
            ERR_OVER_MAX_ALLOWANCE,
            "amount exceeds 30 times max_per_day"
        );
    }
}

mod signing {
    use super::*;

    #[test]
    fn rescue_asks_the_signer_for_the_contract_built_hash() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        let _ = contract.rescue(id, U128(2), fees());

        let chain = contract.get_chain(8453).unwrap();
        let position = contract.get_position(id).unwrap();
        let unsigned = txs::repay_tx(&chain, &position, 2, &fees()).unsigned_bytes();
        let hash = env::keccak256_array(&unsigned);

        let calls = calls();
        assert_eq!(calls.len(), 2);
        let sign = &calls[0];
        assert_eq!(sign.receiver, account(SIGNER));
        assert_eq!(sign.method, "sign");
        assert_eq!(
            sign.args,
            json!({
                "request": {
                    "path": format!("levee/v1/{id}"),
                    "domain_id": 0,
                    "payload_v2": { "Ecdsa": hex::encode(hash) },
                }
            })
        );
    }

    #[test]
    fn the_contract_attaches_exactly_one_yocto_to_sign_and_none_to_the_callback() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, 1, NOON);
        let calls = calls();
        assert_eq!(calls[0].deposit, NearToken::from_yoctonear(1));
        assert_eq!(calls[1].deposit, NearToken::from_yoctonear(0));
    }

    #[test]
    fn unused_gas_flows_to_sign_and_the_callback_share_is_fixed() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, 1, NOON);
        let calls = calls();
        assert_eq!(calls[0].method, "sign");
        assert_eq!(calls[0].gas, SIGN_GAS);
        assert_eq!(calls[0].weight, 1);
        assert_eq!(calls[1].method, "on_signed");
        assert_eq!(calls[1].receiver, account(CONTRACT));
        assert_eq!(calls[1].gas, ON_SIGNED_GAS);
        assert_eq!(calls[1].weight, 0);
    }

    #[test]
    fn the_budget_is_reserved_before_the_signature_returns() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, 40, NOON);
        let position = contract.get_position(id).unwrap();
        assert_eq!(position.spent_today, U128(40));
        assert_eq!(position.last_rescue_at, NOON);
    }

    #[test]
    fn the_reservation_travels_to_the_callback() {
        let (mut contract, id) = setup();
        let pending = rescue(&mut contract, id, 40, NOON);
        assert_eq!(
            pending.reservation,
            Some(Reservation {
                amount: U128(40),
                day: policy::utc_day(NOON),
                at: NOON,
                previous_at: 0,
            })
        );
    }

    #[test]
    fn rescue_logs_rescue_requested() {
        let (mut contract, id) = setup();
        let pending = rescue(&mut contract, id, 40, NOON);
        let event = last_event();
        assert_eq!(event["event"], "rescue_requested");
        assert_eq!(event["data"]["id"], id);
        assert_eq!(event["data"]["amount"], "40");
        assert_eq!(event["data"]["nonce"], 7);
        assert_eq!(event["data"]["tx_hash"], json!(pending.tx_hash));
    }

    #[test]
    fn each_position_signs_from_its_own_path() {
        let mut contract = new_contract();
        let first = register(&mut contract, KEEPER);
        let second = register(&mut contract, KEEPER);
        assert_ne!(contract.rescuer_path(first), contract.rescuer_path(second));

        act_as(KEEPER, NOON);
        let _ = contract.rescue(second, U128(1), fees());
        assert_eq!(calls()[0].args["request"]["path"], "levee/v1/2");
    }

    /// Only the boundary of the check. Whether the minimum really reaches the signer
    /// is measured against the real VM in `tests/sandbox.rs`.
    #[test]
    fn the_gas_check_boundary_is_inclusive() {
        assert_eq!(check_signing_gas(MIN_SIGNING_GAS), Ok(()));
        let short = Gas::from_gas(MIN_SIGNING_GAS.as_gas() - 1);
        assert_eq!(check_signing_gas(short), Err(ERR_GAS_TOO_LOW));
    }

    #[test]
    #[should_panic(expected = "not enough gas attached to reach the signer")]
    fn less_than_the_minimum_gas_is_rejected() {
        let (mut contract, id) = setup();
        let short = Gas::from_gas(MIN_SIGNING_GAS.as_gas() - 1);
        testing_env!(context(KEEPER, NOON).prepaid_gas(short).build());
        let _ = contract.rescue(id, U128(1), fees());
    }

    #[test]
    #[should_panic(expected = "not enough gas attached to reach the signer")]
    fn every_signing_method_checks_gas() {
        let (mut contract, id) = setup();
        testing_env!(context(OWNER, NOON).prepaid_gas(Gas::from_tgas(1)).build());
        let _ = contract.withdraw_float(id, U128(1), fees());
    }
}

mod callback {
    use super::*;

    #[test]
    fn a_signature_comes_back_with_all_it_takes_to_broadcast() {
        let (mut contract, id) = setup();
        let pending = rescue(&mut contract, id, 40, NOON);
        let expected = pending.clone();

        let signed = deliver(
            &mut contract,
            pending,
            PromiseResult::Successful(real_signature()),
            NOON,
        )
        .unwrap();

        assert_eq!(signed.kind, SignKind::Rescue);
        assert_eq!(signed.id, id);
        assert_eq!(signed.unsigned_tx, expected.unsigned_tx);
        assert_eq!(signed.tx_hash, expected.tx_hash);
        assert_eq!(
            signed.big_r,
            "0x03f801266a516fbdef4a890b10ca39cbbfa959320412d3126e5bd0fa05ded238d3"
        );
        assert_eq!(
            signed.s,
            "0x4071aa91247451c43e29f2bc1fbbdfcae2d06b0e36e2b2ceefb0a8a64d388f86"
        );
        assert_eq!(signed.recovery_id, 1);
    }

    #[test]
    fn the_log_says_the_same_as_the_return_value() {
        let (mut contract, id) = setup();
        let pending = rescue(&mut contract, id, 40, NOON);
        let signed = deliver(
            &mut contract,
            pending,
            PromiseResult::Successful(real_signature()),
            NOON,
        )
        .unwrap();

        let event = last_event();
        assert_eq!(event["event"], "rescue_signed");
        assert_eq!(event["data"], serde_json::to_value(&signed).unwrap());
    }

    #[test]
    fn success_keeps_the_budget_charged() {
        let (mut contract, id) = setup();
        let pending = rescue(&mut contract, id, 40, NOON);
        deliver(
            &mut contract,
            pending,
            PromiseResult::Successful(real_signature()),
            NOON,
        );
        assert_eq!(spent(&contract, id), 40);
    }

    #[test]
    fn a_failed_call_releases_the_budget_and_returns_null() {
        let (mut contract, id) = setup();
        let pending = rescue(&mut contract, id, 40, NOON);
        let result = deliver(&mut contract, pending, PromiseResult::Failed, NOON);
        assert_eq!(result, None);
        assert_eq!(spent(&contract, id), 0);
    }

    #[test]
    fn a_failed_call_frees_the_cooldown_so_the_keeper_can_retry() {
        let (mut contract, id) = setup();
        let pending = rescue(&mut contract, id, 40, NOON);
        deliver(&mut contract, pending, PromiseResult::Failed, NOON + 1);
        assert_eq!(contract.get_position(id).unwrap().last_rescue_at, 0);
        rescue(&mut contract, id, 40, NOON + 2);
        assert_eq!(spent(&contract, id), 40);
    }

    #[test]
    fn a_failed_call_logs_rescue_failed() {
        let (mut contract, id) = setup();
        let pending = rescue(&mut contract, id, 40, NOON);
        let tx_hash = pending.tx_hash.clone();
        deliver(&mut contract, pending, PromiseResult::Failed, NOON);
        let event = last_event();
        assert_eq!(event["event"], "rescue_failed");
        assert_eq!(event["data"]["reason"], "mpc_failed");
        assert_eq!(event["data"]["released"], "40");
        assert_eq!(event["data"]["tx_hash"], json!(tx_hash));
    }

    #[test]
    fn a_failure_after_midnight_does_not_refund_the_new_day() {
        let (mut contract, id) = setup();
        let late = (policy::utc_day(NOON) + 1) * NANOS_PER_DAY - 1;
        let pending = rescue(&mut contract, id, 40, late);

        let later = late + 120 * NANOS_PER_SEC;
        rescue(&mut contract, id, 30, later);
        deliver(&mut contract, pending, PromiseResult::Failed, later);

        assert_eq!(spent(&contract, id), 30);
        assert_eq!(last_event()["data"]["released"], "0");
    }

    #[test]
    fn a_malformed_response_keeps_the_budget_charged() {
        let (mut contract, id) = setup();
        let pending = rescue(&mut contract, id, 40, NOON);
        let result = deliver(
            &mut contract,
            pending,
            PromiseResult::Successful(b"not a signature".to_vec()),
            NOON,
        );
        assert_eq!(result, None);
        assert_eq!(spent(&contract, id), 40);
        assert_eq!(contract.get_position(id).unwrap().last_rescue_at, NOON);

        let event = last_event();
        assert_eq!(event["event"], "rescue_failed");
        assert_eq!(event["data"]["reason"], "malformed_response");
        assert_eq!(event["data"]["released"], "0");
    }

    #[test]
    fn an_oversized_response_counts_as_malformed() {
        let (mut contract, id) = setup();
        let pending = rescue(&mut contract, id, 40, NOON);
        let result = deliver(
            &mut contract,
            pending,
            PromiseResult::Successful(vec![b'x'; MAX_RESPONSE_BYTES + 1]),
            NOON,
        );
        assert_eq!(result, None);
        assert_eq!(spent(&contract, id), 40);
        assert_eq!(last_event()["data"]["reason"], "malformed_response");
    }

    fn sign_kind(contract: &mut Levee, id: u64, kind: SignKind) -> PendingSignature {
        act_as(OWNER, NOON);
        let _ = match kind {
            SignKind::Allowance => contract.prepare_allowance(id, U128(1), fees()),
            SignKind::WithdrawFloat => contract.withdraw_float(id, U128(1), fees()),
            SignKind::SweepGas => contract.sweep_gas(id, U128(1), fees()),
            SignKind::Rescue => unreachable!(),
        };
        pending()
    }

    #[test]
    fn each_kind_logs_its_own_event() {
        let (mut contract, id) = setup();
        for (kind, event) in [
            (SignKind::Allowance, "allowance_signed"),
            (SignKind::WithdrawFloat, "float_withdrawn"),
            (SignKind::SweepGas, "gas_swept"),
        ] {
            let pending = sign_kind(&mut contract, id, kind);
            assert_eq!(pending.kind, kind);
            let signed = deliver(
                &mut contract,
                pending,
                PromiseResult::Successful(real_signature()),
                NOON,
            )
            .unwrap();
            assert_eq!(signed.kind, kind);
            assert_eq!(last_event()["event"], event);
        }
    }

    #[test]
    fn other_kinds_hold_no_budget_and_log_sign_failed() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, 40, NOON);
        for kind in [
            SignKind::Allowance,
            SignKind::WithdrawFloat,
            SignKind::SweepGas,
        ] {
            let pending = sign_kind(&mut contract, id, kind);
            assert_eq!(pending.reservation, None);
            assert_eq!(
                deliver(&mut contract, pending, PromiseResult::Failed, NOON),
                None
            );
            let event = last_event();
            assert_eq!(event["event"], "sign_failed");
            assert_eq!(event["data"]["released"], "0");
            assert_eq!(spent(&contract, id), 40);
        }
    }
}

mod allowance {
    use super::*;

    const MAX: u128 = 30 * MAX_PER_DAY;

    #[test]
    fn the_keeper_can_prepare_it() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        let _ = contract.prepare_allowance(id, U128(MAX), fees());
        assert_eq!(pending().kind, SignKind::Allowance);
    }

    #[test]
    fn the_owner_can_prepare_it() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        let _ = contract.prepare_allowance(id, U128(MAX), fees());
        assert_eq!(pending().kind, SignKind::Allowance);
    }

    #[test]
    #[should_panic(expected = "caller is neither the keeper nor the owner")]
    fn a_stranger_cannot() {
        let (mut contract, id) = setup();
        act_as(STRANGER, NOON);
        let _ = contract.prepare_allowance(id, U128(1), fees());
    }

    #[test]
    #[should_panic(expected = "amount exceeds 30 times max_per_day")]
    fn one_over_the_limit_is_rejected() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        let _ = contract.prepare_allowance(id, U128(MAX + 1), fees());
    }

    #[test]
    #[should_panic(expected = "amount exceeds 30 times max_per_day")]
    fn the_limit_follows_a_tightened_budget() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.tighten(id, U128(MAX_PER_RESCUE), U128(10), COOLDOWN_SECS);
        act_as(KEEPER, NOON);
        let _ = contract.prepare_allowance(id, U128(301), fees());
    }

    #[test]
    fn zero_revokes_the_allowance() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        let _ = contract.prepare_allowance(id, U128(0), fees());
        assert_eq!(pending().kind, SignKind::Allowance);
    }

    #[test]
    fn it_only_ever_approves_the_pool_on_usdc() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        let _ = contract.prepare_allowance(id, U128(5), fees());
        let chain = contract.get_chain(8453).unwrap();
        let expected = hex_of(&txs::approve_tx(&chain, 5, &fees()).unsigned_bytes());
        assert_eq!(pending().unsigned_tx, expected);
    }

    #[test]
    #[should_panic(expected = "position is paused")]
    fn a_keeper_cannot_while_paused() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.pause(id);
        act_as(KEEPER, NOON);
        let _ = contract.prepare_allowance(id, U128(1), fees());
    }

    #[test]
    fn an_owner_can_revoke_while_paused() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.pause(id);
        let _ = contract.prepare_allowance(id, U128(0), fees());
        assert_eq!(pending().kind, SignKind::Allowance);
    }

    #[test]
    #[should_panic(expected = "max_fee_per_gas exceeds the chain ceiling")]
    fn fee_ceilings_apply() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        let mut high = fees();
        high.max_fee_per_gas = U128(MAX_FEE_CEILING + 1);
        let _ = contract.prepare_allowance(id, U128(1), high);
    }

    #[test]
    fn it_uses_no_daily_budget() {
        let (mut contract, id) = setup();
        act_as(KEEPER, NOON);
        let _ = contract.prepare_allowance(id, U128(MAX), fees());
        assert_eq!(spent(&contract, id), 0);
    }
}

mod exits {
    use super::*;

    #[test]
    fn withdraw_float_only_ever_pays_the_borrower() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        let _ = contract.withdraw_float(id, U128(9), fees());
        let chain = contract.get_chain(8453).unwrap();
        let position = contract.get_position(id).unwrap();
        let expected = hex_of(&txs::transfer_tx(&chain, &position, 9, &fees()).unsigned_bytes());
        let pending = pending();
        assert_eq!(pending.unsigned_tx, expected);
        assert_eq!(pending.kind, SignKind::WithdrawFloat);
    }

    #[test]
    fn sweep_gas_only_ever_pays_the_borrower() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        let _ = contract.sweep_gas(id, U128(9), fees());
        let chain = contract.get_chain(8453).unwrap();
        let position = contract.get_position(id).unwrap();
        let expected = hex_of(&txs::sweep_tx(&chain, &position, 9, &fees()).unsigned_bytes());
        let pending = pending();
        assert_eq!(pending.unsigned_tx, expected);
        assert_eq!(pending.kind, SignKind::SweepGas);
    }

    #[test]
    fn both_work_while_paused_so_an_owner_can_always_leave() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.pause(id);
        let _ = contract.withdraw_float(id, U128(1), fees());
        assert_eq!(pending().kind, SignKind::WithdrawFloat);
        act_as(OWNER, NOON);
        let _ = contract.sweep_gas(id, U128(1), fees());
        assert_eq!(pending().kind, SignKind::SweepGas);
    }

    #[test]
    fn a_zero_sweep_can_replace_a_stuck_nonce() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        let _ = contract.sweep_gas(id, U128(0), fees());
        assert_eq!(pending().kind, SignKind::SweepGas);
    }

    #[test]
    #[should_panic(expected = "max_fee_per_gas exceeds the chain ceiling")]
    fn withdraw_float_respects_fee_ceilings() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        let mut high = fees();
        high.max_fee_per_gas = U128(MAX_FEE_CEILING + 1);
        let _ = contract.withdraw_float(id, U128(1), high);
    }

    #[test]
    #[should_panic(expected = "max_priority_fee_per_gas exceeds the chain ceiling")]
    fn sweep_gas_respects_fee_ceilings() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        let mut high = fees();
        high.max_priority_fee_per_gas = U128(PRIORITY_CEILING + 1);
        let _ = contract.sweep_gas(id, U128(1), high);
    }

    #[test]
    fn neither_touches_the_daily_budget() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        let _ = contract.withdraw_float(id, U128(1_000_000), fees());
        let _ = contract.sweep_gas(id, U128(1_000_000), fees());
        assert_eq!(spent(&contract, id), 0);
    }
}

mod caps {
    use super::*;

    fn caps(contract: &Levee, id: u64) -> (u128, u128, u32) {
        let position = contract.get_position(id).unwrap();
        (
            position.max_per_rescue.0,
            position.max_per_day.0,
            position.cooldown_secs,
        )
    }

    #[test]
    fn tighten_is_immediate() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.tighten(id, U128(50), U128(100), 120);
        assert_eq!(caps(&contract, id), (50, 100, 120));
        let event = last_event();
        assert_eq!(event["event"], "caps_tightened");
        assert_eq!(event["data"]["loosen_cancelled"], false);
    }

    #[test]
    fn tighten_keeps_values_that_do_not_change() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.tighten(id, U128(50), U128(MAX_PER_DAY), COOLDOWN_SECS);
        assert_eq!(caps(&contract, id), (50, MAX_PER_DAY, COOLDOWN_SECS));
    }

    #[test]
    #[should_panic(expected = "max_per_rescue may only decrease")]
    fn tighten_rejects_a_higher_rescue_cap() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.tighten(
            id,
            U128(MAX_PER_RESCUE + 1),
            U128(MAX_PER_DAY),
            COOLDOWN_SECS,
        );
    }

    #[test]
    #[should_panic(expected = "max_per_day may only decrease")]
    fn tighten_rejects_a_higher_daily_cap() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.tighten(
            id,
            U128(MAX_PER_RESCUE),
            U128(MAX_PER_DAY + 1),
            COOLDOWN_SECS,
        );
    }

    #[test]
    #[should_panic(expected = "cooldown_secs may only increase")]
    fn tighten_rejects_a_shorter_cooldown() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.tighten(
            id,
            U128(MAX_PER_RESCUE),
            U128(MAX_PER_DAY),
            COOLDOWN_SECS - 1,
        );
    }

    #[test]
    fn tighten_can_zero_the_caps_as_a_freeze() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.tighten(id, U128(0), U128(0), COOLDOWN_SECS);
        assert_eq!(caps(&contract, id), (0, 0, COOLDOWN_SECS));
    }

    #[test]
    fn the_error_constants_are_the_ones_callers_see() {
        assert_eq!(
            ERR_TIGHTEN_MAX_PER_RESCUE,
            "max_per_rescue may only decrease"
        );
        assert_eq!(ERR_TIGHTEN_MAX_PER_DAY, "max_per_day may only decrease");
        assert_eq!(ERR_TIGHTEN_COOLDOWN, "cooldown_secs may only increase");
        assert_eq!(ERR_NO_PENDING_LOOSEN, "no loosening is queued");
        assert_eq!(ERR_LOOSEN_NOT_READY, "the loosening delay has not elapsed");
        assert_eq!(
            ERR_PRIORITY_OVER_MAX_FEE,
            "max_priority_fee_per_gas exceeds max_fee_per_gas"
        );
    }

    #[test]
    fn queueing_changes_nothing_yet() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.queue_loosen(id, U128(200), U128(500), 30);
        assert_eq!(
            caps(&contract, id),
            (MAX_PER_RESCUE, MAX_PER_DAY, COOLDOWN_SECS)
        );
        let event = last_event();
        assert_eq!(event["event"], "caps_loosen_queued");
        assert_eq!(event["data"]["ready_at"], NOON + NANOS_PER_DAY);
    }

    #[test]
    fn the_queued_loosening_is_visible() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.queue_loosen(id, U128(200), U128(500), 30);
        assert_eq!(
            contract.get_position(id).unwrap().pending_loosen,
            Some(PendingLoosen {
                max_per_rescue: U128(200),
                max_per_day: U128(500),
                cooldown_secs: 30,
                ready_at: NOON + NANOS_PER_DAY,
            })
        );
    }

    #[test]
    #[should_panic(expected = "the loosening delay has not elapsed")]
    fn apply_one_nanosecond_early_is_rejected() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.queue_loosen(id, U128(200), U128(500), 30);
        act_as(OWNER, NOON + NANOS_PER_DAY - 1);
        contract.apply_loosen(id);
    }

    #[test]
    fn apply_at_exactly_24_hours_works() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.queue_loosen(id, U128(200), U128(500), 30);
        act_as(OWNER, NOON + NANOS_PER_DAY);
        contract.apply_loosen(id);
        assert_eq!(caps(&contract, id), (200, 500, 30));
        assert_eq!(contract.get_position(id).unwrap().pending_loosen, None);
        assert_eq!(last_event()["event"], "caps_loosened");
    }

    #[test]
    #[should_panic(expected = "no loosening is queued")]
    fn apply_with_nothing_queued_is_rejected() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.apply_loosen(id);
    }

    #[test]
    #[should_panic(expected = "no loosening is queued")]
    fn a_loosening_cannot_be_applied_twice() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.queue_loosen(id, U128(200), U128(500), 30);
        act_as(OWNER, NOON + NANOS_PER_DAY);
        contract.apply_loosen(id);
        contract.apply_loosen(id);
    }

    #[test]
    #[should_panic(expected = "no value is being loosened")]
    fn queueing_no_change_is_rejected() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.queue_loosen(id, U128(MAX_PER_RESCUE), U128(MAX_PER_DAY), COOLDOWN_SECS);
    }

    #[test]
    #[should_panic(expected = "max_per_rescue may only increase")]
    fn queueing_a_stricter_value_is_rejected() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.queue_loosen(id, U128(MAX_PER_RESCUE - 1), U128(500), 30);
    }

    #[test]
    fn tighten_cancels_a_queued_loosening() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.queue_loosen(id, U128(200), U128(500), 30);
        contract.tighten(id, U128(MAX_PER_RESCUE), U128(MAX_PER_DAY), COOLDOWN_SECS);
        assert_eq!(last_event()["data"]["loosen_cancelled"], true);
        assert_eq!(contract.get_position(id).unwrap().pending_loosen, None);
    }

    /// Queue, tighten a minute before the delay ends, then apply. Without the
    /// cancellation the tightened caps would last one minute instead of 24 hours.
    #[test]
    #[should_panic(expected = "no loosening is queued")]
    fn a_tighten_cannot_be_undone_by_a_loosening_queued_before_it() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.queue_loosen(id, U128(200), U128(500), 30);
        act_as(OWNER, NOON + NANOS_PER_DAY - 60 * NANOS_PER_SEC);
        contract.tighten(id, U128(1), U128(1), 3_600);
        act_as(OWNER, NOON + NANOS_PER_DAY);
        contract.apply_loosen(id);
    }

    /// Queue a small change, wait, then swap in a large one just before applying.
    #[test]
    #[should_panic(expected = "the loosening delay has not elapsed")]
    fn replacing_a_queued_loosening_restarts_the_delay() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.queue_loosen(id, U128(101), U128(MAX_PER_DAY), COOLDOWN_SECS);
        act_as(OWNER, NOON + NANOS_PER_DAY - 1);
        contract.queue_loosen(id, U128(1_000_000), U128(1_000_000), 0);
        act_as(OWNER, NOON + NANOS_PER_DAY);
        contract.apply_loosen(id);
    }

    #[test]
    fn a_replaced_loosening_applies_a_full_day_after_the_replacement() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.queue_loosen(id, U128(101), U128(MAX_PER_DAY), COOLDOWN_SECS);
        let replaced_at = NOON + HOUR;
        act_as(OWNER, replaced_at);
        contract.queue_loosen(id, U128(200), U128(500), 30);
        act_as(OWNER, replaced_at + NANOS_PER_DAY);
        contract.apply_loosen(id);
        assert_eq!(caps(&contract, id), (200, 500, 30));
    }

    #[test]
    fn a_loosened_cap_is_enforced_at_its_new_value() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.queue_loosen(id, U128(200), U128(500), 30);
        act_as(OWNER, NOON + NANOS_PER_DAY);
        contract.apply_loosen(id);
        rescue(&mut contract, id, 200, NOON + NANOS_PER_DAY);
        assert_eq!(spent(&contract, id), 200);
    }
}

mod views {
    use super::*;

    #[test]
    fn rescuer_path_follows_the_spec() {
        let contract = new_contract();
        assert_eq!(contract.rescuer_path(1), "levee/v1/1");
        assert_eq!(contract.rescuer_path(4_294_967_296), "levee/v1/4294967296");
    }

    #[test]
    fn get_position_shows_todays_spend_not_a_stale_bucket() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, 40, NOON);
        assert_eq!(spent(&contract, id), 40);

        act_as(STRANGER, NOON + NANOS_PER_DAY);
        let position = contract.get_position(id).unwrap();
        assert_eq!(position.spent_today, U128(0));
        assert_eq!(position.day, policy::utc_day(NOON) + 1);
    }

    #[test]
    fn preview_shows_exactly_what_rescue_signs() {
        let (mut contract, id) = setup();
        act_as(STRANGER, NOON);
        let preview = contract.preview_rescue(id, U128(40), fees());
        let pending = rescue(&mut contract, id, 40, NOON);
        assert_eq!(preview.unsigned_tx, pending.unsigned_tx);
        assert_eq!(preview.tx_hash, pending.tx_hash);
    }

    #[test]
    fn preview_changes_no_state() {
        let (contract, id) = setup();
        act_as(STRANGER, NOON);
        let before = contract.get_position(id);
        contract.preview_rescue(id, U128(40), fees());
        assert_eq!(contract.get_position(id), before);
    }

    #[test]
    #[should_panic(expected = "position is paused")]
    fn preview_fails_as_rescue_would_when_paused() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.pause(id);
        contract.preview_rescue(id, U128(1), fees());
    }

    #[test]
    #[should_panic(expected = "amount exceeds max_per_rescue")]
    fn preview_fails_as_rescue_would_over_the_cap() {
        let (contract, id) = setup();
        act_as(STRANGER, NOON);
        contract.preview_rescue(id, U128(MAX_PER_RESCUE + 1), fees());
    }

    #[test]
    #[should_panic(expected = "cooldown has not elapsed")]
    fn preview_fails_as_rescue_would_during_cooldown() {
        let (mut contract, id) = setup();
        rescue(&mut contract, id, 1, NOON);
        contract.preview_rescue(id, U128(1), fees());
    }
}
