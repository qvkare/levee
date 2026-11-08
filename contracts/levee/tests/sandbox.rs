//! Integration tests. The real wasm runs in near-sandbox 2.14.0, which is the nearcore
//! commit, protocol version and runtime config mainnet runs, against the mock signer.
//!
//! The test process plays the MPC node. It reads each open request, signs it with a
//! key derived the way the real network derives it, and calls `respond`, so these
//! tests carry real signatures all the way to an assembled EVM transaction.
//!
//! Build first with `contracts/build.sh`. A wasm older than its source is refused,
//! so these tests cannot pass against code that is not the code in the tree.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::task::Poll;
use std::time::{Duration, Instant, SystemTime};

use alloy_consensus::transaction::RlpEcdsaDecodableTx;
use alloy_consensus::{SignableTransaction, TxEip1559};
use alloy_primitives::{keccak256, Address, Signature as EvmSignature, TxKind, U256};
use k256::ecdsa::{SigningKey, VerifyingKey};
use k256::elliptic_curve::PrimeField;
use k256::{NonZeroScalar, Scalar};
use levee::events::{SignKind, SignedTx};
use levee::types::{ChainConfig, Position, PreviewTx};
use levee::{MIN_SIGNING_GAS, ON_SIGNED_GAS, SIGN_GAS};
use near_sdk::json_types::U128;
use near_workspaces::network::{Sandbox, ValidatorKey};
use near_workspaces::operations::CallTransaction;
use near_workspaces::operations::TransactionStatus;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{AccessKey, Account, Contract, Worker};
use serde::Deserialize;
use serde_json::{json, Value};
use sha3::{Digest, Sha3_256};

const BASE: u64 = 8453;
const ARBITRUM: u64 = 42161;
const BASE_POOL: &str = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
const BASE_USDC: &str = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BORROWER: &str = "0x1234567890abcdef1234567890abcdef12345678";
/// Stands in for the LeveeUnwind helper on Base. The contract only encodes it.
const BASE_UNWIND: &str = "0x5555555555555555555555555555555555555555";
const BASE_WETH: &str = "0x4200000000000000000000000000000000000006";
const POOL_FEE: u32 = 500;
/// Not measured yet. Spec section 9 expects 350k to 600k.
const GAS_LIMIT_UNWIND: u64 = 600_000;
/// The keeper's cap on the collateral an unwind may sell, in WETH wei.
const MAX_SOLD: u128 = 52_000_000_000_000_000;

const MAX_FEE_CEILING: u128 = 2_000_000_000;
const PRIORITY_CEILING: u128 = 100_000_000;

/// Yoctonear per byte, on mainnet and here.
const STORAGE_BYTE_COST: u128 = 10_000_000_000_000_000_000;

const HOUR: u64 = 3_600 * 1_000_000_000;
const DAY: u64 = 24 * HOUR;

/// What a keeper attaches. Well above the minimum, as in production.
const CALL_GAS: Gas = Gas::from_tgas(100);

#[derive(Clone, Copy)]
struct Caps {
    max_per_rescue: u128,
    max_per_day: u128,
    cooldown_secs: u32,
}

const CAPS: Caps = Caps {
    max_per_rescue: 1_000_000,
    max_per_day: 2_500_000,
    cooldown_secs: 0,
};

fn near_time_warp_config() -> near_sandbox::SandboxConfig {
    near_sandbox::SandboxConfig {
        additional_accounts: vec![near_sandbox::GenesisAccount::default_with_name(
            "registrar".parse().unwrap(),
        )],
        // nearcore moves the clock by the mean of the block delays for each block
        // fast-forwarded. This makes that about an hour, without slowing real blocks.
        additional_config: Some(json!({
            "consensus": { "max_block_production_delay": { "secs": 7_200, "nanos": 0 } }
        })),
        ..Default::default()
    }
}

/// `path` as built by `build.sh`, or a failure saying why it cannot be trusted.
fn wasm(crate_dir: &str, file: &str) -> Vec<u8> {
    let contracts = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let path = contracts.join("target/near").join(file);
    let built = std::fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .unwrap_or_else(|_| panic!("{} is missing: run contracts/build.sh", path.display()));
    let newest_source = newest_file(&contracts.join(crate_dir).join("src"));
    assert!(
        built >= newest_source,
        "{} is older than its source: run contracts/build.sh",
        path.display()
    );
    std::fs::read(path).unwrap()
}

fn newest_file(dir: &PathBuf) -> SystemTime {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().metadata().unwrap().modified().unwrap())
        .max()
        .unwrap()
}

/// Plays the MPC network. Keys derive as they do on the real network: the root plus
/// a tweak of sha3-256 over the predecessor and path, so each path has its own address.
struct MpcNode {
    root: Scalar,
}

impl MpcNode {
    fn new() -> Self {
        let digest: [u8; 32] = Sha3_256::digest(b"levee test root, not a real key").into();
        Self {
            root: Option::from(Scalar::from_repr(digest.into())).unwrap(),
        }
    }

    fn key(&self, predecessor: &str, path: &str) -> SigningKey {
        let derivation =
            format!("near-mpc-recovery v0.1.0 epsilon derivation:{predecessor},{path}");
        let digest: [u8; 32] = Sha3_256::digest(derivation.as_bytes()).into();
        let tweak: Scalar = Option::from(Scalar::from_repr(digest.into())).unwrap();
        let derived: NonZeroScalar = Option::from(NonZeroScalar::new(self.root + tweak)).unwrap();
        SigningKey::from(derived)
    }

    fn rescuer(&self, predecessor: &str, path: &str) -> Address {
        evm_address(self.key(predecessor, path).verifying_key())
    }

    /// The response the real `sign` returns, in its wire format.
    fn sign(&self, predecessor: &str, path: &str, payload: &str) -> Value {
        let hash = hex::decode(payload).unwrap();
        let (signature, recovery) = self
            .key(predecessor, path)
            .sign_prehash_recoverable(&hash)
            .unwrap();
        let (r, s) = signature.split_bytes();
        let mut big_r = vec![if recovery.is_y_odd() { 0x03 } else { 0x02 }];
        big_r.extend_from_slice(&r);
        json!({
            "scheme": "Secp256k1",
            "big_r": { "affine_point": hex::encode(big_r) },
            "s": { "scalar": hex::encode(s) },
            "recovery_id": recovery.to_byte(),
        })
    }
}

fn evm_address(key: &VerifyingKey) -> Address {
    let point = key.to_encoded_point(false);
    Address::from_slice(&keccak256(&point.as_bytes()[1..])[12..])
}

#[derive(Deserialize)]
struct SignerRequest {
    predecessor: String,
    path: String,
    domain_id: u64,
    payload: String,
    deposit: U128,
    prepaid_gas_tgas: u64,
    open: bool,
}

fn fees(nonce: u64) -> Value {
    json!({
        "nonce": nonce,
        "max_fee_per_gas": "1000000000",
        "max_priority_fee_per_gas": "1000000",
    })
}

fn chain(chain_id: u64, pool: &str, usdc: &str, unwind: &str) -> ChainConfig {
    ChainConfig {
        chain_id,
        pool: pool.into(),
        usdc: usdc.into(),
        unwind: unwind.into(),
        max_fee_per_gas_ceiling: U128(MAX_FEE_CEILING),
        max_priority_fee_ceiling: U128(PRIORITY_CEILING),
        gas_limit_approve: 70_000,
        gas_limit_repay: 350_000,
        gas_limit_transfer: 80_000,
        gas_limit_unwind: GAS_LIMIT_UNWIND,
    }
}

fn chains() -> Vec<ChainConfig> {
    vec![
        chain(
            BASE,
            "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
            "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            BASE_UNWIND,
        ),
        chain(
            ARBITRUM,
            "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
            "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
            "0x6666666666666666666666666666666666666666",
        ),
    ]
}

fn collateral() -> Value {
    json!({ "asset": BASE_WETH, "pool_fee": POOL_FEE })
}

/// A chain with both contracts deployed and one each of the people involved.
struct Harness {
    worker: Worker<Sandbox>,
    // Owns the warped sandbox process. It stops when this drops.
    _warped: Option<near_sandbox::Sandbox>,
    levee: Contract,
    signer: Contract,
    owner: Account,
    keeper: Account,
    stranger: Account,
    mpc: MpcNode,
}

impl Harness {
    /// Fast-forwarding moves the clock by about an hour a block.
    async fn warped() -> anyhow::Result<Self> {
        let sandbox =
            near_sandbox::Sandbox::start_sandbox_with_config(near_time_warp_config()).await?;
        let worker = near_workspaces::sandbox()
            .rpc_addr(&sandbox.rpc_addr)
            .validator_key(ValidatorKey::HomeDir(sandbox.home_dir.path().to_path_buf()))
            .await?;
        Self::deploy(worker, Some(sandbox), chains()).await
    }

    /// Fast-forwarding moves the clock by about 0.3 seconds a block, as on a normal
    /// sandbox, so a yield can time out without the UTC day moving.
    async fn unwarped() -> anyhow::Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        Self::deploy(worker, None, chains()).await
    }

    async fn deploy(
        worker: Worker<Sandbox>,
        warped: Option<near_sandbox::Sandbox>,
        chains: Vec<ChainConfig>,
    ) -> anyhow::Result<Self> {
        let signer = worker
            .dev_deploy(&wasm("mock-signer", "mock_signer/mock_signer.wasm"))
            .await?;
        let levee = worker
            .dev_deploy(&wasm("levee", "levee/levee.wasm"))
            .await?;
        levee
            .call("new")
            .args_json(json!({ "mpc_contract": signer.id(), "chains": chains }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?
            .into_result()?;
        Ok(Self {
            owner: worker.dev_create_account().await?,
            keeper: worker.dev_create_account().await?,
            stranger: worker.dev_create_account().await?,
            worker,
            _warped: warped,
            levee,
            signer,
            mpc: MpcNode::new(),
        })
    }

    /// A position with no collateral config, as every v0.1 position was. The JSON
    /// leaves `collateral` out, so this is also what an old caller sends.
    async fn register(&self, caps: Caps) -> anyhow::Result<u64> {
        self.register_json(caps, None).await
    }

    async fn register_with_collateral(&self, caps: Caps) -> anyhow::Result<u64> {
        self.register_json(caps, Some(collateral())).await
    }

    async fn register_json(&self, caps: Caps, collateral: Option<Value>) -> anyhow::Result<u64> {
        let mut args = json!({
            "chain_id": BASE,
            "borrower": BORROWER,
            "keeper": self.keeper.id(),
            "max_per_rescue": caps.max_per_rescue.to_string(),
            "max_per_day": caps.max_per_day.to_string(),
            "cooldown_secs": caps.cooldown_secs,
        });
        if let Some(collateral) = collateral {
            args["collateral"] = collateral;
        }
        let outcome = self
            .owner
            .call(self.levee.id(), "register")
            .args_json(args)
            .deposit(NearToken::from_millinear(100))
            .gas(CALL_GAS)
            .transact()
            .await?
            .into_result()?;
        Ok(outcome.json()?)
    }

    fn rescue(&self, caller: &Account, id: u64, amount: u128, nonce: u64) -> CallTransaction {
        self.keeper_call(caller, "rescue", id, amount, nonce)
    }

    fn unwind(&self, caller: &Account, id: u64, amount: u128, nonce: u64) -> CallTransaction {
        self.keeper_call(caller, "rescue_from_collateral", id, amount, nonce)
    }

    /// `rescue_from_collateral` also takes the keeper's `max_sold`.
    fn keeper_call(
        &self,
        caller: &Account,
        method: &str,
        id: u64,
        amount: u128,
        nonce: u64,
    ) -> CallTransaction {
        let mut args = json!({ "id": id, "amount": amount.to_string(), "fees": fees(nonce) });
        if method == "rescue_from_collateral" {
            args["max_sold"] = json!(MAX_SOLD.to_string());
        }
        caller
            .call(self.levee.id(), method)
            .args_json(args)
            .gas(CALL_GAS)
    }

    fn owner_call(&self, method: &str, args: Value) -> CallTransaction {
        self.owner
            .call(self.levee.id(), method)
            .args_json(args)
            .gas(CALL_GAS)
    }

    async fn position(&self, id: u64) -> anyhow::Result<Position> {
        let position: Option<Position> = self
            .levee
            .view("get_position")
            .args_json(json!({ "id": id }))
            .await?
            .json()?;
        Ok(position.expect("position exists"))
    }

    async fn requests(&self) -> anyhow::Result<Vec<SignerRequest>> {
        Ok(self.signer.view("requests").await?.json()?)
    }

    async fn request(&self, index: usize) -> anyhow::Result<SignerRequest> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let mut requests = self.requests().await?;
            if requests.len() > index {
                return Ok(requests.swap_remove(index));
            }
            anyhow::ensure!(
                Instant::now() < deadline,
                "the signer never saw request {index}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Plays the node: signs request `index` and delivers the response.
    async fn answer(&self, index: usize) -> anyhow::Result<()> {
        let request = self.request(index).await?;
        let response = self
            .mpc
            .sign(&request.predecessor, &request.path, &request.payload);
        self.respond(index, response).await
    }

    async fn respond(&self, index: usize, response: Value) -> anyhow::Result<()> {
        self.signer
            .call("respond")
            .args_json(json!({ "index": index, "response": response }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// Sends `call`, answers the signature request it causes, and returns the outcome.
    async fn signed(&self, call: CallTransaction) -> anyhow::Result<ExecutionFinalResult> {
        let index = self.requests().await?.len();
        let status = call.transact_async().await?;
        self.answer(index).await?;
        finish(status).await
    }

    fn rescuer(&self, id: u64) -> Address {
        self.mpc
            .rescuer(self.levee.id().as_str(), &format!("levee/v1/{id}"))
    }

    async fn now(&self) -> anyhow::Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }

    /// Moves the chain clock to at least `target`. Blocks near an epoch boundary
    /// advance less, so this goes by the clock and not by a count of blocks.
    async fn warp_to(&self, target: u64) -> anyhow::Result<()> {
        while self.now().await? < target {
            self.worker.fast_forward(1).await?;
        }
        Ok(())
    }

    /// Moves to just after the next UTC midnight, so that nothing that follows can
    /// straddle one by accident of when the test ran.
    async fn warp_to_start_of_day(&self) -> anyhow::Result<()> {
        let now = self.now().await?;
        self.warp_to((now / DAY + 1) * DAY).await
    }
}

async fn finish(status: TransactionStatus) -> anyhow::Result<ExecutionFinalResult> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Poll::Ready(result) = status.status().await? {
            return Ok(result);
        }
        anyhow::ensure!(Instant::now() < deadline, "transaction never finished");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn assert_rejected(outcome: &ExecutionFinalResult, message: &str) {
    assert!(outcome.is_failure(), "expected a rejection: {message}");
    let failures = format!("{:?}", outcome.failures());
    assert!(
        failures.contains(message),
        "expected {message:?} in {failures}"
    );
}

fn returned(outcome: &ExecutionFinalResult) -> anyhow::Result<Option<SignedTx>> {
    Ok(outcome.clone().json()?)
}

fn events(outcome: &ExecutionFinalResult) -> Vec<Value> {
    outcome
        .logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| serde_json::from_str(json).unwrap())
        .collect()
}

fn event(outcome: &ExecutionFinalResult, name: &str) -> Value {
    events(outcome)
        .into_iter()
        .find(|event| event["event"] == name)
        .unwrap_or_else(|| panic!("no {name} event in {:?}", outcome.logs()))
}

/// Puts the transaction back together from the callback's output alone, as anyone
/// reading the event could, and returns it with the address it recovers to.
fn assemble(signed: &SignedTx) -> (TxEip1559, Address) {
    let unsigned = hex::decode(signed.unsigned_tx.trim_start_matches("0x")).unwrap();
    assert_eq!(unsigned[0], 0x02);
    let tx = TxEip1559::rlp_decode(&mut &unsigned[1..]).unwrap();
    assert_eq!(
        format!("{:?}", tx.signature_hash()),
        signed.tx_hash,
        "tx_hash is not the hash of unsigned_tx"
    );

    let big_r = hex::decode(signed.big_r.trim_start_matches("0x")).unwrap();
    let s = hex::decode(signed.s.trim_start_matches("0x")).unwrap();
    let signature = EvmSignature::new(
        U256::from_be_slice(&big_r[1..33]),
        U256::from_be_slice(&s),
        signed.recovery_id == 1,
    );
    let from = tx.clone().into_signed(signature).recover_signer().unwrap();
    (tx, from)
}

fn word_address(word: &[u8]) -> Address {
    assert_eq!(word[..12], [0u8; 12]);
    Address::from_slice(&word[12..])
}

fn parse_address(value: &str) -> Address {
    value.parse().unwrap()
}

#[tokio::test]
async fn happy_path_a_rescue_ends_in_a_transaction_from_the_rescuer() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;

    let outcome = h.signed(h.rescue(&h.keeper, id, 750_000, 3)).await?;
    assert!(outcome.is_success(), "{:?}", outcome.failures());
    let signed = returned(&outcome)?;
    let signed = signed.expect("a signature came back");
    assert_eq!(signed.kind, SignKind::Rescue);
    assert_eq!(signed.id, id);

    // The event carries the same thing, so a third party can broadcast it.
    let logged = event(&outcome, "rescue_signed");
    assert_eq!(logged["standard"], "levee");
    assert_eq!(logged["version"], "1.0.0");
    assert_eq!(logged["data"], serde_json::to_value(&signed)?);
    let requested = event(&outcome, "rescue_requested");
    assert_eq!(requested["data"]["amount"], "750000");
    assert_eq!(requested["data"]["nonce"], 3);

    // The signer saw what the spec says it must.
    let request = h.request(0).await?;
    assert_eq!(request.predecessor, h.levee.id().as_str());
    assert_eq!(request.path, format!("levee/v1/{id}"));
    assert_eq!(request.domain_id, 0);
    assert_eq!(request.deposit, U128(1));
    assert_eq!(format!("0x{}", request.payload), signed.tx_hash);
    assert!(!request.open);

    // The assembled transaction recovers to the position's rescuer, and says only
    // what the contract allows.
    let (tx, from) = assemble(&signed);
    assert_eq!(from, h.rescuer(id));
    assert_eq!(tx.chain_id, BASE);
    assert_eq!(tx.nonce, 3);
    assert_eq!(tx.gas_limit, 350_000);
    assert_eq!(tx.to, TxKind::Call(parse_address(BASE_POOL)));
    assert_eq!(tx.value, U256::ZERO);
    assert_eq!(tx.input[..4], [0x57, 0x3a, 0xde, 0x81]);
    assert_eq!(word_address(&tx.input[4..36]), parse_address(BASE_USDC));
    assert_eq!(U256::from_be_slice(&tx.input[36..68]), U256::from(750_000));
    assert_eq!(U256::from_be_slice(&tx.input[68..100]), U256::from(2));
    assert_eq!(word_address(&tx.input[100..132]), parse_address(BORROWER));

    let position = h.position(id).await?;
    assert_eq!(position.spent_today, U128(750_000));
    assert!(position.last_rescue_at > 0);
    Ok(())
}

#[tokio::test]
async fn each_position_has_its_own_rescuer() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let first = h.register(CAPS).await?;
    let second = h.register(CAPS).await?;

    let one: Option<SignedTx> = h.signed(h.rescue(&h.keeper, first, 1, 0)).await?.json()?;
    let two: Option<SignedTx> = h.signed(h.rescue(&h.keeper, second, 1, 0)).await?.json()?;
    let (_, from_one) = assemble(&one.unwrap());
    let (_, from_two) = assemble(&two.unwrap());
    assert_eq!(from_one, h.rescuer(first));
    assert_eq!(from_two, h.rescuer(second));
    assert_ne!(from_one, from_two);
    Ok(())
}

#[tokio::test]
async fn signature_failure_releases_the_budget_and_allows_a_retry() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h
        .register(Caps {
            cooldown_secs: 86_400,
            ..CAPS
        })
        .await?;

    h.signer
        .call("set_failing")
        .args_json(json!({ "failing": true }))
        .transact()
        .await?
        .into_result()?;

    let outcome = h.rescue(&h.keeper, id, 1_000_000, 0).transact().await?;
    // The transaction itself succeeds, or the release would be rolled back with it.
    assert!(outcome.is_success(), "{:?}", outcome.failures());
    let result = returned(&outcome)?;
    assert_eq!(result, None);
    let failed = event(&outcome, "rescue_failed");
    assert_eq!(failed["data"]["reason"], "mpc_failed");
    assert_eq!(failed["data"]["released"], "1000000");
    assert_eq!(failed["data"]["kind"], "rescue");

    let position = h.position(id).await?;
    assert_eq!(position.spent_today, U128(0));
    assert_eq!(position.last_rescue_at, 0);

    // A day-long cooldown does not stand in the way of the retry.
    h.signer
        .call("set_failing")
        .args_json(json!({ "failing": false }))
        .transact()
        .await?
        .into_result()?;
    let retry = h.signed(h.rescue(&h.keeper, id, 1_000_000, 0)).await?;
    let signed: Option<SignedTx> = retry.json()?;
    assert!(signed.is_some());
    assert_eq!(h.position(id).await?.spent_today, U128(1_000_000));
    Ok(())
}

#[tokio::test]
async fn a_real_yield_timeout_releases_the_budget() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;

    let status = h.rescue(&h.keeper, id, 500_000, 0).transact_async().await?;
    h.request(0).await?;
    assert_eq!(h.position(id).await?.spent_today, U128(500_000));

    // Nobody responds. The protocol's 200 block timeout does the rest.
    h.worker.fast_forward(200).await?;
    let outcome = finish(status).await?;
    assert!(outcome.is_success(), "{:?}", outcome.failures());
    let result = returned(&outcome)?;
    assert_eq!(result, None);
    let failed = event(&outcome, "rescue_failed");
    assert_eq!(failed["data"]["reason"], "mpc_failed");
    assert_eq!(failed["data"]["released"], "500000");
    assert_eq!(h.position(id).await?.spent_today, U128(0));
    Ok(())
}

#[tokio::test]
async fn a_late_response_after_the_timeout_is_refused() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;
    let status = h.rescue(&h.keeper, id, 1, 0).transact_async().await?;
    h.request(0).await?;
    h.worker.fast_forward(200).await?;
    assert_eq!(returned(&finish(status).await?)?, None);
    assert!(h.answer(0).await.is_err());
    Ok(())
}

#[tokio::test]
async fn an_unreadable_response_keeps_the_budget_charged() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;
    let status = h.rescue(&h.keeper, id, 500_000, 0).transact_async().await?;
    h.request(0).await?;
    h.respond(0, json!({ "scheme": "Ed25519", "signature": [1, 2, 3] }))
        .await?;
    let outcome = finish(status).await?;

    assert!(outcome.is_success(), "{:?}", outcome.failures());
    let result = returned(&outcome)?;
    assert_eq!(result, None);
    let failed = event(&outcome, "rescue_failed");
    assert_eq!(failed["data"]["reason"], "malformed_response");
    assert_eq!(failed["data"]["released"], "0");
    assert_eq!(h.position(id).await?.spent_today, U128(500_000));
    Ok(())
}

#[tokio::test]
async fn a_failure_after_midnight_gives_nothing_back_to_the_new_day() -> anyhow::Result<()> {
    let h = Harness::warped().await?;
    let id = h
        .register(Caps {
            max_per_rescue: 1_000,
            max_per_day: 1_000,
            cooldown_secs: 0,
        })
        .await?;

    let first = h.rescue(&h.keeper, id, 1_000, 0).transact_async().await?;
    h.request(0).await?;

    // The first signature is still out when the day turns and a second rescue lands.
    h.warp_to_start_of_day().await?;
    let second = h.signed(h.rescue(&h.keeper, id, 400, 1)).await?;
    assert!(second.is_success(), "{:?}", second.failures());
    assert_eq!(h.position(id).await?.spent_today, U128(400));

    // Subtracting the old charge from the new bucket would report 400 released.
    h.worker.fast_forward(200).await?;
    let failed = finish(first).await?;
    assert_eq!(event(&failed, "rescue_failed")["data"]["released"], "0");
    Ok(())
}

#[tokio::test]
async fn concurrent_rescues_cannot_spend_the_same_budget() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h
        .register(Caps {
            max_per_rescue: 1_000,
            max_per_day: 1_500,
            cooldown_secs: 0,
        })
        .await?;

    // Both are in flight. The second must already see the first's reservation.
    let first = h.rescue(&h.keeper, id, 1_000, 0).transact_async().await?;
    h.request(0).await?;
    let over = h.rescue(&h.keeper, id, 501, 1).transact().await?;
    assert_rejected(&over, "amount exceeds the daily budget");
    let second = h.rescue(&h.keeper, id, 500, 1).transact_async().await?;
    h.request(1).await?;
    assert_eq!(h.position(id).await?.spent_today, U128(1_500));

    h.answer(0).await?;
    h.answer(1).await?;
    assert!(finish(first).await?.is_success());
    assert!(finish(second).await?.is_success());
    assert_eq!(h.position(id).await?.spent_today, U128(1_500));
    Ok(())
}

#[tokio::test]
async fn the_wrong_caller_is_rejected() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;

    let stranger = h.rescue(&h.stranger, id, 1, 0).transact().await?;
    assert_rejected(&stranger, "caller is not the keeper");
    let owner = h.rescue(&h.owner, id, 1, 0).transact().await?;
    assert_rejected(&owner, "caller is not the keeper");

    let owner_only = [
        ("set_keeper", json!({ "id": id, "keeper": h.stranger.id() })),
        ("pause", json!({ "id": id })),
        ("resume", json!({ "id": id })),
        ("apply_loosen", json!({ "id": id })),
        (
            "tighten",
            json!({ "id": id, "max_per_rescue": "1", "max_per_day": "1", "cooldown_secs": 0 }),
        ),
        (
            "queue_loosen",
            json!({ "id": id, "max_per_rescue": "2", "max_per_day": "2", "cooldown_secs": 0 }),
        ),
        (
            "withdraw_float",
            json!({ "id": id, "amount": "1", "fees": fees(0) }),
        ),
        (
            "sweep_gas",
            json!({ "id": id, "amount_wei": "1", "fees": fees(0) }),
        ),
    ];
    for (method, args) in owner_only {
        let outcome = h
            .keeper
            .call(h.levee.id(), method)
            .args_json(args)
            .gas(CALL_GAS)
            .transact()
            .await?;
        assert_rejected(&outcome, "caller is not the owner");
    }

    assert!(
        h.requests().await?.is_empty(),
        "something reached the signer"
    );
    assert_eq!(h.position(id).await?.spent_today, U128(0));
    Ok(())
}

#[tokio::test]
async fn nobody_can_call_the_callback_or_initialise_again() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;
    let signed = h.signed(h.rescue(&h.keeper, id, 500_000, 0)).await?;
    assert!(signed.is_success());

    let forged = json!({
        "pending": {
            "kind": "rescue",
            "id": id,
            "unsigned_tx": "0x",
            "tx_hash": "0x",
            "reservation": { "amount": "500000", "day": 0, "at": 0, "previous_at": 0 },
        }
    });
    let outcome = h
        .keeper
        .call(h.levee.id(), "on_signed")
        .args_json(forged)
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert_rejected(&outcome, "is private");
    assert_eq!(h.position(id).await?.spent_today, U128(500_000));

    let reinit = json!({ "mpc_contract": h.stranger.id(), "chains": chains() });
    let by_stranger = h
        .stranger
        .call(h.levee.id(), "new")
        .args_json(&reinit)
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert_rejected(&by_stranger, "is private");
    let by_itself = h
        .levee
        .call("new")
        .args_json(&reinit)
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert_rejected(&by_itself, "already been initialized");
    Ok(())
}

#[tokio::test]
async fn a_stranger_cannot_initialise_a_fresh_deployment() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let levee = worker
        .dev_deploy(&wasm("levee", "levee/levee.wasm"))
        .await?;
    let attacker = worker.dev_create_account().await?;
    let outcome = attacker
        .call(levee.id(), "new")
        .args_json(json!({ "mpc_contract": attacker.id(), "chains": chains() }))
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert_rejected(&outcome, "is private");
    Ok(())
}

#[tokio::test]
async fn a_paused_position_cannot_rescue() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;

    let paused = h
        .owner_call("pause", json!({ "id": id }))
        .transact()
        .await?;
    assert_eq!(event(&paused, "paused")["data"]["id"], id);
    let outcome = h.rescue(&h.keeper, id, 1, 0).transact().await?;
    assert_rejected(&outcome, "position is paused");

    // Approvals are owner only, so a keeper key cannot spend rescuer gas on them.
    let allowance = h
        .keeper
        .call(h.levee.id(), "prepare_allowance")
        .args_json(json!({ "id": id, "amount": "1", "fees": fees(0) }))
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert_rejected(&allowance, "caller is not the owner");

    // The owner can still leave.
    let withdrawn = h
        .signed(h.owner_call(
            "withdraw_float",
            json!({ "id": id, "amount": "1", "fees": fees(0) }),
        ))
        .await?;
    assert!(withdrawn.is_success(), "{:?}", withdrawn.failures());

    let resumed = h
        .owner_call("resume", json!({ "id": id }))
        .transact()
        .await?;
    assert_eq!(event(&resumed, "resumed")["data"]["id"], id);
    let rescued = h.signed(h.rescue(&h.keeper, id, 1, 0)).await?;
    assert!(rescued.is_success(), "{:?}", rescued.failures());
    Ok(())
}

#[tokio::test]
async fn the_cooldown_holds_until_it_has_elapsed() -> anyhow::Result<()> {
    let h = Harness::warped().await?;
    h.warp_to_start_of_day().await?;
    let id = h
        .register(Caps {
            cooldown_secs: 2 * 3_600,
            ..CAPS
        })
        .await?;

    let first = h.signed(h.rescue(&h.keeper, id, 1, 0)).await?;
    assert!(first.is_success(), "{:?}", first.failures());
    let at = h.position(id).await?.last_rescue_at;

    let early = h.rescue(&h.keeper, id, 1, 1).transact().await?;
    assert_rejected(&early, "cooldown has not elapsed");

    // Most of the way through, still refused.
    h.worker.fast_forward(1).await?;
    assert!(h.now().await? < at + 2 * HOUR);
    let later = h.rescue(&h.keeper, id, 1, 1).transact().await?;
    assert_rejected(&later, "cooldown has not elapsed");

    h.warp_to(at + 2 * HOUR).await?;
    let after = h.signed(h.rescue(&h.keeper, id, 1, 1)).await?;
    assert!(after.is_success(), "{:?}", after.failures());
    Ok(())
}

#[tokio::test]
async fn the_daily_budget_holds_until_the_utc_day_turns() -> anyhow::Result<()> {
    let h = Harness::warped().await?;
    h.warp_to_start_of_day().await?;
    let id = h.register(CAPS).await?;

    for nonce in 0..2 {
        let outcome = h.signed(h.rescue(&h.keeper, id, 1_000_000, nonce)).await?;
        assert!(outcome.is_success(), "{:?}", outcome.failures());
    }
    let last = h.signed(h.rescue(&h.keeper, id, 500_000, 2)).await?;
    assert!(last.is_success(), "{:?}", last.failures());
    assert_eq!(h.position(id).await?.spent_today, U128(CAPS.max_per_day));

    // One unit past the budget, in the same UTC day.
    let over = h.rescue(&h.keeper, id, 1, 3).transact().await?;
    assert_rejected(&over, "amount exceeds the daily budget");

    h.warp_to_start_of_day().await?;
    assert_eq!(h.position(id).await?.spent_today, U128(0));
    let next_day = h.signed(h.rescue(&h.keeper, id, 1_000_000, 3)).await?;
    assert!(next_day.is_success(), "{:?}", next_day.failures());
    assert_eq!(h.position(id).await?.spent_today, U128(1_000_000));
    Ok(())
}

#[tokio::test]
async fn amounts_outside_the_rescue_cap_are_rejected() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;
    let zero = h.rescue(&h.keeper, id, 0, 0).transact().await?;
    assert_rejected(&zero, "amount must be above zero");
    let over = h
        .rescue(&h.keeper, id, CAPS.max_per_rescue + 1, 0)
        .transact()
        .await?;
    assert_rejected(&over, "amount exceeds max_per_rescue");
    let at = h
        .signed(h.rescue(&h.keeper, id, CAPS.max_per_rescue, 0))
        .await?;
    assert!(at.is_success(), "{:?}", at.failures());
    Ok(())
}

#[tokio::test]
async fn fee_ceilings_hold_for_every_signing_method() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;

    let with_fees = |max_fee: u128, priority: u128| {
        json!({
            "nonce": 0,
            "max_fee_per_gas": max_fee.to_string(),
            "max_priority_fee_per_gas": priority.to_string(),
        })
    };
    let cases = [
        (
            with_fees(MAX_FEE_CEILING + 1, 1),
            "max_fee_per_gas exceeds the chain ceiling",
        ),
        (
            with_fees(MAX_FEE_CEILING, PRIORITY_CEILING + 1),
            "max_priority_fee_per_gas exceeds the chain ceiling",
        ),
        (
            with_fees(5, 6),
            "max_priority_fee_per_gas exceeds max_fee_per_gas",
        ),
    ];
    for (fees, message) in cases {
        let rescue = h
            .keeper
            .call(h.levee.id(), "rescue")
            .args_json(json!({ "id": id, "amount": "1", "fees": fees }))
            .gas(CALL_GAS)
            .transact()
            .await?;
        assert_rejected(&rescue, message);
        let allowance = h
            .owner
            .call(h.levee.id(), "prepare_allowance")
            .args_json(json!({ "id": id, "amount": "1", "fees": fees }))
            .gas(CALL_GAS)
            .transact()
            .await?;
        assert_rejected(&allowance, message);
        let float = h
            .owner_call(
                "withdraw_float",
                json!({ "id": id, "amount": "1", "fees": fees }),
            )
            .transact()
            .await?;
        assert_rejected(&float, message);
        let sweep = h
            .owner_call(
                "sweep_gas",
                json!({ "id": id, "amount_wei": "1", "fees": fees }),
            )
            .transact()
            .await?;
        assert_rejected(&sweep, message);
    }
    assert!(h.requests().await?.is_empty());

    // Exactly at both ceilings is allowed.
    let at_ceiling = h
        .signed(
            h.keeper
                .call(h.levee.id(), "rescue")
                .args_json(json!({
                    "id": id,
                    "amount": "1",
                    "fees": with_fees(MAX_FEE_CEILING, PRIORITY_CEILING),
                }))
                .gas(CALL_GAS),
        )
        .await?;
    assert!(at_ceiling.is_success(), "{:?}", at_ceiling.failures());
    Ok(())
}

#[tokio::test]
async fn tighten_is_immediate_and_loosening_takes_24_hours() -> anyhow::Result<()> {
    let h = Harness::warped().await?;
    let id = h.register(CAPS).await?;

    // Tighten bites at once.
    let tightened = h
        .owner_call(
            "tighten",
            json!({ "id": id, "max_per_rescue": "100", "max_per_day": "200", "cooldown_secs": 0 }),
        )
        .transact()
        .await?;
    assert_eq!(
        event(&tightened, "caps_tightened")["data"]["loosen_cancelled"],
        false
    );
    let over = h.rescue(&h.keeper, id, 101, 0).transact().await?;
    assert_rejected(&over, "amount exceeds max_per_rescue");

    // Tighten will not loosen.
    let looser = h
        .owner_call(
            "tighten",
            json!({ "id": id, "max_per_rescue": "101", "max_per_day": "200", "cooldown_secs": 0 }),
        )
        .transact()
        .await?;
    assert_rejected(&looser, "max_per_rescue may only decrease");

    // Loosening has to wait.
    let queued = h
        .owner_call(
            "queue_loosen",
            json!({ "id": id, "max_per_rescue": "500", "max_per_day": "900", "cooldown_secs": 0 }),
        )
        .transact()
        .await?;
    let ready_at = event(&queued, "caps_loosen_queued")["data"]["ready_at"]
        .as_u64()
        .unwrap();
    assert_eq!(h.position(id).await?.max_per_rescue, U128(100));

    let apply = || h.owner_call("apply_loosen", json!({ "id": id }));
    let immediately = apply().transact().await?;
    assert_rejected(&immediately, "the loosening delay has not elapsed");

    // Twenty-odd hours later, still not.
    h.warp_to(ready_at - 2 * HOUR).await?;
    let early = apply().transact().await?;
    assert_rejected(&early, "the loosening delay has not elapsed");
    assert_eq!(h.position(id).await?.max_per_rescue, U128(100));

    h.warp_to(ready_at).await?;
    let applied = apply().transact().await?;
    assert!(applied.is_success(), "{:?}", applied.failures());
    event(&applied, "caps_loosened");
    let position = h.position(id).await?;
    assert_eq!(position.max_per_rescue, U128(500));
    assert_eq!(position.max_per_day, U128(900));
    assert_eq!(position.pending_loosen, None);

    let rescued = h.signed(h.rescue(&h.keeper, id, 500, 0)).await?;
    assert!(rescued.is_success(), "{:?}", rescued.failures());
    Ok(())
}

#[tokio::test]
async fn a_queued_loosening_cannot_undo_a_later_tighten() -> anyhow::Result<()> {
    let h = Harness::warped().await?;
    let id = h.register(CAPS).await?;

    let loosen = json!({
        "id": id,
        "max_per_rescue": "9000000",
        "max_per_day": "9000000",
        "cooldown_secs": 0,
    });
    let queued = h.owner_call("queue_loosen", loosen).transact().await?;
    let ready_at = event(&queued, "caps_loosen_queued")["data"]["ready_at"]
        .as_u64()
        .unwrap();

    h.warp_to(ready_at - 2 * HOUR).await?;
    let tightened = h
        .owner_call(
            "tighten",
            json!({ "id": id, "max_per_rescue": "1", "max_per_day": "1", "cooldown_secs": 0 }),
        )
        .transact()
        .await?;
    assert_eq!(
        event(&tightened, "caps_tightened")["data"]["loosen_cancelled"],
        true
    );

    h.warp_to(ready_at).await?;
    let apply = h
        .owner_call("apply_loosen", json!({ "id": id }))
        .transact()
        .await?;
    assert_rejected(&apply, "no loosening is queued");
    assert_eq!(h.position(id).await?.max_per_rescue, U128(1));
    Ok(())
}

#[tokio::test]
async fn replacing_a_queued_loosening_restarts_the_delay() -> anyhow::Result<()> {
    let h = Harness::warped().await?;
    let id = h.register(CAPS).await?;

    let small = json!({ "id": id, "max_per_rescue": "1000001", "max_per_day": "2500000", "cooldown_secs": 0 });
    let large = json!({ "id": id, "max_per_rescue": "9000000", "max_per_day": "9000000", "cooldown_secs": 0 });
    let first = h.owner_call("queue_loosen", small).transact().await?;
    let first_ready = event(&first, "caps_loosen_queued")["data"]["ready_at"]
        .as_u64()
        .unwrap();

    h.warp_to(first_ready - 2 * HOUR).await?;
    let second = h.owner_call("queue_loosen", large).transact().await?;
    assert!(second.is_success(), "{:?}", second.failures());

    h.warp_to(first_ready).await?;
    let apply = h
        .owner_call("apply_loosen", json!({ "id": id }))
        .transact()
        .await?;
    assert_rejected(&apply, "the loosening delay has not elapsed");
    Ok(())
}

/// The v0.1 keeper key. The position can repay from collateral, so the only thing
/// standing between this key and `rescue_from_collateral` is the key's method list.
#[tokio::test]
async fn a_function_call_key_limited_to_rescue_can_do_nothing_else() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register_with_collateral(CAPS).await?;

    // The keeper's hot key, limited as the trust model says.
    let hot = SecretKey::from_random(KeyType::ED25519);
    h.keeper
        .batch(h.keeper.id())
        .add_key(
            hot.public_key(),
            AccessKey::function_call_access(
                h.levee.id(),
                &["rescue"],
                Some(NearToken::from_near(1)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let hot_keeper = Account::from_secret_key(h.keeper.id().clone(), hot, &h.worker);

    // It does what it is for, with the contract paying the deposit it cannot attach.
    let rescued = h.signed(h.rescue(&hot_keeper, id, 1, 0)).await?;
    assert!(rescued.is_success(), "{:?}", rescued.failures());
    assert_eq!(h.request(0).await?.deposit, U128(1));

    // Every other method on the contract fails before any code runs, including the
    // other keeper method: a key scoped for reserve mode does not gain collateral mode.
    let methods = [
        (
            "rescue_from_collateral",
            json!({ "id": id, "amount": "1", "max_sold": "1", "fees": fees(1) }),
        ),
        (
            "prepare_allowance",
            json!({ "id": id, "amount": "1", "fees": fees(0) }),
        ),
        ("set_keeper", json!({ "id": id, "keeper": h.stranger.id() })),
        (
            "tighten",
            json!({ "id": id, "max_per_rescue": "1", "max_per_day": "1", "cooldown_secs": 0 }),
        ),
        (
            "queue_loosen",
            json!({ "id": id, "max_per_rescue": "2", "max_per_day": "2", "cooldown_secs": 0 }),
        ),
        ("apply_loosen", json!({ "id": id })),
        ("pause", json!({ "id": id })),
        ("resume", json!({ "id": id })),
        (
            "withdraw_float",
            json!({ "id": id, "amount": "1", "fees": fees(0) }),
        ),
        (
            "sweep_gas",
            json!({ "id": id, "amount_wei": "1", "fees": fees(0) }),
        ),
        ("on_signed", json!({})),
    ];
    for (method, args) in methods {
        let error = hot_keeper
            .call(h.levee.id(), method)
            .args_json(args)
            .gas(CALL_GAS)
            .transact()
            .await
            .expect_err(method);
        assert!(
            format!("{error:?}").contains("MethodNameMismatch"),
            "{method}: {error:?}"
        );
    }

    // Nor can it call another contract, attach a deposit or move funds.
    let other_contract = hot_keeper
        .call(h.signer.id(), "rescue")
        .args_json(json!({}))
        .transact()
        .await
        .expect_err("another receiver");
    assert!(
        format!("{other_contract:?}").contains("ReceiverMismatch"),
        "{other_contract:?}"
    );
    let with_deposit = h
        .rescue(&hot_keeper, id, 1, 1)
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await
        .expect_err("a deposit");
    assert!(
        format!("{with_deposit:?}").contains("DepositWithFunctionCall"),
        "{with_deposit:?}"
    );
    let transfer = hot_keeper
        .transfer_near(h.stranger.id(), NearToken::from_yoctonear(1))
        .await;
    assert!(transfer.is_err(), "the key moved funds");

    // None of that changed anything.
    let position = h.position(id).await?;
    assert_eq!(position.keeper, *near_sdk_account(h.keeper.id()));
    assert_eq!(position.spent_today, U128(1));
    assert_eq!(h.requests().await?.len(), 1);
    Ok(())
}

fn near_sdk_account(id: &near_workspaces::AccountId) -> near_sdk::AccountId {
    id.as_str().parse().unwrap()
}

#[tokio::test]
async fn a_surplus_deposit_is_refunded_to_the_registrant() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let levee_before = h.levee.view_account().await?.storage_usage;
    let balance_before = h.owner.view_account().await?.balance;

    let deposit = NearToken::from_near(2);
    let outcome = h
        .owner
        .call(h.levee.id(), "register")
        .args_json(json!({
            "chain_id": BASE,
            "borrower": BORROWER,
            "keeper": h.keeper.id(),
            "max_per_rescue": "1",
            "max_per_day": "1",
            "cooldown_secs": 0,
        }))
        .deposit(deposit)
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert!(outcome.is_success(), "{:?}", outcome.failures());

    let paid: U128 = serde_json::from_value(
        event(&outcome, "position_registered")["data"]["storage_paid"].clone(),
    )?;
    let burnt: u128 = outcome
        .outcomes()
        .iter()
        .map(|outcome| outcome.tokens_burnt.as_yoctonear())
        .sum();
    assert!(paid.0 < deposit.as_yoctonear() / 100);

    // The registrant ends up down by the storage cost and the gas, to the yocto. The
    // unused gas comes back in a receipt after the outcome, so wait for it to land.
    let expected = balance_before.as_yoctonear() - paid.0 - burnt;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let balance = h.owner.view_account().await?.balance.as_yoctonear();
        if balance == expected {
            break;
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "balance {balance}, expected {expected}: storage {}, burnt {burnt}",
            paid.0
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // What was charged covers what was stored.
    let levee_after = h.levee.view_account().await?.storage_usage;
    let stored_bytes = u128::from(levee_after - levee_before);
    assert!(stored_bytes * STORAGE_BYTE_COST <= paid.0);
    Ok(())
}

#[tokio::test]
async fn too_small_a_deposit_is_rejected_and_returned() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let before = h.owner.view_account().await?.balance;
    let outcome = h
        .owner
        .call(h.levee.id(), "register")
        .args_json(json!({
            "chain_id": BASE,
            "borrower": BORROWER,
            "keeper": h.keeper.id(),
            "max_per_rescue": "1",
            "max_per_day": "1",
            "cooldown_secs": 0,
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert_rejected(&outcome, "attached deposit does not cover storage");
    let after = h.owner.view_account().await?.balance;
    let lost = before.as_yoctonear() - after.as_yoctonear();
    assert!(lost < NearToken::from_millinear(10).as_yoctonear());
    Ok(())
}

#[tokio::test]
async fn paid_storage_covers_a_position_at_its_largest() -> anyhow::Result<()> {
    paid_storage_is_exact_at_its_largest(None).await
}

/// The collateral config makes the record larger, and is charged as stored.
#[tokio::test]
async fn paid_storage_covers_a_position_with_collateral_at_its_largest() -> anyhow::Result<()> {
    paid_storage_is_exact_at_its_largest(Some(collateral())).await
}

async fn paid_storage_is_exact_at_its_largest(collateral: Option<Value>) -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let usage_before = h.levee.view_account().await?.storage_usage;
    let mut args = json!({
        "chain_id": BASE,
        "borrower": BORROWER,
        "keeper": "k.test.near",
        "max_per_rescue": "1",
        "max_per_day": "1",
        "cooldown_secs": 0,
    });
    if let Some(collateral) = collateral {
        args["collateral"] = collateral;
    }
    let outcome = h
        .owner
        .call(h.levee.id(), "register")
        .args_json(args)
        .deposit(NearToken::from_millinear(100))
        .gas(CALL_GAS)
        .transact()
        .await?;
    let paid: U128 = serde_json::from_value(
        event(&outcome, "position_registered")["data"]["storage_paid"].clone(),
    )?;
    let id: u64 = outcome.json()?;

    let longest = format!("{}.near", "k".repeat(59));
    assert_eq!(longest.len(), 64);
    h.owner_call("set_keeper", json!({ "id": id, "keeper": longest }))
        .transact()
        .await?
        .into_result()?;
    h.owner_call(
        "queue_loosen",
        json!({ "id": id, "max_per_rescue": "2", "max_per_day": "2", "cooldown_secs": 0 }),
    )
    .transact()
    .await?
    .into_result()?;

    let usage_after = h.levee.view_account().await?.storage_usage;
    let bytes = u128::from(usage_after - usage_before);
    assert_eq!(bytes * STORAGE_BYTE_COST, paid.0);
    Ok(())
}

#[tokio::test]
async fn non_payable_methods_refuse_a_deposit() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;
    let outcome = h
        .rescue(&h.keeper, id, 1, 0)
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert_rejected(&outcome, "doesn't accept deposit");
    Ok(())
}

#[tokio::test]
async fn it_still_works_with_every_key_deleted() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;

    let keys = h.levee.view_access_keys().await?;
    assert_eq!(keys.len(), 1);
    h.levee
        .as_account()
        .batch(h.levee.id())
        .delete_key(keys[0].public_key.clone())
        .transact()
        .await?
        .into_result()?;
    assert!(h.levee.view_access_keys().await?.is_empty());

    let outcome = h.signed(h.rescue(&h.keeper, id, 1, 0)).await?;
    assert!(outcome.is_success(), "{:?}", outcome.failures());
    let signed = returned(&outcome)?;
    let (_, from) = assemble(&signed.unwrap());
    assert_eq!(from, h.rescuer(id));
    Ok(())
}

#[derive(Deserialize)]
struct Vectors {
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
    max_sold: String,
    borrower: String,
    nonce: u64,
    max_fee_per_gas: String,
    max_priority_fee_per_gas: String,
    gas_limit: u64,
    amount: String,
    unsigned_tx: String,
    signing_hash: String,
}

fn without_ceilings(vector: &Vector) -> ChainConfig {
    ChainConfig {
        chain_id: vector.chain_id,
        pool: vector.pool.clone(),
        usdc: vector.usdc.clone(),
        unwind: vector.unwind.clone(),
        max_fee_per_gas_ceiling: U128(u128::MAX),
        max_priority_fee_ceiling: U128(u128::MAX),
        gas_limit_approve: vector.gas_limit,
        gas_limit_repay: vector.gas_limit,
        gas_limit_transfer: vector.gas_limit,
        gas_limit_unwind: vector.gas_limit,
    }
}

/// Every cast vector, through the real wasm: the encoder as compiled, and the real
/// keccak host function rather than the native one the unit tests see.
#[tokio::test]
async fn the_wasm_matches_every_cast_vector_byte_for_byte() -> anyhow::Result<()> {
    let fixture: Vectors = serde_json::from_str(include_str!("../fixtures/tx_vectors.json"))?;
    let kinds: BTreeSet<&str> = fixture.vectors.iter().map(|v| v.kind.as_str()).collect();
    assert_eq!(kinds.len(), 5);
    let mut checked = 0;

    let worker = near_workspaces::sandbox().await?;
    let signer = worker
        .dev_deploy(&wasm("mock-signer", "mock_signer/mock_signer.wasm"))
        .await?;
    let owner = worker.dev_create_account().await?;

    for vector in &fixture.vectors {
        // Gas limits differ by kind and chain in the fixture, so each gets a contract.
        let levee = worker
            .dev_deploy(&wasm("levee", "levee/levee.wasm"))
            .await?;
        levee
            .call("new")
            .args_json(json!({ "mpc_contract": signer.id(), "chains": [without_ceilings(vector)] }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?
            .into_result()?;
        let id: u64 = owner
            .call(levee.id(), "register")
            .args_json(json!({
                "chain_id": vector.chain_id,
                "borrower": vector.borrower,
                "keeper": owner.id(),
                "max_per_rescue": u128::MAX.to_string(),
                "max_per_day": u128::MAX.to_string(),
                "cooldown_secs": 0,
                "collateral": { "asset": vector.collateral, "pool_fee": vector.pool_fee },
            }))
            .deposit(NearToken::from_millinear(100))
            .gas(CALL_GAS)
            .transact()
            .await?
            .into_result()?
            .json()?;

        let fees = json!({
            "nonce": vector.nonce,
            "max_fee_per_gas": vector.max_fee_per_gas,
            "max_priority_fee_per_gas": vector.max_priority_fee_per_gas,
        });

        let preview_method = match vector.kind.as_str() {
            "repay" => Some("preview_rescue"),
            "unwind" => Some("preview_rescue_from_collateral"),
            _ => None,
        };
        if let Some(preview_method) = preview_method {
            let preview: PreviewTx = levee
                .view(preview_method)
                .args_json(json!({
                    "id": id,
                    "amount": vector.amount,
                    "max_sold": vector.max_sold,
                    "fees": fees,
                }))
                .await?
                .json()?;
            assert_eq!(preview.unsigned_tx, vector.unsigned_tx, "{}", vector.name);
            assert_eq!(preview.tx_hash, vector.signing_hash, "{}", vector.name);
        }

        // A view is not the path that signs, so go through that too. What the signer
        // receives is the only thing that can ever be signed.
        let (method, args) = match vector.kind.as_str() {
            "repay" => (
                "rescue",
                json!({ "id": id, "amount": vector.amount, "fees": fees }),
            ),
            "approve" => (
                "prepare_allowance",
                json!({ "id": id, "amount": vector.amount, "fees": fees }),
            ),
            "transfer" => (
                "withdraw_float",
                json!({ "id": id, "amount": vector.amount, "fees": fees }),
            ),
            "value" => (
                "sweep_gas",
                json!({ "id": id, "amount_wei": vector.amount, "fees": fees }),
            ),
            "unwind" => (
                "rescue_from_collateral",
                json!({
                    "id": id,
                    "amount": vector.amount,
                    "max_sold": vector.max_sold,
                    "fees": fees,
                }),
            ),
            other => panic!("unknown kind {other}"),
        };
        let index = {
            let requests: Vec<SignerRequest> = signer.view("requests").await?.json()?;
            requests.len()
        };
        let _pending = owner
            .call(levee.id(), method)
            .args_json(args)
            .gas(CALL_GAS)
            .transact_async()
            .await?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let payload = loop {
            let requests: Vec<SignerRequest> = signer.view("requests").await?.json()?;
            if let Some(request) = requests.get(index) {
                assert!(request.open);
                break request.payload.clone();
            }
            anyhow::ensure!(Instant::now() < deadline, "{} never signed", vector.name);
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        assert_eq!(
            format!("0x{payload}"),
            vector.signing_hash,
            "{}",
            vector.name
        );
        checked += 1;
    }
    assert_eq!(checked, fixture.vectors.len());
    Ok(())
}

async fn signed_kind(
    h: &Harness,
    id: u64,
    kind: SignKind,
    method: &str,
    args: Value,
    event_name: &str,
) -> anyhow::Result<TxEip1559> {
    let outcome = h.signed(h.owner_call(method, args)).await?;
    assert!(outcome.is_success(), "{:?}", outcome.failures());
    let signed = returned(&outcome)?;
    let signed = signed.expect("a signature came back");
    assert_eq!(signed.kind, kind);
    assert_eq!(
        event(&outcome, event_name)["data"],
        serde_json::to_value(&signed)?
    );
    let (tx, from) = assemble(&signed);
    assert_eq!(from, h.rescuer(id));
    Ok(tx)
}

#[tokio::test]
async fn the_other_signing_methods_end_in_transactions_from_the_rescuer() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;

    let approve = signed_kind(
        &h,
        id,
        SignKind::Allowance,
        "prepare_allowance",
        json!({ "id": id, "amount": "75000000", "fees": fees(0) }),
        "allowance_signed",
    )
    .await?;
    assert_eq!(approve.to, TxKind::Call(parse_address(BASE_USDC)));
    assert_eq!(approve.gas_limit, 70_000);
    assert_eq!(approve.input[..4], [0x09, 0x5e, 0xa7, 0xb3]);
    assert_eq!(
        word_address(&approve.input[4..36]),
        parse_address(BASE_POOL)
    );
    assert_eq!(
        U256::from_be_slice(&approve.input[36..68]),
        U256::from(75_000_000)
    );

    let transfer = signed_kind(
        &h,
        id,
        SignKind::WithdrawFloat,
        "withdraw_float",
        json!({ "id": id, "amount": "42", "fees": fees(1) }),
        "float_withdrawn",
    )
    .await?;
    assert_eq!(transfer.to, TxKind::Call(parse_address(BASE_USDC)));
    assert_eq!(transfer.gas_limit, 80_000);
    assert_eq!(transfer.input[..4], [0xa9, 0x05, 0x9c, 0xbb]);
    assert_eq!(
        word_address(&transfer.input[4..36]),
        parse_address(BORROWER)
    );
    assert_eq!(U256::from_be_slice(&transfer.input[36..68]), U256::from(42));

    let sweep = signed_kind(
        &h,
        id,
        SignKind::SweepGas,
        "sweep_gas",
        json!({ "id": id, "amount_wei": "1000", "fees": fees(2) }),
        "gas_swept",
    )
    .await?;
    assert_eq!(sweep.to, TxKind::Call(parse_address(BORROWER)));
    assert_eq!(sweep.gas_limit, 80_000);
    assert_eq!(sweep.value, U256::from(1_000));
    assert!(sweep.input.is_empty());

    // None of this touches the rescue budget.
    assert_eq!(h.position(id).await?.spent_today, U128(0));
    Ok(())
}

#[tokio::test]
async fn the_allowance_limit_is_thirty_days_of_budget() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;
    let limit = 30 * CAPS.max_per_day;

    let over = h
        .owner
        .call(h.levee.id(), "prepare_allowance")
        .args_json(json!({ "id": id, "amount": (limit + 1).to_string(), "fees": fees(0) }))
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert_rejected(&over, "amount exceeds 30 times max_per_day");

    let stranger = h
        .stranger
        .call(h.levee.id(), "prepare_allowance")
        .args_json(json!({ "id": id, "amount": "1", "fees": fees(0) }))
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert_rejected(&stranger, "caller is not the owner");

    let at = h
        .signed(
            h.owner
                .call(h.levee.id(), "prepare_allowance")
                .args_json(json!({ "id": id, "amount": limit.to_string(), "fees": fees(0) }))
                .gas(CALL_GAS),
        )
        .await?;
    assert!(at.is_success(), "{:?}", at.failures());
    Ok(())
}

#[tokio::test]
async fn a_view_of_the_public_config_matches_what_was_deployed() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let mpc: String = h.levee.view("get_mpc_contract").await?.json()?;
    assert_eq!(mpc, h.signer.id().as_str());

    let base: Option<ChainConfig> = h
        .levee
        .view("get_chain")
        .args_json(json!({ "chain_id": BASE }))
        .await?
        .json()?;
    let base = base.unwrap();
    assert_eq!(base.pool, BASE_POOL);
    assert_eq!(base.usdc, BASE_USDC);

    let unknown: Option<ChainConfig> = h
        .levee
        .view("get_chain")
        .args_json(json!({ "chain_id": 1 }))
        .await?
        .json()?;
    assert_eq!(unknown, None);

    let path: String = h
        .levee
        .view("rescuer_path")
        .args_json(json!({ "id": 7 }))
        .await?
        .json()?;
    assert_eq!(path, "levee/v1/7");
    Ok(())
}

#[tokio::test]
async fn the_preview_is_what_rescue_signs_and_fails_as_rescue_would() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;
    let args = json!({ "id": id, "amount": "5", "fees": fees(9) });

    let preview: PreviewTx = h
        .levee
        .view("preview_rescue")
        .args_json(&args)
        .await?
        .json()?;
    assert_eq!(h.position(id).await?.spent_today, U128(0));

    let outcome = h.signed(h.rescue(&h.keeper, id, 5, 9)).await?;
    let signed = returned(&outcome)?;
    let signed = signed.unwrap();
    assert_eq!(preview.unsigned_tx, signed.unsigned_tx);
    assert_eq!(preview.tx_hash, signed.tx_hash);

    h.owner_call("pause", json!({ "id": id }))
        .transact()
        .await?
        .into_result()?;
    let paused = h
        .levee
        .view("preview_rescue")
        .args_json(&args)
        .await
        .expect_err("a paused position cannot be previewed");
    assert!(
        format!("{paused:?}").contains("position is paused"),
        "{paused:?}"
    );
    Ok(())
}

/// If the MPC network raises its gas requirement, an immutable contract must not be
/// stranded: the keeper attaches more and the unused gas reaches `sign`.
#[tokio::test]
async fn a_raised_signer_requirement_is_met_by_attaching_more_gas() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;
    h.signer
        .call("set_required_tgas")
        .args_json(json!({ "tgas": 60 }))
        .transact()
        .await?
        .into_result()?;

    // The minimum no longer reaches the signer, and the failure path cleans up.
    let short = h
        .rescue(&h.keeper, id, 500, 0)
        .gas(MIN_SIGNING_GAS)
        .transact()
        .await?;
    assert!(short.is_success(), "{:?}", short.failures());
    assert_eq!(event(&short, "rescue_failed")["data"]["released"], "500");
    assert_eq!(h.position(id).await?.spent_today, U128(0));

    let enough = h
        .signed(h.rescue(&h.keeper, id, 500, 0).gas(Gas::from_tgas(100)))
        .await?;
    assert!(enough.is_success(), "{:?}", enough.failures());
    let request = h.request(0).await?;
    assert!(
        request.prepaid_gas_tgas >= 60,
        "{}",
        request.prepaid_gas_tgas
    );
    Ok(())
}

#[tokio::test]
async fn too_little_gas_is_rejected_before_anything_is_reserved() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;
    let short = Gas::from_gas(MIN_SIGNING_GAS.as_gas() - 1);
    let outcome = h.rescue(&h.keeper, id, 1, 0).gas(short).transact().await?;
    assert_rejected(&outcome, "not enough gas attached to reach the signer");
    assert_eq!(h.position(id).await?.spent_today, U128(0));
    assert!(h.requests().await?.is_empty());
    Ok(())
}

fn tgas(gas: Gas) -> f64 {
    gas.as_gas() as f64 / 1e12
}

/// Burnt by the contract's own two receipts: the method, then its callback.
fn own_receipts(h: &Harness, outcome: &ExecutionFinalResult) -> (Gas, Gas) {
    let own: Vec<_> = outcome
        .receipt_outcomes()
        .iter()
        .filter(|receipt| receipt.executor_id == *h.levee.id())
        .collect();
    let method = own.first().expect("the method ran").gas_burnt;
    let callback = own.last().expect("the callback ran").gas_burnt;
    (method, callback)
}

fn print_receipts(h: &Harness, label: &str, outcome: &ExecutionFinalResult) {
    println!("{label}:");
    println!(
        "  {:>12}: {:.3} Tgas",
        "conversion",
        tgas(outcome.outcome().gas_burnt)
    );
    for receipt in outcome.receipt_outcomes() {
        let who = match &receipt.executor_id {
            id if id == h.levee.id() => "levee",
            id if id == h.signer.id() => "signer",
            _ => "refund",
        };
        println!("  {who:>12}: {:.3} Tgas", tgas(receipt.gas_burnt));
    }
    println!(
        "  {:>12}: {:.3} Tgas",
        "total",
        tgas(outcome.total_gas_burnt)
    );
}

/// Measures `rescue` end to end and pins the budget, so a change that stops it fitting
/// fails here. Run with `--nocapture` to see the figures. They come from the real VM
/// on mainnet's runtime config. The live signer's own costs are in `docs/SPEC.md`.
#[tokio::test]
async fn gas_of_a_rescue() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;
    gas_budget_holds(&h, id, "rescue").await
}

/// The same budget for `rescue_from_collateral`, which reads a larger record and
/// builds longer calldata. Same constants, so it has to fit the same way.
#[tokio::test]
async fn gas_of_a_rescue_from_collateral() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register_with_collateral(CAPS).await?;
    gas_budget_holds(&h, id, "rescue_from_collateral").await
}

async fn gas_budget_holds(h: &Harness, id: u64, method: &str) -> anyhow::Result<()> {
    for (index, (label, gas)) in [
        (format!("{method}, 100 Tgas attached"), CALL_GAS),
        (format!("{method}, the minimum attached"), MIN_SIGNING_GAS),
    ]
    .into_iter()
    .enumerate()
    {
        let call = h.keeper_call(&h.keeper, method, id, 1, 0).gas(gas);
        let outcome = h.signed(call).await?;
        assert!(outcome.is_success(), "{label}: {:?}", outcome.failures());
        assert!(returned(&outcome)?.is_some(), "{label}: no signature");
        print_receipts(h, &label, &outcome);

        // Attaching only the minimum still reaches a signer that wants 20 Tgas, five
        // above what the live contracts ask for today.
        assert!(h.request(index).await?.prepaid_gas_tgas >= 20);

        let (burnt, callback) = own_receipts(h, &outcome);
        let spare_for_method =
            MIN_SIGNING_GAS.as_gas() - SIGN_GAS.as_gas() - ON_SIGNED_GAS.as_gas();
        assert!(
            burnt.as_gas() * 3 / 2 <= spare_for_method,
            "the method's {:.3} Tgas leaves too little room in the minimum",
            tgas(burnt)
        );
        assert!(
            callback.as_gas() * 5 <= ON_SIGNED_GAS.as_gas(),
            "on_signed's {:.3} Tgas leaves too little room in its reserve",
            tgas(callback)
        );
    }

    h.signer
        .call("set_failing")
        .args_json(json!({ "failing": true }))
        .transact()
        .await?
        .into_result()?;
    let failing = h
        .keeper_call(&h.keeper, method, id, 1, 0)
        .transact()
        .await?;
    assert!(failing.is_success());
    print_receipts(h, &format!("{method}, signature failed"), &failing);
    let (_, callback) = own_receipts(h, &failing);
    assert!(
        callback.as_gas() * 5 <= ON_SIGNED_GAS.as_gas(),
        "the failure path's {:.3} Tgas leaves too little room in its reserve",
        tgas(callback)
    );

    println!(
        "budget: SIGN_GAS {:.0}, ON_SIGNED_GAS {:.0}, MIN_SIGNING_GAS {:.0} Tgas",
        tgas(SIGN_GAS),
        tgas(ON_SIGNED_GAS),
        tgas(MIN_SIGNING_GAS),
    );
    Ok(())
}

/// The whole collateral path: the keeper asks, the contract checks and reserves, the
/// signer signs, and the result assembles into an `unwind` call from the rescuer that
/// names only what the position registered.
#[tokio::test]
async fn happy_path_a_rescue_from_collateral_ends_in_an_unwind_from_the_rescuer(
) -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let caps = Caps {
        max_per_day: 1_500_000,
        ..CAPS
    };
    let id = h.register_with_collateral(caps).await?;

    let position = h.position(id).await?;
    let stored = position
        .collateral
        .expect("the collateral config was stored");
    assert_eq!(stored.asset, BASE_WETH);
    assert_eq!(stored.pool_fee, POOL_FEE);

    let preview: PreviewTx = h
        .levee
        .view("preview_rescue_from_collateral")
        .args_json(json!({
            "id": id,
            "amount": "750000",
            "max_sold": MAX_SOLD.to_string(),
            "fees": fees(3),
        }))
        .await?
        .json()?;

    let outcome = h.signed(h.unwind(&h.keeper, id, 750_000, 3)).await?;
    assert!(outcome.is_success(), "{:?}", outcome.failures());
    let signed = returned(&outcome)?.expect("a signature came back");
    assert_eq!(signed.kind, SignKind::Unwind);
    assert_eq!(signed.id, id);
    assert_eq!(preview.unsigned_tx, signed.unsigned_tx);
    assert_eq!(preview.tx_hash, signed.tx_hash);

    // The same events as a rescue, so a count of rescues stays a count of rescues.
    let logged = event(&outcome, "rescue_signed");
    assert_eq!(logged["data"], serde_json::to_value(&signed)?);
    assert_eq!(logged["data"]["kind"], "unwind");
    let requested = event(&outcome, "rescue_requested");
    assert_eq!(requested["data"]["kind"], "unwind");
    assert_eq!(requested["data"]["amount"], "750000");

    let request = h.request(0).await?;
    assert_eq!(request.path, format!("levee/v1/{id}"));
    assert_eq!(request.deposit, U128(1));
    assert_eq!(format!("0x{}", request.payload), signed.tx_hash);

    let (tx, from) = assemble(&signed);
    assert_eq!(from, h.rescuer(id));
    assert_eq!(tx.chain_id, BASE);
    assert_eq!(tx.nonce, 3);
    assert_eq!(tx.gas_limit, GAS_LIMIT_UNWIND);
    assert_eq!(tx.to, TxKind::Call(parse_address(BASE_UNWIND)));
    assert_eq!(tx.value, U256::ZERO);
    assert_eq!(tx.input.len(), 164);
    assert_eq!(tx.input[..4], [0x65, 0xaf, 0xae, 0x08]);
    assert_eq!(word_address(&tx.input[4..36]), parse_address(BORROWER));
    assert_eq!(word_address(&tx.input[36..68]), parse_address(BASE_WETH));
    assert_eq!(U256::from_be_slice(&tx.input[68..100]), U256::from(750_000));
    assert_eq!(
        U256::from_be_slice(&tx.input[100..132]),
        U256::from(POOL_FEE)
    );
    // The keeper's cap goes in as given.
    assert_eq!(
        U256::from_be_slice(&tx.input[132..164]),
        U256::from(MAX_SOLD)
    );

    // Charged to the same budget a rescue uses: 750,001 is within max_per_rescue but
    // one over what the day has left.
    let position = h.position(id).await?;
    assert_eq!(position.spent_today, U128(750_000));
    let over = h.rescue(&h.keeper, id, 750_001, 4).transact().await?;
    assert_rejected(&over, "amount exceeds the daily budget");
    Ok(())
}

#[tokio::test]
async fn a_position_without_collateral_config_cannot_unwind() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register(CAPS).await?;
    assert_eq!(h.position(id).await?.collateral, None);

    let outcome = h.unwind(&h.keeper, id, 1, 0).transact().await?;
    assert_rejected(&outcome, "position has no collateral config");
    let preview = h
        .levee
        .view("preview_rescue_from_collateral")
        .args_json(json!({ "id": id, "amount": "1", "max_sold": "1", "fees": fees(0) }))
        .await
        .expect_err("no collateral to preview");
    assert!(
        format!("{preview:?}").contains("position has no collateral config"),
        "{preview:?}"
    );

    assert!(
        h.requests().await?.is_empty(),
        "something reached the signer"
    );
    assert_eq!(h.position(id).await?.spent_today, U128(0));
    // The reserve path is untouched.
    let rescued = h.signed(h.rescue(&h.keeper, id, 1, 0)).await?;
    assert!(rescued.is_success(), "{:?}", rescued.failures());
    Ok(())
}

/// The contract cannot price `max_sold`, so it refuses only zero, before anything is
/// reserved or reaches the signer. A call without it, as a keeper built for the old
/// three-argument method would send, does not deserialise at all.
#[tokio::test]
async fn a_zero_or_missing_max_sold_is_refused() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register_with_collateral(CAPS).await?;

    let zero = h
        .keeper
        .call(h.levee.id(), "rescue_from_collateral")
        .args_json(json!({ "id": id, "amount": "1", "max_sold": "0", "fees": fees(0) }))
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert_rejected(&zero, "max_sold must be above zero");

    let missing = h
        .keeper
        .call(h.levee.id(), "rescue_from_collateral")
        .args_json(json!({ "id": id, "amount": "1", "fees": fees(0) }))
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert_rejected(&missing, "max_sold");

    assert!(
        h.requests().await?.is_empty(),
        "something reached the signer"
    );
    let position = h.position(id).await?;
    assert_eq!(position.spent_today, U128(0));
    assert_eq!(position.last_rescue_at, 0);
    Ok(())
}

#[tokio::test]
async fn a_bad_collateral_config_is_refused_at_register() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let cases = [
        (
            json!({ "asset": BASE_WETH, "pool_fee": 3001 }),
            "pool_fee must be 100, 500, 3000 or 10000",
        ),
        (
            json!({ "asset": "0x42", "pool_fee": 500 }),
            "address must be 0x followed by 40 hex characters",
        ),
        (
            json!({ "asset": BASE_USDC, "pool_fee": 500 }),
            "the collateral cannot be USDC",
        ),
    ];
    for (collateral, message) in cases {
        let outcome = h
            .owner
            .call(h.levee.id(), "register")
            .args_json(json!({
                "chain_id": BASE,
                "borrower": BORROWER,
                "keeper": h.keeper.id(),
                "max_per_rescue": "1",
                "max_per_day": "1",
                "cooldown_secs": 0,
                "collateral": collateral,
            }))
            .deposit(NearToken::from_millinear(100))
            .gas(CALL_GAS)
            .transact()
            .await?;
        assert_rejected(&outcome, message);
    }
    Ok(())
}

/// The keeper key for collateral mode. It reaches `rescue_from_collateral` and
/// nothing else, `rescue` included.
#[tokio::test]
async fn a_function_call_key_limited_to_rescue_from_collateral_can_do_nothing_else(
) -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h.register_with_collateral(CAPS).await?;

    let hot = SecretKey::from_random(KeyType::ED25519);
    h.keeper
        .batch(h.keeper.id())
        .add_key(
            hot.public_key(),
            AccessKey::function_call_access(
                h.levee.id(),
                &["rescue_from_collateral"],
                Some(NearToken::from_near(1)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let hot_keeper = Account::from_secret_key(h.keeper.id().clone(), hot, &h.worker);

    let unwound = h.signed(h.unwind(&hot_keeper, id, 1, 0)).await?;
    assert!(unwound.is_success(), "{:?}", unwound.failures());
    assert_eq!(
        returned(&unwound)?.map(|signed| signed.kind),
        Some(SignKind::Unwind)
    );

    let methods = [
        (
            "rescue",
            json!({ "id": id, "amount": "1", "fees": fees(1) }),
        ),
        (
            "prepare_allowance",
            json!({ "id": id, "amount": "1", "fees": fees(1) }),
        ),
        ("set_keeper", json!({ "id": id, "keeper": h.stranger.id() })),
        (
            "tighten",
            json!({ "id": id, "max_per_rescue": "1", "max_per_day": "1", "cooldown_secs": 0 }),
        ),
        (
            "queue_loosen",
            json!({ "id": id, "max_per_rescue": "2", "max_per_day": "2", "cooldown_secs": 0 }),
        ),
        ("apply_loosen", json!({ "id": id })),
        ("pause", json!({ "id": id })),
        ("resume", json!({ "id": id })),
        (
            "withdraw_float",
            json!({ "id": id, "amount": "1", "fees": fees(1) }),
        ),
        (
            "sweep_gas",
            json!({ "id": id, "amount_wei": "1", "fees": fees(1) }),
        ),
        ("on_signed", json!({})),
    ];
    for (method, args) in methods {
        let error = hot_keeper
            .call(h.levee.id(), method)
            .args_json(args)
            .gas(CALL_GAS)
            .transact()
            .await
            .expect_err(method);
        assert!(
            format!("{error:?}").contains("MethodNameMismatch"),
            "{method}: {error:?}"
        );
    }

    let with_deposit = h
        .unwind(&hot_keeper, id, 1, 1)
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await
        .expect_err("a deposit");
    assert!(
        format!("{with_deposit:?}").contains("DepositWithFunctionCall"),
        "{with_deposit:?}"
    );
    let transfer = hot_keeper
        .transfer_near(h.stranger.id(), NearToken::from_yoctonear(1))
        .await;
    assert!(transfer.is_err(), "the key moved funds");

    let position = h.position(id).await?;
    assert_eq!(position.spent_today, U128(1));
    assert_eq!(h.requests().await?.len(), 1);
    Ok(())
}

#[tokio::test]
async fn an_unwind_signature_failure_releases_the_budget() -> anyhow::Result<()> {
    let h = Harness::unwarped().await?;
    let id = h
        .register_with_collateral(Caps {
            cooldown_secs: 86_400,
            ..CAPS
        })
        .await?;
    h.signer
        .call("set_failing")
        .args_json(json!({ "failing": true }))
        .transact()
        .await?
        .into_result()?;

    let outcome = h.unwind(&h.keeper, id, 1_000_000, 0).transact().await?;
    assert!(outcome.is_success(), "{:?}", outcome.failures());
    assert_eq!(returned(&outcome)?, None);
    let failed = event(&outcome, "rescue_failed");
    assert_eq!(failed["data"]["kind"], "unwind");
    assert_eq!(failed["data"]["reason"], "mpc_failed");
    assert_eq!(failed["data"]["released"], "1000000");
    let position = h.position(id).await?;
    assert_eq!(position.spent_today, U128(0));
    assert_eq!(position.last_rescue_at, 0);
    Ok(())
}
