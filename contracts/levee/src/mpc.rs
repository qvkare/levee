//! The MPC signer's wire format.
//!
//! Read from `near/mpc` (`crates/near-mpc-crypto-types`) and checked against live
//! responses from `v1.signer-prod.testnet`. See `fixtures/mpc_sign_response.json`.

use near_sdk::serde::Deserialize;
use near_sdk::{ext_contract, near, serde_json, NearToken};

/// Domain 0 is the secp256k1 key.
pub const ECDSA_DOMAIN_ID: u64 = 0;
/// `sign` requires this much. It comes from the contract's own balance, because a
/// function-call key cannot attach a deposit.
pub const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// A real response is about 190 bytes. Anything far larger is not a signature, and
/// the bound keeps a misbehaving signer from burning the callback's gas.
pub const MAX_RESPONSE_BYTES: usize = 1_024;

const SECP256K1_SCHEME: &str = "Secp256k1";

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignRequest {
    pub path: String,
    pub domain_id: u64,
    pub payload_v2: SignPayload,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignPayload {
    /// 32 bytes as bare lowercase hex. Signed as given, with no further hashing.
    Ecdsa(String),
}

#[ext_contract(ext_mpc)]
pub trait MpcSigner {
    fn sign(&mut self, request: SignRequest);
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct SignResponse {
    scheme: String,
    big_r: AffinePoint,
    s: Scalar,
    recovery_id: u8,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct AffinePoint {
    affine_point: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Scalar {
    scalar: String,
}

/// A validated signature, in the hex form Levee publishes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signature {
    /// `0x`-prefixed compressed point, 33 bytes. `r` is bytes 1..33.
    pub big_r: String,
    /// `0x`-prefixed low-s scalar, 32 bytes.
    pub s: String,
    /// The EIP-1559 `y_parity`.
    pub recovery_id: u8,
}

/// Parses an MPC response, or `None` if it is not a usable secp256k1 signature.
pub fn parse_signature(response: &[u8]) -> Option<Signature> {
    let response: SignResponse = serde_json::from_slice(response).ok()?;
    if response.scheme != SECP256K1_SCHEME {
        return None;
    }
    let big_r: [u8; 33] = decode_hex(&response.big_r.affine_point)?;
    if !matches!(big_r[0], 0x02 | 0x03) {
        return None;
    }
    let s: [u8; 32] = decode_hex(&response.s.scalar)?;
    // Only parities 0 and 1 can go into an EIP-1559 transaction.
    if response.recovery_id > 1 {
        return None;
    }
    Some(Signature {
        big_r: format!("0x{}", hex::encode(big_r)),
        s: format!("0x{}", hex::encode(s)),
        recovery_id: response.recovery_id,
    })
}

fn decode_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    let mut out = [0u8; N];
    hex::decode_to_slice(value, &mut out).ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE: &str = include_str!("../fixtures/mpc_sign_response.json");

    fn live_response() -> Vec<u8> {
        let fixture: serde_json::Value = serde_json::from_str(LIVE).unwrap();
        serde_json::to_vec(&fixture["response"]).unwrap()
    }

    fn response(big_r: &str, s: &str, recovery_id: u8) -> Vec<u8> {
        format!(
            r#"{{"scheme":"Secp256k1","big_r":{{"affine_point":"{big_r}"}},"s":{{"scalar":"{s}"}},"recovery_id":{recovery_id}}}"#
        )
        .into_bytes()
    }

    fn big_r() -> String {
        format!("02{}", "ab".repeat(32))
    }

    fn scalar() -> String {
        "cd".repeat(32)
    }

    #[test]
    fn parses_a_real_response_from_the_live_signer() {
        let signature = parse_signature(&live_response()).unwrap();
        assert_eq!(
            signature,
            Signature {
                big_r: "0x03f801266a516fbdef4a890b10ca39cbbfa959320412d3126e5bd0fa05ded238d3"
                    .into(),
                s: "0x4071aa91247451c43e29f2bc1fbbdfcae2d06b0e36e2b2ceefb0a8a64d388f86".into(),
                recovery_id: 1,
            }
        );
    }

    #[test]
    fn serialises_the_request_as_the_signer_expects() {
        let request = SignRequest {
            path: "levee/v1/1".into(),
            domain_id: ECDSA_DOMAIN_ID,
            payload_v2: SignPayload::Ecdsa("ab".repeat(32)),
        };
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            serde_json::json!({
                "path": "levee/v1/1",
                "domain_id": 0,
                "payload_v2": { "Ecdsa": "ab".repeat(32) },
            })
        );
    }

    #[test]
    fn matches_the_shape_of_a_real_request() {
        let fixture: serde_json::Value = serde_json::from_str(LIVE).unwrap();
        let live = &fixture["request"]["request"];
        let request = SignRequest {
            path: live["path"].as_str().unwrap().into(),
            domain_id: live["domain_id"].as_u64().unwrap(),
            payload_v2: SignPayload::Ecdsa(
                live["payload_v2"]["Ecdsa"].as_str().unwrap().into(),
            ),
        };
        assert_eq!(&serde_json::to_value(&request).unwrap(), live);
    }

    #[test]
    fn uppercase_hex_comes_out_lowercase() {
        let upper = response(&big_r().to_uppercase(), &scalar().to_uppercase(), 0);
        let signature = parse_signature(&upper).unwrap();
        assert_eq!(signature.big_r, format!("0x{}", big_r()));
        assert_eq!(signature.s, format!("0x{}", scalar()));
    }

    #[test]
    fn accepts_both_point_prefixes_and_parities() {
        let even = response(&format!("02{}", "ab".repeat(32)), &scalar(), 0);
        let odd = response(&format!("03{}", "ab".repeat(32)), &scalar(), 1);
        assert_eq!(parse_signature(&even).unwrap().recovery_id, 0);
        assert_eq!(parse_signature(&odd).unwrap().recovery_id, 1);
    }

    #[test]
    fn rejects_a_point_that_is_not_compressed() {
        let bad = response(&format!("04{}", "ab".repeat(32)), &scalar(), 0);
        assert_eq!(parse_signature(&bad), None);
    }

    #[test]
    fn rejects_the_wrong_lengths() {
        assert_eq!(parse_signature(&response(&"02".repeat(32), &scalar(), 0)), None);
        assert_eq!(parse_signature(&response(&big_r(), &"cd".repeat(31), 0)), None);
        assert_eq!(parse_signature(&response(&big_r(), &"cd".repeat(33), 0)), None);
    }

    #[test]
    fn rejects_non_hex() {
        assert_eq!(parse_signature(&response(&big_r(), &"zz".repeat(32), 0)), None);
    }

    #[test]
    fn rejects_a_parity_that_cannot_go_in_a_transaction() {
        assert_eq!(parse_signature(&response(&big_r(), &scalar(), 2)), None);
        assert_eq!(parse_signature(&response(&big_r(), &scalar(), 3)), None);
    }

    #[test]
    fn rejects_another_scheme() {
        let ed25519 = br#"{"scheme":"Ed25519","signature":[1,2,3]}"#;
        assert_eq!(parse_signature(ed25519), None);
    }

    #[test]
    fn rejects_junk() {
        assert_eq!(parse_signature(b""), None);
        assert_eq!(parse_signature(b"null"), None);
        assert_eq!(parse_signature(b"not json"), None);
        assert_eq!(parse_signature(b"{}"), None);
    }
}
