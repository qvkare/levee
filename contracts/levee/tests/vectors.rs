//! Asserts the Rust encoder matches Foundry's `cast` byte for byte.
//!
//! `fixtures/tx_vectors.json` comes from `fixtures/generate.sh`, which shares no
//! code with the contract.

use std::collections::BTreeSet;

use levee::address::normalise_address;
use levee::evm::{signing_hash, Eip1559Tx};
use levee::txs::{approve_tx, repay_tx, sweep_tx, transfer_tx, unwind_tx};
use levee::types::{ChainConfig, CollateralConfig, Fees, Position};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use serde::Deserialize;

const VECTORS: &str = include_str!("../fixtures/tx_vectors.json");

#[derive(Deserialize)]
struct Fixture {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    kind: String,
    chain_id: u64,
    pool: String,
    usdc: String,
    unwind: String,
    collateral: String,
    pool_fee: u32,
    /// Collateral base units. "0" for every kind but `unwind`, which is the only one
    /// that takes it.
    max_sold: String,
    borrower: String,
    nonce: u64,
    max_fee_per_gas: String,
    max_priority_fee_per_gas: String,
    gas_limit: u64,
    amount: String,
    to: String,
    value: String,
    calldata: String,
    unsigned_tx: String,
    signing_hash: String,
}

impl Vector {
    /// The transaction the contract builds from the same inputs cast had.
    fn built_tx(&self) -> Eip1559Tx {
        let chain = ChainConfig {
            chain_id: self.chain_id,
            pool: normalise_address(&self.pool).unwrap(),
            usdc: normalise_address(&self.usdc).unwrap(),
            unwind: normalise_address(&self.unwind).unwrap(),
            max_fee_per_gas_ceiling: U128(u128::MAX),
            max_priority_fee_ceiling: U128(u128::MAX),
            gas_limit_approve: self.gas_limit,
            gas_limit_repay: self.gas_limit,
            gas_limit_transfer: self.gas_limit,
            gas_limit_unwind: self.gas_limit,
        };
        let collateral = CollateralConfig {
            asset: normalise_address(&self.collateral).unwrap(),
            pool_fee: self.pool_fee,
        };
        let position = Position {
            owner: "owner.near".parse().unwrap(),
            keeper: "keeper.near".parse().unwrap(),
            chain_id: self.chain_id,
            borrower: normalise_address(&self.borrower).unwrap(),
            collateral: Some(collateral.clone()),
            max_per_rescue: U128(0),
            max_per_day: U128(0),
            cooldown_secs: 0,
            paused: false,
            spent_today: U128(0),
            day: 0,
            last_rescue_at: 0,
            pending_loosen: None,
        };
        let fees = Fees {
            nonce: self.nonce,
            max_fee_per_gas: U128(self.max_fee_per_gas.parse().unwrap()),
            max_priority_fee_per_gas: U128(self.max_priority_fee_per_gas.parse().unwrap()),
        };
        let amount: u128 = self.amount.parse().unwrap();
        let max_sold: u128 = self.max_sold.parse().unwrap();
        match self.kind.as_str() {
            "repay" => repay_tx(&chain, &position, amount, &fees),
            "approve" => approve_tx(&chain, amount, &fees),
            "transfer" => transfer_tx(&chain, &position, amount, &fees),
            "value" => sweep_tx(&chain, &position, amount, &fees),
            "unwind" => unwind_tx(&chain, &position, &collateral, amount, max_sold, &fees),
            other => panic!("unknown kind {other}"),
        }
    }
}

fn vectors() -> Vec<Vector> {
    serde_json::from_str::<Fixture>(VECTORS).unwrap().vectors
}

fn hex_of(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

#[test]
fn fixture_covers_every_kind_on_both_chains() {
    let seen: BTreeSet<(String, u64)> = vectors()
        .iter()
        .map(|v| (v.kind.clone(), v.chain_id))
        .collect();
    for chain_id in [8453, 42161] {
        for kind in ["approve", "repay", "transfer", "value", "unwind"] {
            assert!(
                seen.contains(&(kind.to_string(), chain_id)),
                "no vector for {kind} on {chain_id}"
            );
        }
    }
}

/// Every fee tier the contract accepts is encoded at least once.
#[test]
fn fixture_covers_every_fee_tier() {
    let tiers: BTreeSet<u32> = vectors()
        .iter()
        .filter(|v| v.kind == "unwind")
        .map(|v| v.pool_fee)
        .collect();
    assert_eq!(tiers, BTreeSet::from(levee::policy::POOL_FEES));
}

#[test]
fn target_and_value_match_cast() {
    for vector in vectors() {
        let tx = vector.built_tx();
        assert_eq!(
            hex_of(&tx.to),
            vector.to.to_lowercase(),
            "target of {}",
            vector.name
        );
        assert_eq!(
            tx.value.to_string(),
            vector.value,
            "value of {}",
            vector.name
        );
    }
}

#[test]
fn calldata_matches_cast() {
    for vector in vectors() {
        assert_eq!(
            hex_of(&vector.built_tx().data),
            vector.calldata,
            "calldata differs for {}",
            vector.name
        );
    }
}

#[test]
fn unsigned_tx_matches_cast() {
    for vector in vectors() {
        assert_eq!(
            hex_of(&vector.built_tx().unsigned_bytes()),
            vector.unsigned_tx,
            "unsigned tx differs for {}",
            vector.name
        );
    }
}

#[test]
fn signing_hash_matches_cast() {
    testing_env!(VMContextBuilder::new().build());
    for vector in vectors() {
        let hash = signing_hash(&vector.built_tx().unsigned_bytes());
        assert_eq!(
            hex_of(&hash),
            vector.signing_hash,
            "signing hash differs for {}",
            vector.name
        );
    }
}
