//! The five transactions a position can sign, built from stored configuration.
//!
//! Each function takes the amount and fees, and everything else comes from the
//! chain config or the position. There is no way to pass a target or calldata.

use near_sdk::env;

use crate::address::{parse_address, Address};
use crate::evm::{approve_calldata, repay_calldata, transfer_calldata, unwind_calldata, Eip1559Tx};
use crate::types::{ChainConfig, CollateralConfig, Fees, Position};

/// Addresses are validated before they are stored, so this cannot fail.
fn stored_address(value: &str) -> Address {
    parse_address(value).unwrap_or_else(|err| env::panic_str(err))
}

fn tx(
    chain: &ChainConfig,
    fees: &Fees,
    gas_limit: u64,
    to: Address,
    value: u128,
    data: Vec<u8>,
) -> Eip1559Tx {
    Eip1559Tx {
        chain_id: chain.chain_id,
        nonce: fees.nonce,
        max_priority_fee_per_gas: fees.max_priority_fee_per_gas.0,
        max_fee_per_gas: fees.max_fee_per_gas.0,
        gas_limit,
        to,
        value,
        data,
    }
}

/// `Pool.repay(USDC, amount, 2, borrower)`.
pub fn repay_tx(chain: &ChainConfig, position: &Position, amount: u128, fees: &Fees) -> Eip1559Tx {
    let usdc = stored_address(&chain.usdc);
    let borrower = stored_address(&position.borrower);
    tx(
        chain,
        fees,
        chain.gas_limit_repay,
        stored_address(&chain.pool),
        0,
        repay_calldata(&usdc, amount, &borrower),
    )
}

/// `LeveeUnwind.unwind(borrower, collateral, amount, pool_fee)`. `collateral` is the
/// position's own, which the caller has already read from it.
pub fn unwind_tx(
    chain: &ChainConfig,
    position: &Position,
    collateral: &CollateralConfig,
    amount: u128,
    fees: &Fees,
) -> Eip1559Tx {
    let borrower = stored_address(&position.borrower);
    let asset = stored_address(&collateral.asset);
    tx(
        chain,
        fees,
        chain.gas_limit_unwind,
        stored_address(&chain.unwind),
        0,
        unwind_calldata(&borrower, &asset, amount, collateral.pool_fee),
    )
}

/// `USDC.approve(Pool, amount)`.
pub fn approve_tx(chain: &ChainConfig, amount: u128, fees: &Fees) -> Eip1559Tx {
    let pool = stored_address(&chain.pool);
    tx(
        chain,
        fees,
        chain.gas_limit_approve,
        stored_address(&chain.usdc),
        0,
        approve_calldata(&pool, amount),
    )
}

/// `USDC.transfer(borrower, amount)`.
pub fn transfer_tx(
    chain: &ChainConfig,
    position: &Position,
    amount: u128,
    fees: &Fees,
) -> Eip1559Tx {
    let borrower = stored_address(&position.borrower);
    tx(
        chain,
        fees,
        chain.gas_limit_transfer,
        stored_address(&chain.usdc),
        0,
        transfer_calldata(&borrower, amount),
    )
}

/// A plain value transfer to the borrower.
pub fn sweep_tx(
    chain: &ChainConfig,
    position: &Position,
    amount_wei: u128,
    fees: &Fees,
) -> Eip1559Tx {
    tx(
        chain,
        fees,
        chain.gas_limit_transfer,
        stored_address(&position.borrower),
        amount_wei,
        Vec::new(),
    )
}
