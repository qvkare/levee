//! The rules of a position, as pure functions of its state and the clock.
//!
//! Nothing here touches the chain, so each rule is testable on its own boundary.
//! The contract calls these and nothing else decides whether a rule holds.

use near_sdk::json_types::U128;

use crate::address::normalise_address;
use crate::types::{ChainConfig, CollateralConfig, Fees, PendingLoosen, Position, Reservation};

pub const NANOS_PER_SEC: u64 = 1_000_000_000;
pub const NANOS_PER_DAY: u64 = 86_400 * NANOS_PER_SEC;
/// How long a loosening waits before it can be applied.
pub const LOOSEN_DELAY_NANOS: u64 = NANOS_PER_DAY;
/// `prepare_allowance` may approve this many days of `max_per_day`.
pub const ALLOWANCE_DAYS: u128 = 30;
/// The Uniswap v3 fee tiers a collateral pool may use, in hundredths of a basis point.
pub const POOL_FEES: [u32; 4] = [100, 500, 3_000, 10_000];

pub const ERR_PAUSED: &str = "position is paused";
pub const ERR_ZERO_AMOUNT: &str = "amount must be above zero";
pub const ERR_OVER_MAX_PER_RESCUE: &str = "amount exceeds max_per_rescue";
pub const ERR_OVER_DAILY_BUDGET: &str = "amount exceeds the daily budget";
pub const ERR_COOLDOWN: &str = "cooldown has not elapsed";
pub const ERR_MAX_FEE_CEILING: &str = "max_fee_per_gas exceeds the chain ceiling";
pub const ERR_PRIORITY_FEE_CEILING: &str = "max_priority_fee_per_gas exceeds the chain ceiling";
pub const ERR_PRIORITY_OVER_MAX_FEE: &str = "max_priority_fee_per_gas exceeds max_fee_per_gas";
pub const ERR_OVER_MAX_ALLOWANCE: &str = "amount exceeds 30 times max_per_day";
pub const ERR_TIGHTEN_MAX_PER_RESCUE: &str = "max_per_rescue may only decrease";
pub const ERR_TIGHTEN_MAX_PER_DAY: &str = "max_per_day may only decrease";
pub const ERR_TIGHTEN_COOLDOWN: &str = "cooldown_secs may only increase";
pub const ERR_LOOSEN_MAX_PER_RESCUE: &str = "max_per_rescue may only increase";
pub const ERR_LOOSEN_MAX_PER_DAY: &str = "max_per_day may only increase";
pub const ERR_LOOSEN_COOLDOWN: &str = "cooldown_secs may only decrease";
pub const ERR_NOTHING_TO_LOOSEN: &str = "no value is being loosened";
pub const ERR_NO_PENDING_LOOSEN: &str = "no loosening is queued";
pub const ERR_LOOSEN_NOT_READY: &str = "the loosening delay has not elapsed";
pub const ERR_POOL_FEE: &str = "pool_fee must be 100, 500, 3000 or 10000";
pub const ERR_COLLATERAL_IS_USDC: &str =
    "the collateral cannot be USDC, which is what it is sold for";
pub const ERR_NO_COLLATERAL: &str = "position has no collateral config";
pub const ERR_ZERO_MAX_SOLD: &str = "max_sold must be above zero";

/// The UTC day bucket of a block timestamp.
pub fn utc_day(now: u64) -> u64 {
    now / NANOS_PER_DAY
}

/// What the position has spent in `day`. A stored bucket from another day is stale.
pub fn spent_on(position: &Position, day: u64) -> u128 {
    if position.day == day {
        position.spent_today.0
    } else {
        0
    }
}

/// Rule 6, plus the EIP-1559 rule that a priority fee cannot exceed the max fee.
/// A transaction breaking that can never be included, so signing it would only
/// burn budget.
pub fn check_fees(chain: &ChainConfig, fees: &Fees) -> Result<(), &'static str> {
    if fees.max_fee_per_gas.0 > chain.max_fee_per_gas_ceiling.0 {
        return Err(ERR_MAX_FEE_CEILING);
    }
    if fees.max_priority_fee_per_gas.0 > chain.max_priority_fee_ceiling.0 {
        return Err(ERR_PRIORITY_FEE_CEILING);
    }
    if fees.max_priority_fee_per_gas.0 > fees.max_fee_per_gas.0 {
        return Err(ERR_PRIORITY_OVER_MAX_FEE);
    }
    Ok(())
}

/// Rules 2 to 6 of `rescue`. Rule 1, the caller, needs the runtime and is checked
/// by the contract. Returns what to hold while the signature is outstanding.
pub fn check_rescue(
    position: &Position,
    chain: &ChainConfig,
    amount: u128,
    fees: &Fees,
    now: u64,
) -> Result<Reservation, &'static str> {
    if position.paused {
        return Err(ERR_PAUSED);
    }
    if amount == 0 {
        return Err(ERR_ZERO_AMOUNT);
    }
    if amount > position.max_per_rescue.0 {
        return Err(ERR_OVER_MAX_PER_RESCUE);
    }
    let day = utc_day(now);
    let spent = spent_on(position, day)
        .checked_add(amount)
        .ok_or(ERR_OVER_DAILY_BUDGET)?;
    if spent > position.max_per_day.0 {
        return Err(ERR_OVER_DAILY_BUDGET);
    }
    let cooldown = u64::from(position.cooldown_secs) * NANOS_PER_SEC;
    if now.saturating_sub(position.last_rescue_at) < cooldown {
        return Err(ERR_COOLDOWN);
    }
    check_fees(chain, fees)?;
    Ok(Reservation {
        amount: U128(amount),
        day,
        at: now,
        previous_at: position.last_rescue_at,
    })
}

/// Charges a reservation to the position.
pub fn reserve(position: &mut Position, reservation: &Reservation) {
    let spent = spent_on(position, reservation.day) + reservation.amount.0;
    position.spent_today = U128(spent);
    position.day = reservation.day;
    position.last_rescue_at = reservation.at;
}

/// Undoes a reservation after the signature failed, and returns the amount given
/// back. Time may have moved on while the signature was outstanding, so:
///
/// - a charge to an earlier day is left alone, because subtracting it from a newer
///   bucket would hand out budget that was never spent there;
/// - the cooldown is restored only if no later rescue has taken the slot since.
pub fn release(position: &mut Position, reservation: &Reservation) -> u128 {
    let released = if position.day == reservation.day {
        reservation.amount.0.min(position.spent_today.0)
    } else {
        0
    };
    position.spent_today = U128(position.spent_today.0 - released);
    if position.last_rescue_at == reservation.at {
        position.last_rescue_at = reservation.previous_at;
    }
    released
}

/// A collateral config as `register` stores it: the asset is a strict address, stored
/// lowercase, and is not the USDC it would be sold for. The fee is a Uniswap v3 tier.
pub fn validate_collateral(
    chain: &ChainConfig,
    collateral: CollateralConfig,
) -> Result<CollateralConfig, &'static str> {
    let asset = normalise_address(&collateral.asset)?;
    if asset == chain.usdc {
        return Err(ERR_COLLATERAL_IS_USDC);
    }
    if !POOL_FEES.contains(&collateral.pool_fee) {
        return Err(ERR_POOL_FEE);
    }
    Ok(CollateralConfig {
        asset,
        pool_fee: collateral.pool_fee,
    })
}

/// What `rescue_from_collateral` may sell, or why it cannot run for this position.
pub fn collateral_of(position: &Position) -> Result<&CollateralConfig, &'static str> {
    position.collateral.as_ref().ok_or(ERR_NO_COLLATERAL)
}

/// `max_sold`, the keeper's cap on the collateral an unwind may sell. The contract has
/// no price to judge it by, so it only refuses zero, which the helper would refuse too.
/// The helper also applies the borrower's slippage bound, so a larger cap cannot loosen
/// that.
pub fn check_max_sold(max_sold: u128) -> Result<(), &'static str> {
    if max_sold == 0 {
        return Err(ERR_ZERO_MAX_SOLD);
    }
    Ok(())
}

/// `tighten`: each value may stay the same or get stricter.
pub fn check_tighten(
    position: &Position,
    max_per_rescue: u128,
    max_per_day: u128,
    cooldown_secs: u32,
) -> Result<(), &'static str> {
    if max_per_rescue > position.max_per_rescue.0 {
        return Err(ERR_TIGHTEN_MAX_PER_RESCUE);
    }
    if max_per_day > position.max_per_day.0 {
        return Err(ERR_TIGHTEN_MAX_PER_DAY);
    }
    if cooldown_secs < position.cooldown_secs {
        return Err(ERR_TIGHTEN_COOLDOWN);
    }
    Ok(())
}

/// `queue_loosen`: each value may stay the same or get looser, and at least one
/// has to change. Stricter values belong in `tighten`, which needs no delay.
pub fn check_loosen(
    position: &Position,
    max_per_rescue: u128,
    max_per_day: u128,
    cooldown_secs: u32,
) -> Result<(), &'static str> {
    if max_per_rescue < position.max_per_rescue.0 {
        return Err(ERR_LOOSEN_MAX_PER_RESCUE);
    }
    if max_per_day < position.max_per_day.0 {
        return Err(ERR_LOOSEN_MAX_PER_DAY);
    }
    if cooldown_secs > position.cooldown_secs {
        return Err(ERR_LOOSEN_COOLDOWN);
    }
    let unchanged = max_per_rescue == position.max_per_rescue.0
        && max_per_day == position.max_per_day.0
        && cooldown_secs == position.cooldown_secs;
    if unchanged {
        return Err(ERR_NOTHING_TO_LOOSEN);
    }
    Ok(())
}

/// `apply_loosen`: returns the queued caps once their delay has passed.
pub fn ready_loosen(position: &Position, now: u64) -> Result<&PendingLoosen, &'static str> {
    let pending = position
        .pending_loosen
        .as_ref()
        .ok_or(ERR_NO_PENDING_LOOSEN)?;
    if now < pending.ready_at {
        return Err(ERR_LOOSEN_NOT_READY);
    }
    Ok(pending)
}

/// The most `prepare_allowance` may approve.
pub fn max_allowance(position: &Position) -> u128 {
    position.max_per_day.0.saturating_mul(ALLOWANCE_DAYS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::AccountId;

    /// 2026-11-07 12:00:00 UTC.
    const NOON: u64 = 1_794_052_800 * NANOS_PER_SEC;
    const HOUR: u64 = 3_600 * NANOS_PER_SEC;

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn chain() -> ChainConfig {
        ChainConfig {
            chain_id: 8453,
            pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5".into(),
            usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913".into(),
            unwind: "0x5555555555555555555555555555555555555555".into(),
            max_fee_per_gas_ceiling: U128(1_000),
            max_priority_fee_ceiling: U128(100),
            gas_limit_approve: 70_000,
            gas_limit_repay: 350_000,
            gas_limit_transfer: 80_000,
            gas_limit_unwind: 600_000,
        }
    }

    fn position() -> Position {
        Position {
            owner: account("owner.near"),
            keeper: account("keeper.near"),
            chain_id: 8453,
            borrower: "0x1234567890abcdef1234567890abcdef12345678".into(),
            collateral: None,
            max_per_rescue: U128(100),
            max_per_day: U128(250),
            cooldown_secs: 60,
            paused: false,
            spent_today: U128(0),
            day: utc_day(NOON),
            last_rescue_at: 0,
            pending_loosen: None,
        }
    }

    fn fees() -> Fees {
        Fees {
            nonce: 1,
            max_fee_per_gas: U128(1_000),
            max_priority_fee_per_gas: U128(100),
        }
    }

    fn check(position: &Position, amount: u128, now: u64) -> Result<Reservation, &'static str> {
        check_rescue(position, &chain(), amount, &fees(), now)
    }

    #[test]
    fn the_noon_constant_is_noon() {
        assert_eq!(NOON % NANOS_PER_DAY, 12 * HOUR);
    }

    #[test]
    fn a_valid_rescue_is_reserved_at_the_current_time() {
        let reservation = check(&position(), 100, NOON).unwrap();
        assert_eq!(
            reservation,
            Reservation {
                amount: U128(100),
                day: utc_day(NOON),
                at: NOON,
                previous_at: 0,
            }
        );
    }

    #[test]
    fn rule_2_a_paused_position_cannot_rescue() {
        let mut position = position();
        position.paused = true;
        assert_eq!(check(&position, 1, NOON), Err(ERR_PAUSED));
    }

    #[test]
    fn rule_3_rejects_zero() {
        assert_eq!(check(&position(), 0, NOON), Err(ERR_ZERO_AMOUNT));
    }

    #[test]
    fn rule_3_accepts_one() {
        assert!(check(&position(), 1, NOON).is_ok());
    }

    #[test]
    fn rule_3_boundary_is_inclusive() {
        assert!(check(&position(), 100, NOON).is_ok());
        assert_eq!(check(&position(), 101, NOON), Err(ERR_OVER_MAX_PER_RESCUE));
    }

    #[test]
    fn rule_4_boundary_is_inclusive() {
        let mut position = position();
        position.spent_today = U128(150);
        assert!(check(&position, 100, NOON).is_ok());
        position.spent_today = U128(151);
        assert_eq!(check(&position, 100, NOON), Err(ERR_OVER_DAILY_BUDGET));
    }

    #[test]
    fn rule_4_spend_from_another_day_does_not_count() {
        let mut position = position();
        position.spent_today = U128(250);
        position.day = utc_day(NOON) - 1;
        assert!(check(&position, 100, NOON).is_ok());
    }

    #[test]
    fn rule_4_bucket_changes_exactly_at_midnight() {
        let midnight = (utc_day(NOON) + 1) * NANOS_PER_DAY;
        let mut position = position();
        position.spent_today = U128(250);
        assert_eq!(utc_day(midnight - 1), utc_day(NOON));
        assert_eq!(
            check(&position, 1, midnight - 1),
            Err(ERR_OVER_DAILY_BUDGET)
        );
        assert!(check(&position, 1, midnight).is_ok());
    }

    #[test]
    fn rule_4_overflow_is_a_rejection_not_a_wrap() {
        let mut position = position();
        position.max_per_rescue = U128(u128::MAX);
        position.max_per_day = U128(u128::MAX);
        position.spent_today = U128(u128::MAX);
        assert_eq!(check(&position, 1, NOON), Err(ERR_OVER_DAILY_BUDGET));
    }

    #[test]
    fn rule_4_tightening_below_spend_stops_further_rescues_that_day() {
        let mut position = position();
        position.spent_today = U128(200);
        position.max_per_day = U128(100);
        assert_eq!(check(&position, 1, NOON), Err(ERR_OVER_DAILY_BUDGET));
    }

    #[test]
    fn rule_5_boundary_is_inclusive() {
        let mut position = position();
        position.last_rescue_at = NOON;
        let elapsed = NOON + 60 * NANOS_PER_SEC;
        assert!(check(&position, 1, elapsed).is_ok());
        assert_eq!(check(&position, 1, elapsed - 1), Err(ERR_COOLDOWN));
    }

    #[test]
    fn rule_5_converts_seconds_to_nanoseconds() {
        let mut position = position();
        position.last_rescue_at = NOON;
        // Sixty nanoseconds is not sixty seconds.
        assert_eq!(check(&position, 1, NOON + 60), Err(ERR_COOLDOWN));
    }

    #[test]
    fn rule_5_zero_cooldown_allows_the_same_block() {
        let mut position = position();
        position.cooldown_secs = 0;
        position.last_rescue_at = NOON;
        assert!(check(&position, 1, NOON).is_ok());
    }

    #[test]
    fn rule_5_largest_cooldown_does_not_overflow() {
        let mut position = position();
        position.cooldown_secs = u32::MAX;
        position.last_rescue_at = NOON;
        assert_eq!(check(&position, 1, NOON + 1), Err(ERR_COOLDOWN));
    }

    #[test]
    fn rule_6_max_fee_boundary_is_inclusive() {
        assert!(check_fees(&chain(), &fees()).is_ok());
        let mut over = fees();
        over.max_fee_per_gas = U128(1_001);
        assert_eq!(check_fees(&chain(), &over), Err(ERR_MAX_FEE_CEILING));
    }

    #[test]
    fn rule_6_priority_fee_boundary_is_inclusive() {
        let mut over = fees();
        over.max_priority_fee_per_gas = U128(101);
        assert_eq!(check_fees(&chain(), &over), Err(ERR_PRIORITY_FEE_CEILING));
    }

    #[test]
    fn rule_6_is_enforced_by_check_rescue() {
        let mut over = fees();
        over.max_fee_per_gas = U128(1_001);
        assert_eq!(
            check_rescue(&position(), &chain(), 1, &over, NOON),
            Err(ERR_MAX_FEE_CEILING)
        );
    }

    #[test]
    fn a_priority_fee_above_the_max_fee_is_rejected() {
        let inverted = Fees {
            nonce: 1,
            max_fee_per_gas: U128(50),
            max_priority_fee_per_gas: U128(51),
        };
        assert_eq!(
            check_fees(&chain(), &inverted),
            Err(ERR_PRIORITY_OVER_MAX_FEE)
        );
    }

    #[test]
    fn a_priority_fee_equal_to_the_max_fee_is_accepted() {
        let equal = Fees {
            nonce: 1,
            max_fee_per_gas: U128(50),
            max_priority_fee_per_gas: U128(50),
        };
        assert!(check_fees(&chain(), &equal).is_ok());
    }

    #[test]
    fn reserve_charges_the_amount_and_starts_the_cooldown() {
        let mut position = position();
        let reservation = check(&position, 100, NOON).unwrap();
        reserve(&mut position, &reservation);
        assert_eq!(position.spent_today, U128(100));
        assert_eq!(position.last_rescue_at, NOON);
    }

    #[test]
    fn reserve_starts_a_new_bucket_on_a_new_day() {
        let mut position = position();
        position.spent_today = U128(250);
        position.day = utc_day(NOON) - 3;
        let reservation = check(&position, 40, NOON).unwrap();
        reserve(&mut position, &reservation);
        assert_eq!(position.spent_today, U128(40));
        assert_eq!(position.day, utc_day(NOON));
    }

    #[test]
    fn release_restores_budget_and_cooldown() {
        let mut position = position();
        let before = position.clone();
        let reservation = check(&position, 100, NOON).unwrap();
        reserve(&mut position, &reservation);
        assert_eq!(release(&mut position, &reservation), 100);
        assert_eq!(position, before);
    }

    #[test]
    fn release_leaves_a_later_rescue_in_place() {
        let mut position = position();
        position.cooldown_secs = 0;
        let first = check(&position, 60, NOON).unwrap();
        reserve(&mut position, &first);
        let later = NOON + HOUR;
        let second = check(&position, 70, later).unwrap();
        reserve(&mut position, &second);

        assert_eq!(release(&mut position, &first), 60);
        assert_eq!(position.spent_today, U128(70));
        // The cooldown belongs to the second rescue now.
        assert_eq!(position.last_rescue_at, later);
    }

    #[test]
    fn release_after_midnight_does_not_refund_the_new_day() {
        let mut position = position();
        position.cooldown_secs = 0;
        let late = (utc_day(NOON) + 1) * NANOS_PER_DAY - 1;
        let first = check(&position, 100, late).unwrap();
        reserve(&mut position, &first);

        let early = late + 2;
        let second = check(&position, 30, early).unwrap();
        reserve(&mut position, &second);
        assert_eq!(position.day, utc_day(NOON) + 1);

        assert_eq!(release(&mut position, &first), 0);
        assert_eq!(position.spent_today, U128(30));
    }

    #[test]
    fn release_of_a_stale_day_with_no_new_rescue_still_refunds_its_own_bucket() {
        let mut position = position();
        let reservation = check(&position, 100, NOON).unwrap();
        reserve(&mut position, &reservation);
        // The day may roll with no new rescue: the bucket is still the old one.
        assert_eq!(release(&mut position, &reservation), 100);
        assert_eq!(position.spent_today, U128(0));
    }

    #[test]
    fn double_release_cannot_create_budget() {
        let mut position = position();
        let reservation = check(&position, 100, NOON).unwrap();
        reserve(&mut position, &reservation);
        release(&mut position, &reservation);
        assert_eq!(release(&mut position, &reservation), 0);
        assert_eq!(position.spent_today, U128(0));
    }

    #[test]
    fn tighten_accepts_stricter_and_equal_values() {
        assert!(check_tighten(&position(), 99, 249, 61).is_ok());
        assert!(check_tighten(&position(), 100, 250, 60).is_ok());
        assert!(check_tighten(&position(), 0, 0, u32::MAX).is_ok());
    }

    #[test]
    fn tighten_rejects_each_looser_value() {
        assert_eq!(
            check_tighten(&position(), 101, 250, 60),
            Err(ERR_TIGHTEN_MAX_PER_RESCUE)
        );
        assert_eq!(
            check_tighten(&position(), 100, 251, 60),
            Err(ERR_TIGHTEN_MAX_PER_DAY)
        );
        assert_eq!(
            check_tighten(&position(), 100, 250, 59),
            Err(ERR_TIGHTEN_COOLDOWN)
        );
    }

    #[test]
    fn loosen_accepts_looser_values_and_partly_unchanged_ones() {
        assert!(check_loosen(&position(), 101, 251, 59).is_ok());
        assert!(check_loosen(&position(), 101, 250, 60).is_ok());
        assert!(check_loosen(&position(), 100, 251, 60).is_ok());
        assert!(check_loosen(&position(), 100, 250, 59).is_ok());
    }

    #[test]
    fn loosen_rejects_each_stricter_value() {
        assert_eq!(
            check_loosen(&position(), 99, 251, 59),
            Err(ERR_LOOSEN_MAX_PER_RESCUE)
        );
        assert_eq!(
            check_loosen(&position(), 101, 249, 59),
            Err(ERR_LOOSEN_MAX_PER_DAY)
        );
        assert_eq!(
            check_loosen(&position(), 101, 251, 61),
            Err(ERR_LOOSEN_COOLDOWN)
        );
    }

    #[test]
    fn loosen_rejects_no_change() {
        assert_eq!(
            check_loosen(&position(), 100, 250, 60),
            Err(ERR_NOTHING_TO_LOOSEN)
        );
    }

    #[test]
    fn apply_needs_something_queued() {
        assert_eq!(
            ready_loosen(&position(), NOON).unwrap_err(),
            ERR_NO_PENDING_LOOSEN
        );
    }

    #[test]
    fn apply_boundary_is_inclusive() {
        let mut position = position();
        let ready_at = NOON + LOOSEN_DELAY_NANOS;
        position.pending_loosen = Some(PendingLoosen {
            max_per_rescue: U128(200),
            max_per_day: U128(500),
            cooldown_secs: 30,
            ready_at,
        });
        assert_eq!(
            ready_loosen(&position, ready_at - 1).unwrap_err(),
            ERR_LOOSEN_NOT_READY
        );
        assert!(ready_loosen(&position, ready_at).is_ok());
    }

    #[test]
    fn the_loosen_delay_is_a_full_day() {
        assert_eq!(LOOSEN_DELAY_NANOS, 24 * HOUR);
    }

    #[test]
    fn allowance_is_thirty_days_of_budget() {
        assert_eq!(max_allowance(&position()), 7_500);
    }

    const WETH: &str = "0x4200000000000000000000000000000000000006";

    fn collateral(asset: &str, pool_fee: u32) -> CollateralConfig {
        CollateralConfig {
            asset: asset.into(),
            pool_fee,
        }
    }

    #[test]
    fn every_uniswap_fee_tier_is_accepted() {
        for fee in POOL_FEES {
            assert_eq!(
                validate_collateral(&chain(), collateral(WETH, fee)),
                Ok(collateral(WETH, fee))
            );
        }
    }

    #[test]
    fn a_fee_beside_a_tier_is_rejected() {
        for fee in [
            0,
            1,
            99,
            101,
            499,
            501,
            2_999,
            3_001,
            9_999,
            10_001,
            1_000_000,
            u32::MAX,
        ] {
            assert_eq!(
                validate_collateral(&chain(), collateral(WETH, fee)),
                Err(ERR_POOL_FEE),
                "fee {fee}"
            );
        }
    }

    #[test]
    fn the_collateral_is_stored_lowercase() {
        let mixed = collateral("0xAbCdEf0000000000000000000000000000000001", 500);
        assert_eq!(
            validate_collateral(&chain(), mixed).unwrap().asset,
            "0xabcdef0000000000000000000000000000000001"
        );
    }

    #[test]
    fn the_collateral_address_is_as_strict_as_any_other() {
        let zero = format!("0x{}", "0".repeat(40));
        assert_eq!(
            validate_collateral(&chain(), collateral(&zero, 500)),
            Err(crate::address::ERR_ZERO_ADDRESS)
        );
        for bad in ["", "0x", "4200000000000000000000000000000000000006", "0x42"] {
            assert_eq!(
                validate_collateral(&chain(), collateral(bad, 500)),
                Err(crate::address::ERR_ADDRESS_FORMAT),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn usdc_cannot_be_the_collateral_in_any_case() {
        for usdc in [
            "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        ] {
            assert_eq!(
                validate_collateral(&chain(), collateral(usdc, 500)),
                Err(ERR_COLLATERAL_IS_USDC)
            );
        }
    }

    #[test]
    fn a_position_without_collateral_cannot_unwind() {
        assert_eq!(collateral_of(&position()), Err(ERR_NO_COLLATERAL));
        let mut with = position();
        with.collateral = Some(collateral(WETH, 3_000));
        assert_eq!(collateral_of(&with), Ok(&collateral(WETH, 3_000)));
    }

    #[test]
    fn max_sold_must_be_above_zero_and_has_no_upper_bound() {
        assert_eq!(check_max_sold(0), Err(ERR_ZERO_MAX_SOLD));
        for max_sold in [1, 52_000_000_000_000_000, u128::MAX] {
            assert_eq!(check_max_sold(max_sold), Ok(()), "{max_sold}");
        }
    }

    #[test]
    fn allowance_saturates_rather_than_wrapping() {
        let mut position = position();
        position.max_per_day = U128(u128::MAX);
        assert_eq!(max_allowance(&position), u128::MAX);
    }
}
