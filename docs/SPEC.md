# Levee specification

Levee repays a borrower's debt from a reserve when their health factor crosses a trigger they set. The position stays in the borrower's wallet. The keeper cannot send funds anywhere else.

Status: v0.1, working draft. Chain facts below were read from source or live RPC on 2026-11-07. Anything marked UNVERIFIED must be checked before it is relied on.

## 1. Scope

| Phase | Scope |
|---|---|
| Core | Aave v3 on Base and Arbitrum, USDC debt, NEAR contract, Chain Signatures rescuer address, deterministic keeper, public risk tool, evidence |
| Collateral | Repay funded by selling a slice of the borrower's own collateral in one transaction, with no reserve. Section 9. The primary mode from v0.2 |
| Reserve | Off-venue reserve in a NEAR Intents Agent API wallet with pinned destinations. Needs partner access |
| Hyperliquid | Cross-margin top-ups up to a user-set loss limit. Separate gate, not part of the core |

Out of scope: TEEs, an LLM in the money path, pooling user funds, a token, trading rights on any user account.

## 2. Trust model

| Actor | Can | Cannot |
|---|---|---|
| Owner (NEAR account) | Register, set caps, pause, withdraw float to the registered borrower | Be bypassed by the keeper |
| Keeper (NEAR function-call key limited to the keeper methods its positions use: `rescue`, `rescue_from_collateral`, or both. Never an empty list, which NEAR reads as every method) | Ask the contract to sign a repay within caps. Fire early | Change the destination, the asset, or the borrower. Exceed caps. Withdraw |
| Levee contract | Sign `approve`, `repay`, `transfer` to fixed targets | Sign arbitrary payloads. It has no admin and no full-access key on mainnet |
| MPC network (`v1.signer`) | Sign for the derived address. Trusted for custody of the rescuer key | |
| Aave Pool | Pull USDC the rescuer approved | |

The worst a stolen keeper key can do is repay the borrower's debt early, burn rescuer gas up to the fee ceiling, or burn the daily budget.

In collateral mode (section 9) the helper checks health factor on chain. A stolen keeper key can act only while the borrower's health factor is below the trigger the borrower set in the helper, only on the collateral and Uniswap pool the borrower named there, and it cannot deleverage much past their target. Each sale is at most `max_slippage_bps` worse than Aave's oracle, up to the daily cap, and at most `max_sold`, the keeper's cap from a fresh quote plus a small tolerance. The NEAR contract publishes the signed transaction before it lands, so a searcher can sandwich it, but only within that tolerance. A stolen key can raise `max_sold` only up to the borrower's bound. In effect, a stolen key can do what the keeper was meant to do, with worse timing and worse prices within the borrower's bound. The borrower can stop it on the lending chain at once, without NEAR, by calling `revoke()` or setting the aToken allowance to zero.

Caps bound signing, not landing. A signature already issued stays valid until its nonce is used, and pausing stops only new signatures. Such a signature can still only repay the registered borrower's debt, and it was already charged to the budget. An owner can burn it by landing any transaction at that nonce, for example `withdraw_float`.

The contract cannot read the lending chain, so it does not know the health factor. The trigger is kept by the keeper, off chain. Caps bound what any trigger can do.

## 3. Chain facts

| Chain | Chain id | Aave v3 Pool | USDC |
|---|---|---|---|
| Base | 8453 | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Arbitrum One | 42161 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Base Sepolia | 84532 | `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27` | `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` |
| Arbitrum Sepolia | 421614 | `0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff` | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |

Addresses come from `bgd-labs/aave-address-book`.

MPC: `v1.signer` 3.17.0 on mainnet, `v1.signer-prod.testnet` 3.18.0 on testnet.

- Call `sign({ request: { path, domain_id: 0, payload_v2: { Ecdsa: "<32 bytes hex>" } } })` with a deposit of 1 yoctoNEAR. At least 15 Tgas must be attached: `sign_call_gas_attachment_requirement_tera_gas` is 15 in the config of both live contracts, read on 2026-11-07.
- A secp256k1 response is `{ scheme: "Secp256k1", big_r: { affine_point }, s: { scalar }, recovery_id }`, with bare lowercase hex. `r` is bytes 1..33 of the compressed `big_r`. `s` is low-s normalised. The payload is signed as given, with no further hashing.
- View `derived_public_key({ path, predecessor, domain_id: 0 })` returns the derived key. Check a recovered key against it.

Selectors:

| Call | Selector |
|---|---|
| `approve(address,uint256)` | `0x095ea7b3` |
| `transfer(address,uint256)` | `0xa9059cbb` |
| `repay(address,uint256,uint256,address)` | `0x573ade81` |
| `unwind(address,address,uint256,uint24,uint256)` (LeveeUnwind) | `0x65afae08` |

Aave `repay` takes an explicit amount when `onBehalfOf` is not the caller. Variable rate mode is `2`.

Measured on forks at the blocks pinned in `evm/`, on `POOL_REVISION` 11:

- `type(uint256).max` from anyone but `onBehalfOf` reverts with `NoExplicitAmountToRepayOnBehalf()`.
- An amount above the debt is clamped. The Pool takes only the debt from the caller's balance and allowance.
- A repay when there is no debt reverts with `NoDebtOfSelectedType()` and charges nothing.
- `repay` uses about 160,000 gas. Set `gas_limit_repay` to at least 300,000, because Aave's nested calls fail on a tight limit. On Arbitrum gas also pays for L1 data, which a fork does not show, so confirm that limit on testnet.

`POOL_REVISION` is 11 on Base and Arbitrum, 10 on Base Sepolia and 3 on Arbitrum Sepolia. Revision 3 has no `getReserveVariableDebtToken`, so read the debt token from `getReserveData`, which works on all four.

## 4. Contract

Crate: `contracts/levee`, Rust, `near-sdk` 5.x.

### Types

```rust
pub struct ChainConfig {
    pub chain_id: u64,
    pub pool: String,                     // 0x-prefixed, 20 bytes
    pub usdc: String,
    pub max_fee_per_gas_ceiling: U128,    // wei
    pub max_priority_fee_ceiling: U128,   // wei
    pub gas_limit_approve: u64,
    pub gas_limit_repay: u64,
    pub gas_limit_transfer: u64,
}

pub struct Position {
    pub owner: AccountId,
    pub keeper: AccountId,
    pub chain_id: u64,
    pub borrower: String,                 // EVM address whose debt is repaid
    pub max_per_rescue: U128,             // USDC base units
    pub max_per_day: U128,
    pub cooldown_secs: u32,
    pub paused: bool,
    pub spent_today: U128,
    pub day: u64,                         // whole days since the Unix epoch, UTC
    pub last_rescue_at: u64,              // nanoseconds
    pub pending_loosen: Option<PendingLoosen>,
}

pub struct PendingLoosen {
    pub max_per_rescue: U128,
    pub max_per_day: U128,
    pub cooldown_secs: u32,
    pub ready_at: u64,                    // nanoseconds
}
```

EVM addresses are `0x` followed by exactly 40 hex characters, and are stored lowercase. The zero address is refused: a borrower cannot be changed, and value sent to zero is burnt.

### Methods

| Method | Caller | Effect |
|---|---|---|
| `new(mpc_contract, chains)` | the contract account, once | Stores immutable config. Rejects duplicate chain ids, an empty chain list, malformed addresses, a zero max fee ceiling and a gas limit below 21000. Private, so nobody can get in between deployment and this call and point the contract at their own signer |
| `register(chain_id, borrower, keeper, max_per_rescue, max_per_day, cooldown_secs) -> u64` | anyone, payable | Creates a position owned by the caller. Ids start at 1. Both caps must be above zero. The deposit pays for the most storage the position can ever use, a 64-character keeper and a queued loosening, because `set_keeper` and `queue_loosen` take no deposit. The surplus is refunded |
| `set_keeper(id, keeper)` | owner | Replaces the keeper |
| `tighten(id, max_per_rescue, max_per_day, cooldown_secs)` | owner | Immediate. Each value may only get stricter or stay the same. Cancels any queued loosening |
| `queue_loosen(id, max_per_rescue, max_per_day, cooldown_secs)`, `apply_loosen(id)` | owner | Loosening takes effect after 24 hours. Each value may only get looser or stay the same, and at least one must change. Queueing again replaces the queue and restarts the delay |
| `pause(id)`, `resume(id)` | owner | A paused position cannot rescue |
| `prepare_allowance(id, amount, fees)` | owner | Signs `USDC.approve(Pool, amount)` from the rescuer. `amount` is at most `30 * max_per_day`, and zero revokes. Owner only, so a stolen keeper key cannot burn rescuer gas on approvals |
| `rescue(id, amount, fees)` | keeper | Signs `Pool.repay(USDC, amount, 2, borrower)`. See below |
| `withdraw_float(id, amount, fees)` | owner | Signs `USDC.transfer(borrower, amount)`. The destination is fixed. Works while paused, so an owner can always leave |
| `sweep_gas(id, amount_wei, fees)` | owner | Signs a value transfer to `borrower`, with `gas_limit_transfer`. A flat 21000 would not do: on Arbitrum the gas limit has to cover L1 data cost. Works while paused. An amount of zero can replace a stuck nonce |
| `get_position(id)`, `rescuer_path(id)`, `preview_rescue(id, amount, fees)`, `get_chain(chain_id)`, `get_mpc_contract()` | view | `get_position` reports the current UTC day: `spent_today` reads 0 if the stored bucket is from an earlier day. `preview_rescue` returns the unsigned tx hex and hash, and fails as `rescue` would under rules 2 to 6. A view has no caller, so it cannot check rule 1. `get_chain` and `get_mpc_contract` let anyone audit the immutable config |

`fees` is `{ nonce: u64, max_fee_per_gas: U128, max_priority_fee_per_gas: U128 }`. Rule 6 below applies to every method that signs, not only `rescue`, or a stolen keeper key could burn rescuer gas above the ceiling through `prepare_allowance`.

### `rescue` rules

Reject unless all of these hold:

1. The caller is the position's keeper.
2. The position is not paused.
3. `0 < amount <= max_per_rescue`.
4. `spent_today + amount <= max_per_day`, using a UTC day bucket from `env::block_timestamp`.
5. `now - last_rescue_at >= cooldown_secs`.
6. Both fee values are at or below the chain's ceilings, and the priority fee is at or below the max fee. A transaction that breaks the last part cannot be included, so signing it would only burn budget.

`rescue` takes no attached deposit. A function-call access key cannot attach one, so the contract pays the 1 yoctoNEAR for `sign` from its own balance.

The contract then builds an EIP-1559 transaction itself: chain id, nonce, fees, gas limit, `to = Pool`, value 0, the `repay` calldata and an empty access list. It hashes `keccak256(0x02 || rlp(fields))` and calls MPC with path `rescuer_path(id)`. The contract attaches the 1 yoctoNEAR from its own balance, because a function-call key cannot attach a deposit.

The keeper never supplies calldata, a target or a payload. It supplies only the position id, the amount and `fees`. The EVM nonce is not tracked on chain because the contract cannot see Base. A wrong nonce wastes budget but cannot move value anywhere else.

The budget and the cooldown slot are reserved before the MPC call and released if the MPC call fails, so a keeper can retry straight after an MPC failure. A release only gives back what the reservation still holds: a charge to an earlier UTC day is not taken off the current day, and a cooldown taken by a later rescue stays.

A timed-out MPC request does not prove that no signature exists, since a node's late `respond` is public. The release assumes none will be used. The exposure is bounded: such a signature can only repay the borrower's debt from the rescuer.

The callback returns `{ kind, id, unsigned_tx, tx_hash, big_r, s, recovery_id }`, and logs the same as an event, so anyone can assemble and broadcast the signed transaction. `kind` is `rescue`, `allowance`, `withdraw_float` or `sweep_gas`. All hex is `0x`-prefixed and lowercase. `tx_hash` is the hash that was signed, not the hash of the broadcast transaction, which also covers the signature. `big_r` is the 33-byte compressed point, and `recovery_id` is the EIP-1559 `y_parity`.

If no signature comes back, the callback returns `null` and logs `rescue_failed`, or `sign_failed` for the other kinds, with `{ kind, id, tx_hash, reason, released }`. It must not panic, because that would roll back the release. `reason` is `mpc_failed` when the call failed. It is `malformed_response` when the call succeeded but the response cannot be read: a signature may exist, so the reservation stands.

Caps bound what gets signed, not when it lands. A signature stays valid until its nonce is used, so signatures held from different days can land together, and a pause does not stop one already issued. They can still only repay the borrower's debt, and an owner can void one by using its nonce first, with `sweep_gas` at amount zero.

### Loosening

A tighten cancels a queued loosening. Otherwise a loosening queued before the tighten could undo it in less than 24 hours. For the same reason, queueing again restarts the delay. A tighten with unchanged values is how an owner cancels a queued loosening.

### Derivation

`rescuer_path(id) = "levee/v1/{id}"`, with the Levee contract as predecessor and domain 0. Each position has its own rescuer address.

### Gas

A signing method takes at least 35 Tgas. Attach more, such as 100 Tgas: unused gas is refunded.

| Constant | Value | Reason |
|---|---|---|
| `SIGN_GAS` | 20 Tgas, plus all unused gas | The live signer requires 15. Real calls succeed on testnet with 20 attached, and the margin covers a small rise |
| `ON_SIGNED_GAS` | 10 Tgas, fixed | `on_signed` burns 1.7. The margin costs nothing, because unused gas is refunded, and this contract cannot be upgraded if protocol gas costs rise |
| `MIN_SIGNING_GAS` | 35 Tgas | Those two, plus 5 for the method itself, which burns 2.6 |

Unused gas goes to `sign` because the signer's requirement is its own config and a vote can raise it. With no upgrade path, the only answer to a rise is to attach more, so that has to work. A sandbox test proves it does.

Measured on 2026-11-07:

| Receipt | Burnt | Measured on |
|---|---|---|
| Transaction conversion | 0.31 Tgas | near-sandbox 2.14.0 |
| `rescue` | 2.59 Tgas | near-sandbox 2.14.0 |
| `sign` | 4.27 Tgas | `v1.signer-prod.testnet`, secp256k1 |
| `return_signature_and_clean_state_on_success` | 3.45 Tgas of a fixed 7 | `v1.signer-prod.testnet`, secp256k1 |
| `on_signed` | 1.72 Tgas, or 1.65 on failure | near-sandbox 2.14.0 |
| Three refunds | 0.67 Tgas | near-sandbox 2.14.0 |
| Whole rescue | 13.0 Tgas | Sum of the above |

The sandbox figures transfer to mainnet: near-sandbox 2.14.0 is the nearcore commit mainnet runs, and its runtime config showed no differences from mainnet's at protocol 88. The test `gas_of_a_rescue` fails if the budget stops fitting.

### Events

NEP-297, standard `levee`, version `1.0.0`: `position_registered`, `rescue_requested`, `rescue_signed`, `rescue_failed`, `allowance_signed`, `float_withdrawn`, `gas_swept`, `sign_failed`, `caps_tightened`, `caps_loosen_queued`, `caps_loosened`, `keeper_changed`, `paused`, `resumed`.

`gas_swept` is `sweep_gas`'s equivalent of `float_withdrawn`. `sign_failed` is `rescue_failed` for the other kinds of signature, so that a count of `rescue_failed` stays a count of failed rescues.

### Mainnet lock

After deployment and `new`, all full-access keys are deleted. There is no upgrade path and no admin method. Fund the contract above its storage cost first: every signature costs it 1 yoctoNEAR, and anyone can top it up later.

## 5. Keeper

Package: `keeper`, TypeScript, Node 22. One keeper serves one or more positions from a config file.

Loop, every 5 seconds per position:

1. Read `getUserAccountData(borrower)` from at least two RPC endpoints. Act only if they agree within 0.5% and are less than 30 seconds old.
2. If `healthFactor < trigger`, compute `amount` to reach `target`, capped by the position, the rescuer USDC balance, the rescuer's allowance to the Pool and the USDC debt.
3. Read rescuer nonce and fees from the chain.
4. Call `rescue` with a function-call key. Wait for the callback result.
5. Assemble the signed EIP-1559 transaction, verify the recovered address equals the derived rescuer, and broadcast to both RPCs.
6. Wait for the receipt, read health factor again, and write `evidence/runs/<id>.json`.

Repay needed to reach target `T`, with collateral `C` (USD), liquidation threshold `L` and debt `D`:

```
R = D - (C * L) / T
```

`C`, `D` and `R` are in Aave's base currency, 8 decimals of USD. Convert `R` to USDC base units at Aave's oracle price for USDC, rounding up, then add 2 base units: Aave burns scaled debt rounding down and reads the balance rounding up, so the bare formula lands just under `T`.

The trigger, target and RPC list live off chain. No LLM is involved.

## 6. Evidence

`evidence/runs/<run-id>.json`:

```json
{
  "run_id": "2026-11-09T10-12-03Z-base-1",
  "network": "mainnet",
  "position_id": 1,
  "chain_id": 8453,
  "borrower": "0x...",
  "rescuer": "0x...",
  "amount": "2500000",
  "outcome": "success | failed | aborted",
  "failure_reason": null,
  "health_factor_before": "1.19",
  "health_factor_after": "1.51",
  "timestamps_ms": { "detected": 0, "near_included": 0, "signed": 0, "broadcast": 0, "included": 0 },
  "near_tx": "...",
  "evm_tx": "0x...",
  "evm_block": 0,
  "near_contract": "levee.near",
  "near_sender": "keeper.near",
  "trace": {}
}
```

- `near_sender` and `near_contract` are required. NEAR RPC cannot resolve a hash without its sender, and the rescuer's derivation depends on the contract.
- `outcome` is `aborted` when the keeper refused and nothing reached the lending chain, and `failed` when an attempt was made and did not land. One exception: an `unwind` that lands and reverts with `AboveTrigger`, because health factor recovered before inclusion, is `aborted` with `failure_reason: "above_trigger"`. It spent only gas.
- Collateral runs add `mode: "collateral"`, `collateral`, `max_sold` (the keeper's cap on the sale), `sold` and `swap` (the effective price against Aave's oracle at that block, from the `Unwound` event). A record with no `mode` is a reserve run.
- For collateral runs, `make verify` also checks the NEAR result's `kind` is `unwind`, the NEAR call's `max_sold` is the record's, `to` is the helper, the calldata decodes to the position's borrower, collateral and pool fee and the record's `max_sold`, and the `Unwound` event matches and sold at most `max_sold`.
- A step the run did not reach is `null`.
- `trace` is optional. It holds the inputs and results of each step, so that `keeper replay` can repeat the run with no keys and no network.
- `network` is `simulated` for a run on a local fork with a local key standing in for the MPC. A simulated run does not count as proof.

Failures are recorded, not deleted. `evidence/claims.json` maps every public claim to a test or a run. It holds `{ "claims": [...] }`, and each claim has an `id`, the `claim` text, and exactly one of `test` (`{ "path", "name" }`) or `run` (a run id). A `run` claim may also list `no_access_keys`, NEAR accounts that must have no access keys: `make verify` reads each one's `view_access_key_list` on the run's network, now, and fails the claim if any key is left or the list cannot be read.

`make verify` resolves each hash and checks: the NEAR receipt succeeded, the EVM `from` equals the derived rescuer, `to` equals the Pool, the selector is `0x573ade81`, the asset is USDC, `onBehalfOf` is the borrower and the amount is within caps. It also checks that the EVM transaction's signing hash equals the `tx_hash` the contract returned, which ties the NEAR receipt to that transaction.

It prints one verdict per claim:

| Verdict | Meaning |
|---|---|
| `PASS` | Every check ran and held, on a real network, for a successful run |
| `FAIL` | A check did not hold or could not be made |
| `RECORDED` | On file but not proven by this tool: a test it did not run, a simulated run, or a failed run kept for the record |

A failed run may hold a hash that did not land, such as a rejected broadcast. That agrees with the record and is `RECORDED`, not `FAIL`.

## 7. Public risk tool

No wallet and no login. Paste an address and see:

- Aave on Base and Arbitrum: health factor, debt, collateral, approximate price drop to liquidation, and the repay needed to reach a target.
- Hyperliquid: positions, cross or isolated, margin ratio, liquidation price and distance. Isolated positions are labelled as not covered.

`GET /api/risk?address=0x...` returns the same data as JSON. The approximation is labelled: for volatile collateral against stable debt, the drop to liquidation is about `1 - 1/HF`.

## 8. Wording rules

- Do not say "never", "trustless", "guaranteed" or "within seconds" unless a table backs it.
- Publish failure conditions: reserve empty, route slow, MPC down, a liquidator wins the race.
- Privacy claims need a "hidden from whom" table.

## 9. Repay from collateral

Status: v0.2, built and fork-tested on 2026-11-08, with an independent audit's findings fixed the same day. Deployed on Base Sepolia and NEAR testnet the same day, with seven live rescues and one refusal, the last two after every key on the contract accounts was deleted (subsection Testnet). Not on mainnet. Items marked UNVERIFIED must be checked before they are relied on.

### Why

The population backtest (`backtest/results/portfolio.md`) found that for one position, the same USDC repaid upfront protects as well as a reserve held for a rescue, and costs nothing to hold, while an idle reserve costs the USDC borrow rate. A rescue that needs no reserve avoids that cost: it repays part of the USDC debt by selling just enough of the borrower's collateral, in one transaction, before a liquidator can take the liquidation bonus. The position stays at the borrower's own address. The borrower grants a capped aToken allowance to an immutable helper, and nothing else.

### Flow

1. The keeper sees health factor below the trigger and computes the repay `R` (below).
2. Just before asking NEAR, it quotes the sale with Uniswap's QuoterV2 for the same pool and amount, and sets `max_sold` to that quote plus a small tolerance, 50 bps by default.
3. It calls `rescue_from_collateral(id, amount, max_sold, fees)` on the NEAR contract.
4. The contract checks the same rules as `rescue` (section 4, rules 1 to 6), and that `max_sold` is above zero, and signs, from the position's rescuer address, a call to the helper: `LeveeUnwind.unwind(borrower, collateral, amount, pool_fee, max_sold)`. `borrower`, `collateral` and `pool_fee` come from the position. The keeper supplies only the amount, `max_sold` and fees. The contract cannot price `max_sold`; the helper applies the borrower's own bound as well.
5. In one EVM transaction, the helper:
   1. Requires the collateral and pool fee to be the ones the borrower authorized, and, if the market has a price oracle sentinel, that it allows liquidations.
   2. Requires the borrower's health factor, from `getUserAccountData`, to be below the `triggerHf` the borrower set. Caps `amount` at the borrower's current USDC variable debt.
   3. Reads Aave's oracle for the collateral and USDC, and computes `max_in = amount × price(USDC) / price(collateral) × (10000 + max_slippage_bps) / 10000`, in collateral units.
   4. Starts an exact-output swap on the Uniswap v3 pool for `(collateral, USDC, pool_fee)`, receiving `amount` USDC.
   5. In the swap callback, checks that the caller is that pool and a swap is in progress, and that the collateral owed is at most `min(max_in, max_sold)`. It repays `amount` USDC with `Pool.repay(USDC, amount, 2, borrower)`, pulls exactly the owed collateral's aTokens from the borrower with `transferFrom`, and withdraws that collateral from Aave straight to the Uniswap pool to pay for the swap.
   6. Emits `Unwound(borrower, rescuer, collateral, repaid, sold)`.

Debt is repaid before collateral leaves, so the aToken transfer does not fail the health factor check even close to liquidation. No flash-loan premium is paid. Nothing stays in the helper.

### Helper contract

`evm/src/LeveeUnwind.sol`, one deployment per chain. Constructor takes the Aave `PoolAddressesProvider`, the USDC address and the Uniswap v3 factory. It has no owner, no upgrade, no admin method, no `delegatecall`, no arbitrary call and no ETH handling.

```solidity
// The borrower calls these from their own wallet.
// HF values are 1e18-scaled, as getUserAccountData returns them. 1e18 < triggerHf < targetHf <= 3e18.
// 0 < maxSlippageBps <= 300. collateral is an Aave reserve other than USDC, and the Uniswap v3
// pool for (collateral, USDC, poolFee) exists.
function authorize(address rescuer, uint16 maxSlippageBps, uint64 triggerHf, uint64 targetHf,
    address collateral, uint24 poolFee) external;
function revoke() external;
// Only the borrower's authorized rescuer can call this.
function unwind(address borrower, address collateral, uint256 amount, uint24 poolFee, uint256 maxSold)
    external returns (uint256 repaid, uint256 sold);
```

`unwind` reverts unless all of these hold:

- `msg.sender` is the rescuer `borrower` authorized.
- `amount` and `maxSold` are above zero.
- `collateral` and `poolFee` are the ones the borrower authorized (`TermsMismatch`).
- The market's price oracle sentinel, read from the `PoolAddressesProvider` on every call, is unset or allows liquidations (`PriceOracleSentinelRefused`), as Aave requires of a liquidation. Unlike Aave, no exception is made below a health factor of 0.95.
- Health factor is below `triggerHf` before anything moves.
- The collateral is an active, unpaused reserve. Frozen collateral is sold: Aave lets it be withdrawn, and freezes come in market stress.
- The collateral owed is within `max_in` (`SlippageExceeded`) and within `maxSold` (`MaxSoldExceeded`).
- After the swap, health factor has risen and is not far past `targetHf` (`OverSold`). The bound is below; it allows for a real price better than the worst one the keeper sized for.

A public view returns a borrower's config, and the keeper reads its trigger, target, collateral and pool fee from it. A borrower's limits are their aToken allowance to the helper, the collateral and pool they named, `maxSlippageBps`, `triggerHf`, `targetHf` and the NEAR caps.

Built in `evm/src/LeveeUnwind.sol`, measured on forks on 2026-11-08 (details, addresses and sources in `evm/README.md`):

- The config view is `authorizationOf(address) returns (address rescuer, uint16 maxSlippageBps, uint64 triggerHf, uint64 targetHf, address collateral, uint24 poolFee)`, selector `0xcc90b6bb`. `authorize` is `0x4d4bb5b7`. The above-trigger error is `AboveTrigger(uint256 healthFactor, uint256 triggerHf)`. `Unwound` indexes all three addresses.
- `maxSlippageBps` is all-in, the pool fee included, as the `max_in` formula implies.
- After the swap the helper requires health factor to have risen (`NoImprovement`) and to be at most

  ```
  targetHf + 2% × (targetHf − HF_before)
           + 1 bp × (collateral after + sold) / debt after
           + (repaid × (1 + maxSlippageBps + pool fee) − sold, at the oracle) / debt after
  ```

  (`OverSold`). The last term is what a worst-case swap would have spent beyond this one, so a keeper that sizes for `maxSlippageBps` plus the pool fee, as below, always fits. The second term covers Aave truncating the averaged liquidation threshold to whole basis points. The first allows for an oracle update between the keeper's read and inclusion, and bounds an over-sale at about 2% of the keeper's amount whatever the band between trigger and target, the target or the liquidation threshold. The earlier margin, 1% of `targetHf`, let a sale run to 1.56 times the keeper's amount for a 1.20/1.21 band and 1.21 times in eMode at a 95% threshold; now 1.030 and 1.022 times, and 1.008 times for 1.05 to 1.2/1.5. `evm/README.md` has the measurements.
- `amount` above the debt is capped at the debt, which is a full repay, and a full repay leaves no debt and fails `OverSold`.
- `withdraw(type(uint256).max)` sends the helper's whole aToken balance to the pool, so no dust stays. aTokens donated to the helper therefore go to the pool with the next unwind; nobody can take them back.
- Paused or inactive collateral is refused by the helper; frozen collateral is sold. Isolation mode is not checked: Aave 3.7 (Pool revision 11) removed it, and on revision 10 the repay frees the ceiling.
- None of the three markets had a price oracle sentinel set at the pinned blocks. The check is tested with a mock sentinel set by the provider's owner.
- Gas with cold storage: 529k to 595k. Set `gas_limit_unwind` to 1,000,000 and confirm Arbitrum's L1 data cost on testnet.
- On Base use the 0.05% pool (`pool_fee` 500). It was cheaper than the deeper 0.30% pool at the sizes tested.
- With `max_sold` at a quote plus 50 bps, the auditor's sandwich took the borrower's cost on Arbitrum's 0.05% pool from 7.0 to 57.0 bps for 12,423 USDC, against 100.0 bps without the cap, and from 20.6 to 70.7 bps for 248,470 USDC, against 99.9 bps. When the honest sale already costs within 50 bps of the bound, the bound binds first.

### Contract changes

- `ChainConfig` gains `unwind: String` (the helper address) and `gas_limit_unwind: u64`.
- `Position` gains `collateral: Option<CollateralConfig>`, with `CollateralConfig { asset: String, pool_fee: u32 }`, set at `register` and immutable afterwards. `pool_fee` is one of 100, 500, 3000 or 10000.
- New method `rescue_from_collateral(id, amount, max_sold, fees)`, caller keeper, same rules and budget as `rescue`. It fails if the position has no collateral config, and if `max_sold` is zero. `amount` is USDC base units, charged to the same `max_per_rescue` and `max_per_day`. `max_sold` is collateral base units, not charged to the budget, and encoded as `unwind`'s fifth argument. The callback `kind` is `unwind`.
- `preview_rescue_from_collateral(id, amount, max_sold, fees)`, a view, as `preview_rescue`.
- `register` refuses the chain's USDC as collateral. `rescue_requested` gains `kind`, and `position_registered` gains `collateral` (events stay at 1.0.0).
- `rescue_from_collateral` burns 2.63 to 2.64 Tgas, inside the same 35 Tgas minimum.
- `unwind` is required in every `ChainConfig` in v0.2, so a chain is listed only where a helper is deployed.
- The contract is immutable, so v0.2 is a new deployment with a new account. v0.1 stays live for its records.

### Keeper

Repay to reach target `T` when selling collateral with liquidation threshold `L_c` at a total cost `s` (swap fee plus slippage), with capacity `C × L` and debt `D`, all in Aave base currency:

```
R = (T × D − C × L) / (T − L_c × (1 + s))
```

Take `s` from the pool fee plus `max_slippage_bps`. That is conservative by the pool fee, because `max_slippage_bps` already includes it, so the keeper lands slightly above target, about 1.61 for a 1.60 target at a 0.15% real cost. The helper's `OverSold` bound allows exactly this. Read the trigger, target, `max_slippage_bps`, collateral and pool fee from the helper's `authorizationOf`, and refuse to start if the keeper's own config, or the position's collateral config on NEAR, disagrees. Cap `R` by the position caps and the USDC debt. Also check that the collateral it implies, `R × (1 + s) / price(collateral)`, plus 2 wei of aToken rounding, fits within the borrower's aToken balance and allowance to the helper. The keeper reads each reserve's own liquidation threshold, so borrowers in eMode are not sized correctly yet. The rescuer needs ETH for gas only.

`max_sold` is the highest of at least two QuoterV2 `quoteExactOutputSingle` answers that agree within 0.5%, taken from the keeper's endpoints just before the NEAR call, plus `quote_tolerance_bps` (default 50). A quote above the helper's `max_in` is refused before NEAR is asked. QuoterV2: Base `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`, Arbitrum One `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`, Base Sepolia `0xC5290058841028F1614F3A6F0F5816cAd0df5E27`, from Uniswap's deployments feed, each with `factory()` returning the chain's Uniswap v3 factory.

If another collateral the borrower has enabled is at LTV 0, which from Aave v3.6 every frozen reserve is, Aave reverts any aToken transfer of a collateral with a non-zero LTV, so every unwind would fail. The keeper reads the borrower's collateral bits, eMode and the reserves' LTVs, applies Aave's rule, and records an aborted run with `failure_reason` `ltv_zero_collateral` instead of sending.

### Evidence

Run records gain `mode: "reserve" | "collateral"`, and, for collateral, `collateral`, `max_sold`, `sold` and the swap's effective price against the oracle at that block. The trace holds each endpoint's quote. `make verify` checks `to` is the helper, the selector is `unwind`'s, `borrower`, `collateral` and `pool_fee` match the position, `max_sold` matches the record and the NEAR call, and the `Unwound` event agrees with the amounts and sold at most `max_sold`. `replay` chooses `max_sold` again from the recorded quotes.

### Testnet

Base Sepolia's Aave market uses its own test tokens, and they have no real DEX liquidity. Live runs therefore use a Uniswap v3 pool for Aave's test WETH and USDC that we create and seed at Aave's oracle price. The record says so, and it does not count as a measure of slippage. Slippage is measured in the backtest from historical Uniswap quotes.

Deployed on 2026-11-08. The deployment and setup transactions are in `evm/README.md` and `contracts/README.md`, and each run's NEAR and Base Sepolia transactions are in its record.

| Item | Value |
|---|---|
| `LeveeUnwind`, Base Sepolia | `0x308a7b2872F6006522280026a750fCD1c5Bd63D2`, source verified on Sourcify, exact match |
| Levee v0.2 contract | `levee-core-v2-1503.testnet`, MPC `v1.signer-prod.testnet`, `gas_limit_unwind` 1,000,000 |
| Position | Id 1. Borrower `0x1BA01ceF25983F71e508f139Ecb10030b0403331`, collateral WETH `0x4200000000000000000000000000000000000006`, `pool_fee` 3000, 100 USDC per rescue, 500 a day |
| Rescuer | `0x95ad19E5382ebEfF2C190ed1711515263efDc462`, path `levee/v1/1` |
| Keeper | `levee-keeper-1503.testnet`, key `ed25519:CDpEuXw2jkzsywk592Qo4HFRjA8oi27GcYVh2QLDJGXq`, limited to `rescue_from_collateral` on `levee-core-v2-1503.testnet` |
| Borrower's `authorize` | Trigger 1.5, target 1.8, `max_slippage_bps` 100, WETH, 3000. aToken allowance to the helper 0.04 WETH |
| Uniswap v3 pool | WETH/USDC 0.30%, `0x92266210FacF124f190fbad79AA230dfB85926Ce`. Positions 84797 to 84803 are ours, seeded at the oracle price by `SeedTestnetPool` |

Both testnet contract accounts are locked as "Mainnet lock" describes: the only full-access key on each was deleted, and neither has any access key left.

| Account | Deleted key | NEAR transaction | Block |
|---|---|---|---|
| `levee-core-1503.testnet` (v0.1) | `ed25519:AgX6NqakXdaJD4PzFABsTLxnKmEEisozd617LNVi8Ead` | [`3u8yYEBB9eVJbRGjE27xiHru1aAA4W7Mh4C2rrsZ86fu`](https://testnet.nearblocks.io/txns/3u8yYEBB9eVJbRGjE27xiHru1aAA4W7Mh4C2rrsZ86fu) | 276,764,277 |
| `levee-core-v2-1503.testnet` (v0.2) | `ed25519:GRz6zN114TpPrRB5Go6zANhjC2csyW7kuLwUsWJV2ZdE` | [`C5aHVAahMMa3BjqddSDSf7AK8VCkuFiuqizGj7vbzJJA`](https://testnet.nearblocks.io/txns/C5aHVAahMMa3BjqddSDSf7AK8VCkuFiuqizGj7vbzJJA) | 276,764,289 |

The last two runs below came after both, the first with its NEAR call at block 276,764,677. The claim `contracts-keyless-rescue-after` ties it to the key lists, which `make verify` reads.

Runs, all on position 1 with the borrower's health factor pushed to 1.48 by a borrow:

| Run | How | Outcome | Repaid, USDC | Health factor | Price against the oracle | Detection to Base inclusion |
|---|---|---|---|---|---|---|
| `2026-11-08T10-13-28Z-base-sepolia-1` | `rescue-once` | success | 21.87 | 1.48 to 1.8031 | 59 bps below | 7.9 s |
| `2026-11-08T10-14-42Z-base-sepolia-1` | `rescue-once` | success | 17.56 | 1.48 to 1.8024 | 74 bps below | 7.6 s |
| `2026-11-08T10-15-55Z-base-sepolia-1` | `run` loop | success | 14.10 | 1.48 to 1.8036 | 48 bps below | 9.2 s |
| `2026-11-08T10-16-58Z-base-sepolia-1` | `run` loop | success | 11.33 | 1.48 to 1.8037 | 44 bps below | 8.2 s |
| `2026-11-08T10-19-24Z-base-sepolia-1` | `rescue-once` | aborted, `quote_over_slippage_bound` | none | 1.48 | quote 135 bps below, bound 100 | nothing sent |
| `2026-11-08T10-19-54Z-base-sepolia-1` | `rescue-once` | success | 9.10 | 1.48 to 1.8039 | 41 bps below | 8.7 s |
| `2026-11-08T10-39-36Z-base-sepolia-1` | `rescue-once`, after the keys were deleted | success | 7.31 | 1.48 to 1.8035 | 50 bps below | 6.7 s |
| `2026-11-08T12-00-18Z-base-sepolia-1` | `rescue-once` from the demo script, after the keys were deleted | success | 5.88 | 1.48 to 1.8037 | 45 bps below | 7.5 s |

- The price includes the 0.30% pool fee. It is the price of a pool we seeded, not a market's.
- Each unwind landed just above the 1.8 target, as section "Keeper" predicts: the keeper sized for 130 bps and paid 41 to 74.
- `unwind` used 528,445 to 545,639 gas, against the 1,000,000 limit. NEAR inclusion to MPC signature took 4.6 to 6.7 s.
- The pool does not stay at the oracle price. Each sale moves it down, and others swap small amounts of test ETH for USDC through it, about one a minute when measured. Within minutes of a recentring it read 40 to 90 bps under the oracle, and 328 bps under after 40 minutes. Each rescue was preceded by a rerun of the seed script with 0.001 WETH, which moves the pool back. The aborted run was taken without one, on a pool 93 bps under the oracle: the keeper refused before asking NEAR, and the next run, after a recentring, succeeded.

### Failure conditions

| Condition | Effect |
|---|---|
| Pool price worse than oracle by more than `max_slippage_bps` | `unwind` reverts. Nothing moves. The keeper can retry with a smaller amount. If the quote already shows it, the keeper refuses before NEAR is asked, `quote_over_slippage_bound` |
| Pool moved against the sale by more than the tolerance between the quote and inclusion, as a sandwich would | `unwind` reverts with `MaxSoldExceeded`. Nothing moves but gas. The next pass quotes again |
| Fewer than two endpoints can quote, or their quotes differ by more than 0.5% | The keeper refuses before NEAR is asked, `quote_unavailable` or `quote_disagreement` |
| Pool too thin for the amount | `unwind` reverts. Nothing moves |
| Allowance or aToken balance too small | `unwind` reverts |
| Collateral or pool fee other than the ones the borrower authorized | `unwind` reverts with `TermsMismatch`. The keeper refuses to start, or stops, as `helper_config_mismatch` |
| Collateral paused or inactive on Aave | `unwind` reverts |
| Collateral frozen on Aave | Sold as usual |
| Another enabled collateral at LTV 0, as every frozen reserve is from Aave v3.6 | Aave reverts the aToken transfer with `LtvValidationFailed`. The keeper detects it and records `ltv_zero_collateral` instead of sending. The borrower must withdraw or disable that asset |
| The market's price oracle sentinel does not allow liquidations: an L2 sequencer down, or inside its grace period | `unwind` reverts with `PriceOracleSentinelRefused`. None of the three markets has one set today |
| The collateral reserve has no withdrawable cash | `unwind` reverts |
| Health factor below 1 and the repay does not lift it to 1 or above | The aToken transfer fails Aave's check, and `unwind` reverts |
| The oracle returns a zero price | `unwind` reverts |
| The borrower revoked | `unwind` reverts |
| Health factor recovered above the trigger before inclusion | `unwind` reverts with `AboveTrigger`. The keeper records an aborted run |

### Positioning

Read `research/incumbents.md` (outside the repo) before writing any comparison. DeFi Saver has protected Aave v3 positions held in an EOA on Base and Arbitrum since October 2025, so do not claim Levee is the only tool that works without migrating a position. What Levee can claim, once the helper is built and tested:

- No smart wallet, no module and no credit delegation. The borrower gives a capped aToken allowance to a helper that has no owner and cannot be upgraded.
- The sale price is bounded against Aave's oracle on chain, by the helper.
- The trigger is checked on chain, by the helper.
- One NEAR policy covers positions on several chains.

Do not claim lower cost or better execution: Levee swaps in one Uniswap v3 pool, and no mainnet data exists.
