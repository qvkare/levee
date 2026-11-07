//! Property tests. Transactions are decoded with alloy, an implementation that
//! shares nothing with the encoder under test.

use std::collections::{BTreeMap, VecDeque};

use alloy_consensus::transaction::RlpEcdsaDecodableTx;
use alloy_consensus::{SignableTransaction, TxEip1559};
use alloy_primitives::{keccak256, Address, TxKind, U256};
use levee::address::{normalise_address, parse_address};
use levee::evm::{signing_hash, SELECTOR_APPROVE, SELECTOR_REPAY, SELECTOR_TRANSFER};
use levee::policy::{self, NANOS_PER_DAY, NANOS_PER_SEC};
use levee::txs::{approve_tx, repay_tx, sweep_tx, transfer_tx};
use levee::types::{ChainConfig, Fees, Position, Reservation};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use proptest::prelude::*;

/// Sixteen bytes wide, weighted towards the edges where encoders go wrong.
fn wide_u128() -> impl Strategy<Value = u128> {
    prop_oneof![
        any::<u128>(),
        0u128..=1_024,
        (0u32..128).prop_map(|shift| 1u128 << shift),
        (1u32..128).prop_map(|shift| (1u128 << shift) - 1),
        Just(u128::MAX),
    ]
}

fn wide_u64() -> impl Strategy<Value = u64> {
    prop_oneof![
        any::<u64>(),
        0u64..=1_024,
        (0u32..64).prop_map(|shift| 1u64 << shift),
        Just(u64::MAX),
    ]
}

fn fees() -> impl Strategy<Value = Fees> {
    (wide_u64(), wide_u128(), wide_u128()).prop_map(|(nonce, max_fee, priority)| Fees {
        nonce,
        max_fee_per_gas: U128(max_fee),
        max_priority_fee_per_gas: U128(priority),
    })
}

fn chain() -> impl Strategy<Value = ChainConfig> {
    prop_oneof![
        Just(ChainConfig {
            chain_id: 8453,
            pool: normalise_address("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5").unwrap(),
            usdc: normalise_address("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").unwrap(),
            max_fee_per_gas_ceiling: U128(u128::MAX),
            max_priority_fee_ceiling: U128(u128::MAX),
            gas_limit_approve: 70_000,
            gas_limit_repay: 350_000,
            gas_limit_transfer: 80_000,
        }),
        Just(ChainConfig {
            chain_id: 42161,
            pool: normalise_address("0x794a61358D6845594F94dc1DB02A252b5b4814aD").unwrap(),
            usdc: normalise_address("0xaf88d065e77c8cC2239327C5EDb3A432268e5831").unwrap(),
            max_fee_per_gas_ceiling: U128(u128::MAX),
            max_priority_fee_ceiling: U128(u128::MAX),
            gas_limit_approve: 500_000,
            gas_limit_repay: 1_500_000,
            gas_limit_transfer: 500_000,
        }),
    ]
}

fn borrower() -> impl Strategy<Value = String> {
    prop::array::uniform20(any::<u8>())
        .prop_filter("not the zero address", |bytes| *bytes != [0u8; 20])
        .prop_map(|bytes| format!("0x{}", hex::encode(bytes)))
}

fn position(chain: &ChainConfig, borrower: String) -> Position {
    Position {
        owner: "owner.near".parse().unwrap(),
        keeper: "keeper.near".parse().unwrap(),
        chain_id: chain.chain_id,
        borrower,
        max_per_rescue: U128(100),
        max_per_day: U128(250),
        cooldown_secs: 0,
        paused: false,
        spent_today: U128(0),
        day: 0,
        last_rescue_at: 0,
        pending_loosen: None,
    }
}

fn address(value: &str) -> Address {
    Address::from(parse_address(value).unwrap())
}

fn decode(unsigned: &[u8]) -> TxEip1559 {
    assert_eq!(unsigned[0], 0x02, "not an EIP-1559 transaction");
    let mut body = &unsigned[1..];
    let tx = TxEip1559::rlp_decode(&mut body).expect("alloy could not decode the transaction");
    assert!(body.is_empty(), "bytes left over after the transaction");
    tx
}

/// The checks every transaction has to pass, whatever it is.
fn assert_decodes_to(
    unsigned: &[u8],
    chain: &ChainConfig,
    fees: &Fees,
    gas_limit: u64,
) -> TxEip1559 {
    let tx = decode(unsigned);
    assert_eq!(tx.chain_id, chain.chain_id);
    assert_eq!(tx.nonce, fees.nonce);
    assert_eq!(tx.max_fee_per_gas, fees.max_fee_per_gas.0);
    assert_eq!(tx.max_priority_fee_per_gas, fees.max_priority_fee_per_gas.0);
    assert_eq!(tx.gas_limit, gas_limit);
    assert!(tx.access_list.0.is_empty());

    // Alloy re-encoding the decoded fields has to land on the same bytes, which
    // also proves the encoding is canonical.
    assert_eq!(tx.encoded_for_signing(), unsigned);

    testing_env!(VMContextBuilder::new().build());
    let hash = signing_hash(unsigned);
    assert_eq!(hash, tx.signature_hash().0);
    assert_eq!(hash, keccak256(unsigned).0);
    tx
}

fn word_address(word: &[u8]) -> Address {
    assert_eq!(&word[..12], [0u8; 12], "dirty address padding");
    Address::from_slice(&word[12..])
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn repay_keeps_target_selector_asset_and_borrower(
        chain in chain(),
        borrower in borrower(),
        amount in wide_u128(),
        fees in fees(),
    ) {
        let position = position(&chain, borrower);
        let unsigned = repay_tx(&chain, &position, amount, &fees).unsigned_bytes();
        let tx = assert_decodes_to(&unsigned, &chain, &fees, chain.gas_limit_repay);

        prop_assert_eq!(tx.to, TxKind::Call(address(&chain.pool)));
        prop_assert_eq!(tx.value, U256::ZERO);
        prop_assert_eq!(tx.input.len(), 132);
        prop_assert_eq!(&tx.input[..4], SELECTOR_REPAY);
        prop_assert_eq!(word_address(&tx.input[4..36]), address(&chain.usdc));
        prop_assert_eq!(U256::from_be_slice(&tx.input[36..68]), U256::from(amount));
        prop_assert_eq!(U256::from_be_slice(&tx.input[68..100]), U256::from(2));
        prop_assert_eq!(word_address(&tx.input[100..132]), address(&position.borrower));
    }

    #[test]
    fn approve_only_ever_names_the_pool(
        chain in chain(),
        amount in wide_u128(),
        fees in fees(),
    ) {
        let unsigned = approve_tx(&chain, amount, &fees).unsigned_bytes();
        let tx = assert_decodes_to(&unsigned, &chain, &fees, chain.gas_limit_approve);

        prop_assert_eq!(tx.to, TxKind::Call(address(&chain.usdc)));
        prop_assert_eq!(tx.value, U256::ZERO);
        prop_assert_eq!(tx.input.len(), 68);
        prop_assert_eq!(&tx.input[..4], SELECTOR_APPROVE);
        prop_assert_eq!(word_address(&tx.input[4..36]), address(&chain.pool));
        prop_assert_eq!(U256::from_be_slice(&tx.input[36..68]), U256::from(amount));
    }

    #[test]
    fn transfer_only_ever_pays_the_borrower(
        chain in chain(),
        borrower in borrower(),
        amount in wide_u128(),
        fees in fees(),
    ) {
        let position = position(&chain, borrower);
        let unsigned = transfer_tx(&chain, &position, amount, &fees).unsigned_bytes();
        let tx = assert_decodes_to(&unsigned, &chain, &fees, chain.gas_limit_transfer);

        prop_assert_eq!(tx.to, TxKind::Call(address(&chain.usdc)));
        prop_assert_eq!(tx.value, U256::ZERO);
        prop_assert_eq!(tx.input.len(), 68);
        prop_assert_eq!(&tx.input[..4], SELECTOR_TRANSFER);
        prop_assert_eq!(word_address(&tx.input[4..36]), address(&position.borrower));
        prop_assert_eq!(U256::from_be_slice(&tx.input[36..68]), U256::from(amount));
    }

    #[test]
    fn sweep_only_ever_pays_the_borrower_and_carries_no_calldata(
        chain in chain(),
        borrower in borrower(),
        amount in wide_u128(),
        fees in fees(),
    ) {
        let position = position(&chain, borrower);
        let unsigned = sweep_tx(&chain, &position, amount, &fees).unsigned_bytes();
        let tx = assert_decodes_to(&unsigned, &chain, &fees, chain.gas_limit_transfer);

        prop_assert_eq!(tx.to, TxKind::Call(address(&position.borrower)));
        prop_assert_eq!(tx.value, U256::from(amount));
        prop_assert!(tx.input.is_empty());
    }
}

#[derive(Clone, Debug)]
enum Op {
    /// Attempt a rescue after waiting this long.
    Rescue { amount: u128, wait_secs: u64 },
    /// The oldest outstanding signature fails.
    FailOldest,
    /// The oldest outstanding signature succeeds, so its charge stands.
    SignOldest,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => (0u128..=120, prop_oneof![0u64..=300, 3_600u64..=90_000])
            .prop_map(|(amount, wait_secs)| Op::Rescue { amount, wait_secs }),
        1 => Just(Op::FailOldest),
        1 => Just(Op::SignOldest),
    ]
}

fn config() -> ChainConfig {
    ChainConfig {
        chain_id: 8453,
        pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5".into(),
        usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913".into(),
        max_fee_per_gas_ceiling: U128(1_000),
        max_priority_fee_ceiling: U128(100),
        gas_limit_approve: 70_000,
        gas_limit_repay: 350_000,
        gas_limit_transfer: 80_000,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Whatever order rescues, signatures and failures arrive in, across any number
    /// of UTC days, a day's charges stay within its budget and the stored counter
    /// agrees with an independent ledger.
    #[test]
    fn the_daily_budget_holds_under_any_interleaving(
        ops in prop::collection::vec(op(), 1..80),
        cooldown_secs in prop_oneof![Just(0u32), 1u32..=120],
    ) {
        let chain = config();
        let mut position = position(&chain, "0x1234567890abcdef1234567890abcdef12345678".into());
        position.cooldown_secs = cooldown_secs;
        let fees = Fees {
            nonce: 0,
            max_fee_per_gas: U128(1_000),
            max_priority_fee_per_gas: U128(100),
        };

        let mut now = 1_794_052_800 * NANOS_PER_SEC;
        position.day = policy::utc_day(now);
        let mut ledger: BTreeMap<u64, u128> = BTreeMap::new();
        let mut outstanding: VecDeque<Reservation> = VecDeque::new();

        for op in ops {
            match op {
                Op::Rescue { amount, wait_secs } => {
                    now += wait_secs * NANOS_PER_SEC;
                    if let Ok(reservation) =
                        policy::check_rescue(&position, &chain, amount, &fees, now)
                    {
                        policy::reserve(&mut position, &reservation);
                        *ledger.entry(reservation.day).or_default() += amount;
                        outstanding.push_back(reservation);
                    }
                }
                Op::FailOldest => {
                    if let Some(reservation) = outstanding.pop_front() {
                        let released = policy::release(&mut position, &reservation);
                        *ledger.get_mut(&reservation.day).unwrap() -= released;
                    }
                }
                Op::SignOldest => {
                    outstanding.pop_front();
                }
            }

            for (day, charged) in &ledger {
                prop_assert!(*charged <= position.max_per_day.0, "day {day} is over budget");
            }
            let stored = position.spent_today.0;
            prop_assert_eq!(stored, ledger.get(&position.day).copied().unwrap_or(0));
            prop_assert!(position.day <= now / NANOS_PER_DAY);
        }
    }
}
