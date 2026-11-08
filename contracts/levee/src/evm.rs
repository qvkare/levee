//! Builds the EVM transactions Levee signs.
//!
//! Every byte of calldata and every target is decided here, from stored
//! configuration. Callers supply amounts and fees, never calldata, a target or a
//! payload, so these functions are the whole of what the rescuer can be made to do.

use near_sdk::env;

use crate::address::Address;
use crate::rlp;

pub const SELECTOR_APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
pub const SELECTOR_TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
pub const SELECTOR_REPAY: [u8; 4] = [0x57, 0x3a, 0xde, 0x81];
/// `unwind(address,address,uint256,uint24,uint256)` on the `LeveeUnwind` helper.
pub const SELECTOR_UNWIND: [u8; 4] = [0x65, 0xaf, 0xae, 0x08];

/// Aave `interestRateMode` for variable-rate debt.
pub const VARIABLE_RATE_MODE: u128 = 2;

const EIP1559_TX_TYPE: u8 = 0x02;
const SELECTOR_LEN: usize = 4;
const WORD_LEN: usize = 32;

/// `approve(address,uint256)`.
pub fn approve_calldata(spender: &Address, amount: u128) -> Vec<u8> {
    let mut data = Vec::with_capacity(SELECTOR_LEN + 2 * WORD_LEN);
    data.extend_from_slice(&SELECTOR_APPROVE);
    push_address_word(&mut data, spender);
    push_uint_word(&mut data, amount);
    data
}

/// `transfer(address,uint256)`.
pub fn transfer_calldata(to: &Address, amount: u128) -> Vec<u8> {
    let mut data = Vec::with_capacity(SELECTOR_LEN + 2 * WORD_LEN);
    data.extend_from_slice(&SELECTOR_TRANSFER);
    push_address_word(&mut data, to);
    push_uint_word(&mut data, amount);
    data
}

/// `repay(address,uint256,uint256,address)` against variable-rate debt.
pub fn repay_calldata(asset: &Address, amount: u128, on_behalf_of: &Address) -> Vec<u8> {
    let mut data = Vec::with_capacity(SELECTOR_LEN + 4 * WORD_LEN);
    data.extend_from_slice(&SELECTOR_REPAY);
    push_address_word(&mut data, asset);
    push_uint_word(&mut data, amount);
    push_uint_word(&mut data, VARIABLE_RATE_MODE);
    push_address_word(&mut data, on_behalf_of);
    data
}

/// `unwind(address,address,uint256,uint24,uint256)`. A `uint24` takes a whole word,
/// like any static type. `pool_fee` is validated at `register`, so it always fits.
/// `max_sold` is the keeper's cap on the collateral sold, in its base units.
pub fn unwind_calldata(
    borrower: &Address,
    collateral: &Address,
    amount: u128,
    pool_fee: u32,
    max_sold: u128,
) -> Vec<u8> {
    let mut data = Vec::with_capacity(SELECTOR_LEN + 5 * WORD_LEN);
    data.extend_from_slice(&SELECTOR_UNWIND);
    push_address_word(&mut data, borrower);
    push_address_word(&mut data, collateral);
    push_uint_word(&mut data, amount);
    push_uint_word(&mut data, u128::from(pool_fee));
    push_uint_word(&mut data, max_sold);
    data
}

fn push_address_word(data: &mut Vec<u8>, address: &Address) {
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(address);
}

fn push_uint_word(data: &mut Vec<u8>, value: u128) {
    data.extend_from_slice(&[0u8; 16]);
    data.extend_from_slice(&value.to_be_bytes());
}

/// An unsigned EIP-1559 transaction. The access list is always empty.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Eip1559Tx {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub to: Address,
    pub value: u128,
    pub data: Vec<u8>,
}

impl Eip1559Tx {
    /// `0x02 || rlp([chain_id, nonce, priority fee, max fee, gas limit, to, value,
    /// data, access list])`.
    pub fn unsigned_bytes(&self) -> Vec<u8> {
        let mut fields = Vec::with_capacity(self.data.len() + 96);
        rlp::encode_uint(&mut fields, self.chain_id.into());
        rlp::encode_uint(&mut fields, self.nonce.into());
        rlp::encode_uint(&mut fields, self.max_priority_fee_per_gas);
        rlp::encode_uint(&mut fields, self.max_fee_per_gas);
        rlp::encode_uint(&mut fields, self.gas_limit.into());
        rlp::encode_bytes(&mut fields, &self.to);
        rlp::encode_uint(&mut fields, self.value);
        rlp::encode_bytes(&mut fields, &self.data);
        rlp::encode_list(&mut fields, &[]);

        let mut out = Vec::with_capacity(fields.len() + 4);
        out.push(EIP1559_TX_TYPE);
        rlp::encode_list(&mut out, &fields);
        out
    }
}

/// The hash the rescuer key signs: `keccak256(unsigned_tx)`.
pub fn signing_hash(unsigned_tx: &[u8]) -> [u8; 32] {
    env::keccak256_array(unsigned_tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    const POOL: Address = [0x11; 20];
    const USDC: Address = [0x22; 20];
    const BORROWER: Address = [0x33; 20];
    const COLLATERAL: Address = [0x44; 20];

    fn word(value: u128) -> Vec<u8> {
        let mut out = vec![0u8; 16];
        out.extend_from_slice(&value.to_be_bytes());
        out
    }

    fn address_word(address: &Address) -> Vec<u8> {
        let mut out = vec![0u8; 12];
        out.extend_from_slice(address);
        out
    }

    #[test]
    fn approve_is_selector_spender_amount() {
        let data = approve_calldata(&POOL, 2_500_000);
        assert_eq!(data.len(), 68);
        assert_eq!(data[..4], SELECTOR_APPROVE);
        assert_eq!(data[4..36], address_word(&POOL)[..]);
        assert_eq!(data[36..68], word(2_500_000)[..]);
    }

    #[test]
    fn transfer_is_selector_to_amount() {
        let data = transfer_calldata(&BORROWER, 7);
        assert_eq!(data.len(), 68);
        assert_eq!(data[..4], SELECTOR_TRANSFER);
        assert_eq!(data[4..36], address_word(&BORROWER)[..]);
        assert_eq!(data[36..68], word(7)[..]);
    }

    #[test]
    fn repay_is_selector_asset_amount_mode_on_behalf_of() {
        let data = repay_calldata(&USDC, 2_500_000, &BORROWER);
        assert_eq!(data.len(), 132);
        assert_eq!(data[..4], SELECTOR_REPAY);
        assert_eq!(data[4..36], address_word(&USDC)[..]);
        assert_eq!(data[36..68], word(2_500_000)[..]);
        assert_eq!(data[68..100], word(2)[..]);
        assert_eq!(data[100..132], address_word(&BORROWER)[..]);
    }

    #[test]
    fn unwind_is_selector_borrower_collateral_amount_fee_max_sold() {
        let data = unwind_calldata(
            &BORROWER,
            &COLLATERAL,
            2_500_000,
            3_000,
            1_116_000_000_000_000_000,
        );
        assert_eq!(data.len(), 164);
        assert_eq!(data[..4], SELECTOR_UNWIND);
        assert_eq!(data[4..36], address_word(&BORROWER)[..]);
        assert_eq!(data[36..68], address_word(&COLLATERAL)[..]);
        assert_eq!(data[68..100], word(2_500_000)[..]);
        assert_eq!(data[100..132], word(3_000)[..]);
        assert_eq!(data[132..164], word(1_116_000_000_000_000_000)[..]);
    }

    /// The selector is the first four bytes of the keccak of the signature, computed
    /// here by a keccak that shares nothing with the contract's.
    #[test]
    fn the_unwind_selector_is_the_keccak_of_its_signature() {
        use sha3::{Digest, Keccak256};
        let digest = Keccak256::digest(b"unwind(address,address,uint256,uint24,uint256)");
        assert_eq!(digest[..4], SELECTOR_UNWIND);
        let repay = Keccak256::digest(b"repay(address,uint256,uint256,address)");
        assert_eq!(repay[..4], SELECTOR_REPAY);
    }

    /// From `cast calldata "unwind(address,address,uint256,uint24,uint256)"
    /// 0x1234567890AbcdEF1234567890aBcdef12345678
    /// 0x4200000000000000000000000000000000000006 2500000 3000 1116000000000000000`,
    /// cast 1.5.1.
    #[test]
    fn unwind_matches_cast_byte_for_byte() {
        let expected = concat!(
            "65afae08",
            "0000000000000000000000001234567890abcdef1234567890abcdef12345678",
            "0000000000000000000000004200000000000000000000000000000000000006",
            "00000000000000000000000000000000000000000000000000000000002625a0",
            "0000000000000000000000000000000000000000000000000000000000000bb8",
            "0000000000000000000000000000000000000000000000000f7cd41651560000",
        );
        let borrower =
            crate::address::parse_address("0x1234567890abcdef1234567890abcdef12345678").unwrap();
        let weth =
            crate::address::parse_address("0x4200000000000000000000000000000000000006").unwrap();
        assert_eq!(
            hex::encode(unwind_calldata(
                &borrower,
                &weth,
                2_500_000,
                3_000,
                1_116_000_000_000_000_000
            )),
            expected
        );
    }

    #[test]
    fn unwind_encodes_every_allowed_fee_tier_as_a_word() {
        for fee in [100u32, 500, 3_000, 10_000] {
            let data = unwind_calldata(&BORROWER, &COLLATERAL, 1, fee, 1);
            assert_eq!(data[100..132], word(u128::from(fee))[..]);
        }
    }

    #[test]
    fn unwind_carries_the_largest_max_sold() {
        let data = unwind_calldata(&BORROWER, &COLLATERAL, 1, 500, u128::MAX);
        assert_eq!(data[132..148], [0u8; 16]);
        assert_eq!(data[148..164], [0xff; 16]);
    }

    #[test]
    fn calldata_carries_the_largest_amount() {
        let data = repay_calldata(&USDC, u128::MAX, &BORROWER);
        assert_eq!(data[36..52], [0u8; 16]);
        assert_eq!(data[52..68], [0xff; 16]);
    }

    #[test]
    fn unsigned_tx_starts_with_the_type_byte_and_a_long_list() {
        let tx = Eip1559Tx {
            chain_id: 8453,
            nonce: 0,
            max_priority_fee_per_gas: 1,
            max_fee_per_gas: 2,
            gas_limit: 300_000,
            to: POOL,
            value: 0,
            data: repay_calldata(&USDC, 1, &BORROWER),
        };
        let unsigned = tx.unsigned_bytes();
        assert_eq!(unsigned[0], 0x02);
        assert_eq!(unsigned[1], 0xf8);
        assert_eq!(unsigned[2] as usize, unsigned.len() - 3);
    }

    #[test]
    fn empty_access_list_is_the_last_byte() {
        let tx = Eip1559Tx {
            chain_id: 1,
            nonce: 1,
            max_priority_fee_per_gas: 1,
            max_fee_per_gas: 1,
            gas_limit: 21_000,
            to: BORROWER,
            value: 1,
            data: Vec::new(),
        };
        assert_eq!(*tx.unsigned_bytes().last().unwrap(), 0xc0);
    }
}
