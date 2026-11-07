//! Contract-level unit tests. The rules themselves are tested on their boundaries in
//! `policy.rs`. These tests prove the methods are wired to those rules.

use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, Gas, NearToken};

use super::*;
use crate::policy::{
    ERR_LOOSEN_NOT_READY, ERR_NO_PENDING_LOOSEN, ERR_TIGHTEN_COOLDOWN, ERR_TIGHTEN_MAX_PER_DAY,
    ERR_TIGHTEN_MAX_PER_RESCUE, NANOS_PER_DAY, NANOS_PER_SEC,
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

fn transfers() -> Vec<(AccountId, NearToken)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|receipt| {
            let receiver = receipt.receiver_id.clone();
            receipt.actions.into_iter().filter_map(move |action| match action {
                MockAction::Transfer { deposit, .. } => Some((receiver.clone(), deposit)),
                _ => None,
            })
        })
        .collect()
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
        contract.register(
            1,
            BORROWER.into(),
            account(KEEPER),
            U128(1),
            U128(1),
            0,
        );
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
        contract.register(
            8453,
            BORROWER.into(),
            account(KEEPER),
            U128(0),
            U128(1),
            0,
        );
    }

    #[test]
    #[should_panic(expected = "max_per_rescue and max_per_day must be above zero")]
    fn rejects_a_zero_daily_cap() {
        let mut contract = new_contract();
        testing_env!(context(OWNER, NOON)
            .attached_deposit(NearToken::from_near(1))
            .build());
        contract.register(
            8453,
            BORROWER.into(),
            account(KEEPER),
            U128(1),
            U128(0),
            0,
        );
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
        assert!(u128::from(grown_to) <= paid_bytes, "{grown_to} > {paid_bytes}");
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
}

mod unknown_position {
    use super::*;

    #[test]
    #[should_panic(expected = "position not found")]
    fn pause() {
        let mut contract = new_contract();
        act_as(OWNER, NOON);
        contract.pause(99);
    }

    #[test]
    fn get_position_returns_none() {
        let contract = new_contract();
        assert_eq!(contract.get_position(99), None);
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
        contract.tighten(id, U128(MAX_PER_RESCUE + 1), U128(MAX_PER_DAY), COOLDOWN_SECS);
    }

    #[test]
    #[should_panic(expected = "max_per_day may only decrease")]
    fn tighten_rejects_a_higher_daily_cap() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.tighten(id, U128(MAX_PER_RESCUE), U128(MAX_PER_DAY + 1), COOLDOWN_SECS);
    }

    #[test]
    #[should_panic(expected = "cooldown_secs may only increase")]
    fn tighten_rejects_a_shorter_cooldown() {
        let (mut contract, id) = setup();
        act_as(OWNER, NOON);
        contract.tighten(id, U128(MAX_PER_RESCUE), U128(MAX_PER_DAY), COOLDOWN_SECS - 1);
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
        assert_eq!(ERR_TIGHTEN_MAX_PER_RESCUE, "max_per_rescue may only decrease");
        assert_eq!(ERR_TIGHTEN_MAX_PER_DAY, "max_per_day may only decrease");
        assert_eq!(ERR_TIGHTEN_COOLDOWN, "cooldown_secs may only increase");
        assert_eq!(ERR_NO_PENDING_LOOSEN, "no loosening is queued");
        assert_eq!(ERR_LOOSEN_NOT_READY, "the loosening delay has not elapsed");
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
}

mod views {
    use super::*;

    #[test]
    fn rescuer_path_follows_the_spec() {
        let contract = new_contract();
        assert_eq!(contract.rescuer_path(1), "levee/v1/1");
        assert_eq!(contract.rescuer_path(4_294_967_296), "levee/v1/4294967296");
    }
}
