//! Asserts the Rust encoder matches Foundry's `cast` byte for byte.
//!
//! `fixtures/tx_vectors.json` comes from `fixtures/generate.sh`, which shares no
//! code with the contract.

use std::collections::BTreeSet;

use levee::address::parse_address;
use levee::evm::{
    approve_calldata, repay_calldata, signing_hash, transfer_calldata, Eip1559Tx,
};
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
    fn amount(&self) -> u128 {
        self.amount.parse().unwrap()
    }

    /// Calldata the way the contract builds it, from the same inputs cast had.
    fn built_calldata(&self) -> Vec<u8> {
        let pool = parse_address(&self.pool).unwrap();
        let usdc = parse_address(&self.usdc).unwrap();
        let borrower = parse_address(&self.borrower).unwrap();
        match self.kind.as_str() {
            "repay" => repay_calldata(&usdc, self.amount(), &borrower),
            "approve" => approve_calldata(&pool, self.amount()),
            "transfer" => transfer_calldata(&borrower, self.amount()),
            "value" => Vec::new(),
            other => panic!("unknown kind {other}"),
        }
    }

    fn built_tx(&self) -> Eip1559Tx {
        Eip1559Tx {
            chain_id: self.chain_id,
            nonce: self.nonce,
            max_priority_fee_per_gas: self.max_priority_fee_per_gas.parse().unwrap(),
            max_fee_per_gas: self.max_fee_per_gas.parse().unwrap(),
            gas_limit: self.gas_limit,
            to: parse_address(&self.to).unwrap(),
            value: self.value.parse().unwrap(),
            data: self.built_calldata(),
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
        for kind in ["approve", "repay", "transfer", "value"] {
            assert!(
                seen.contains(&(kind.to_string(), chain_id)),
                "no vector for {kind} on {chain_id}"
            );
        }
    }
}

#[test]
fn calldata_matches_cast() {
    for vector in vectors() {
        assert_eq!(
            hex_of(&vector.built_calldata()),
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
