//! Stand-in for the MPC signer contract, used only by Levee tests.
//!
//! Seen from a caller it behaves like `v1.signer`: the same arguments, the same
//! deposit and gas rules, the same yield and resume, the same timeout, and the same
//! response format. The one thing it does not do is sign. A test plays the MPC node:
//! it reads the open request from `requests`, signs the payload with its own key and
//! passes the result to `respond`. If nobody responds, the request times out after 200
//! blocks exactly as the real one does.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::{
    env, near, require, AccountId, CryptoHash, Gas, GasWeight, NearToken, Promise, PromiseError,
    PromiseOrValue,
};

/// `sign_call_gas_attachment_requirement_tera_gas` on both live contracts.
const DEFAULT_REQUIRED_TGAS: u64 = 15;
/// `return_signature_and_clean_state_on_success_call_tera_gas`.
const YIELD_CALLBACK_GAS: Gas = Gas::from_tgas(7);
/// `fail_on_timeout_tera_gas`.
const FAIL_ON_TIMEOUT_GAS: Gas = Gas::from_tgas(2);
const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
const DATA_ID_REGISTER: u64 = 0;
/// The order of the secp256k1 group, big endian. A payload must be below it.
const SECP256K1_ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignRequestArgs {
    pub path: String,
    pub domain_id: u64,
    pub payload_v2: Payload,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum Payload {
    Ecdsa(String),
}

/// Everything `sign` saw, so that tests can assert on it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub predecessor: AccountId,
    pub path: String,
    pub domain_id: u64,
    /// Bare lowercase hex, as received.
    pub payload: String,
    pub deposit: U128,
    pub prepaid_gas_tgas: u64,
    /// False once it has been responded to or has timed out.
    pub open: bool,
    data_id: CryptoHash,
}

#[near(contract_state)]
pub struct MockSigner {
    requests: Vec<Request>,
    failing: bool,
    required_tgas: u64,
}

impl Default for MockSigner {
    fn default() -> Self {
        Self {
            requests: Vec::new(),
            failing: false,
            required_tgas: DEFAULT_REQUIRED_TGAS,
        }
    }
}

#[near]
impl MockSigner {
    /// Same checks, in the same order, as the real `sign`.
    #[payable]
    pub fn sign(&mut self, request: SignRequestArgs) {
        require!(request.domain_id == 0, "domain was not found");

        let prepaid_gas = env::prepaid_gas();
        require!(
            prepaid_gas >= Gas::from_tgas(self.required_tgas),
            "insufficient gas attached to sign"
        );

        let predecessor = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        let surplus = deposit
            .checked_sub(SIGN_DEPOSIT)
            .unwrap_or_else(|| env::panic_str("insufficient deposit attached to sign"));
        if !surplus.is_zero() {
            Promise::new(predecessor.clone()).transfer(surplus).detach();
        }

        require!(!self.failing, "mock signer was told to fail");

        let Payload::Ecdsa(payload) = request.payload_v2;
        let bytes = hex::decode(&payload)
            .unwrap_or_else(|_| env::panic_str("payload is not hex"));
        let bytes: [u8; 32] = bytes
            .try_into()
            .unwrap_or_else(|_| env::panic_str("payload is not 32 bytes"));
        require!(
            bytes < SECP256K1_ORDER,
            "Ecdsa payload cannot be converted to Scalar"
        );

        let index = self.requests.len() as u64;
        let args = serde_json::to_vec(&serde_json::json!({ "index": index })).unwrap();
        let promise = env::promise_yield_create(
            "return_signature_and_clean_state_on_success",
            args,
            YIELD_CALLBACK_GAS,
            GasWeight(0),
            DATA_ID_REGISTER,
        );
        let data_id: CryptoHash = env::read_register(DATA_ID_REGISTER)
            .expect("read_register failed")
            .try_into()
            .expect("conversion to CryptoHash failed");
        self.requests.push(Request {
            predecessor,
            path: request.path,
            domain_id: request.domain_id,
            payload,
            deposit: U128(deposit.as_yoctonear()),
            prepaid_gas_tgas: prepaid_gas.as_tgas(),
            open: true,
            data_id,
        });
        env::promise_return(promise);
    }

    /// What an MPC node does once it has a signature. The test supplies `response`,
    /// so it can also deliver something that is not a valid signature.
    pub fn respond(&mut self, index: u64, response: Value) {
        let request = self
            .requests
            .get_mut(index as usize)
            .unwrap_or_else(|| env::panic_str("no such request"));
        require!(request.open, "request is not open");
        request.open = false;
        let bytes = serde_json::to_vec(&response).unwrap();
        require!(
            env::promise_yield_resume(&request.data_id, bytes),
            "yield has timed out"
        );
    }

    /// Runs on `respond`, or on its own when the yield times out.
    #[private]
    pub fn return_signature_and_clean_state_on_success(
        &mut self,
        index: u64,
        #[callback_result] signature: Result<Value, PromiseError>,
    ) -> PromiseOrValue<Value> {
        match signature {
            Ok(signature) => PromiseOrValue::Value(signature),
            Err(_) => {
                if let Some(request) = self.requests.get_mut(index as usize) {
                    request.open = false;
                }
                let timeout = Self::ext(env::current_account_id())
                    .with_static_gas(FAIL_ON_TIMEOUT_GAS)
                    .with_unused_gas_weight(0)
                    .fail_on_timeout();
                PromiseOrValue::Promise(timeout.as_return())
            }
        }
    }

    #[private]
    pub fn fail_on_timeout(&self) {
        env::panic_str("Signature request has timed out.");
    }

    /// Test control: makes every `sign` fail straight away.
    pub fn set_failing(&mut self, failing: bool) {
        self.failing = failing;
    }

    /// Test control: raises what `sign` needs, as a vote on the real contract could.
    pub fn set_required_tgas(&mut self, tgas: u64) {
        self.required_tgas = tgas;
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn context(deposit: NearToken, gas: Gas) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id("levee.near".parse().unwrap())
            .attached_deposit(deposit)
            .prepaid_gas(gas)
            .build());
    }

    fn one_yocto() -> NearToken {
        NearToken::from_yoctonear(1)
    }

    fn args(payload: &str) -> SignRequestArgs {
        SignRequestArgs {
            path: "levee/v1/1".into(),
            domain_id: 0,
            payload_v2: Payload::Ecdsa(payload.into()),
        }
    }

    /// The unit-test VM charges far more for a yield than the real one, which handles
    /// `sign` on 20 Tgas. Requests that get as far as the yield need more here.
    const YIELDING_TGAS: u64 = 100;

    #[test]
    fn records_a_valid_request() {
        context(one_yocto(), Gas::from_tgas(YIELDING_TGAS));
        let mut signer = MockSigner::default();
        signer.sign(args(&"ab".repeat(32)));
        let requests = signer.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].predecessor.as_str(), "levee.near");
        assert_eq!(requests[0].path, "levee/v1/1");
        assert_eq!(requests[0].deposit, U128(1));
        assert_eq!(requests[0].prepaid_gas_tgas, YIELDING_TGAS);
        assert!(requests[0].open);
    }

    #[test]
    #[should_panic(expected = "domain was not found")]
    fn rejects_another_domain() {
        context(one_yocto(), Gas::from_tgas(20));
        let mut request = args(&"ab".repeat(32));
        request.domain_id = 1;
        MockSigner::default().sign(request);
    }

    #[test]
    #[should_panic(expected = "insufficient gas attached to sign")]
    fn rejects_less_than_the_required_gas() {
        context(one_yocto(), Gas::from_gas(Gas::from_tgas(15).as_gas() - 1));
        MockSigner::default().sign(args(&"ab".repeat(32)));
    }

    #[test]
    #[should_panic(expected = "insufficient deposit attached to sign")]
    fn rejects_no_deposit() {
        context(NearToken::from_yoctonear(0), Gas::from_tgas(20));
        MockSigner::default().sign(args(&"ab".repeat(32)));
    }

    #[test]
    #[should_panic(expected = "payload is not 32 bytes")]
    fn rejects_a_short_payload() {
        context(one_yocto(), Gas::from_tgas(20));
        MockSigner::default().sign(args(&"ab".repeat(31)));
    }

    #[test]
    #[should_panic(expected = "Ecdsa payload cannot be converted to Scalar")]
    fn rejects_a_payload_at_the_curve_order() {
        context(one_yocto(), Gas::from_tgas(20));
        MockSigner::default().sign(args(&hex::encode(SECP256K1_ORDER)));
    }

    #[test]
    fn accepts_the_largest_payload_below_the_curve_order() {
        context(one_yocto(), Gas::from_tgas(YIELDING_TGAS));
        let mut largest = SECP256K1_ORDER;
        largest[31] -= 1;
        MockSigner::default().sign(args(&hex::encode(largest)));
    }

    #[test]
    #[should_panic(expected = "mock signer was told to fail")]
    fn fails_on_request() {
        context(one_yocto(), Gas::from_tgas(20));
        let mut signer = MockSigner::default();
        signer.set_failing(true);
        signer.sign(args(&"ab".repeat(32)));
    }

    #[test]
    #[should_panic(expected = "request is not open")]
    fn cannot_respond_twice() {
        context(one_yocto(), Gas::from_tgas(YIELDING_TGAS));
        let mut signer = MockSigner::default();
        signer.sign(args(&"ab".repeat(32)));
        signer.requests[0].open = false;
        signer.respond(0, Value::Null);
    }
}
