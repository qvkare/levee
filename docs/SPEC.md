# Levee specification

Levee repays a borrower's debt from a reserve when their health factor crosses a trigger they set. The position stays in the borrower's wallet. The keeper cannot send funds anywhere else.

Status: v0.1, working draft. Chain facts below were read from source or live RPC on 2026-11-07. Anything marked UNVERIFIED must be checked before it is relied on.

## 1. Scope

| Phase | Scope |
|---|---|
| Core | Aave v3 on Base and Arbitrum, USDC debt, NEAR contract, Chain Signatures rescuer address, deterministic keeper, public risk tool, evidence |
| Reserve | Off-venue reserve in a NEAR Intents Agent API wallet with pinned destinations. Needs partner access |
| Hyperliquid | Cross-margin top-ups up to a user-set loss limit. Separate gate, not part of the core |

Out of scope: TEEs, an LLM in the money path, pooling user funds, a token, trading rights on any user account.

## 2. Trust model

| Actor | Can | Cannot |
|---|---|---|
| Owner (NEAR account) | Register, set caps, pause, withdraw float to the registered borrower | Be bypassed by the keeper |
| Keeper (NEAR function-call key limited to `rescue`) | Ask the contract to sign a repay within caps. Fire early | Change the destination, the asset, or the borrower. Exceed caps. Withdraw |
| Levee contract | Sign `approve`, `repay`, `transfer` to fixed targets | Sign arbitrary payloads. It has no admin and no full-access key on mainnet |
| MPC network (`v1.signer`) | Sign for the derived address. Trusted for custody of the rescuer key | |
| Aave Pool | Pull USDC the rescuer approved | |

The worst a stolen keeper key can do is repay the borrower's debt early, burn rescuer gas up to the fee ceiling, or burn the daily budget.

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

- Call `sign({ request: { path, domain_id: 0, payload_v2: { Ecdsa: "<32 bytes hex>" } } })` with a deposit of 1 yoctoNEAR. At least 10 Tgas must be attached.
- A secp256k1 response has `big_r`, `s`, `recovery_id`. `r` is bytes 1..33 of the compressed `big_r`. `s` is low-s normalised. The payload is signed as given, with no further hashing.
- View `derived_public_key({ path, predecessor, domain_id: 0 })` returns the derived key. Check a recovered key against it.

Selectors:

| Call | Selector |
|---|---|
| `approve(address,uint256)` | `0x095ea7b3` |
| `transfer(address,uint256)` | `0xa9059cbb` |
| `repay(address,uint256,uint256,address)` | `0x573ade81` |

Aave `repay` takes an explicit amount when `onBehalfOf` is not the caller. Variable rate mode is `2`.

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
    pub day: u64,
    pub last_rescue_at: u64,              // nanoseconds
}
```

### Methods

| Method | Caller | Effect |
|---|---|---|
| `new(mpc_contract, chains)` | init | Stores immutable config. Rejects duplicate chain ids |
| `register(chain_id, borrower, keeper, max_per_rescue, max_per_day, cooldown_secs) -> u64` | anyone, payable | Creates a position owned by the caller. Attached deposit covers storage |
| `set_keeper(id, keeper)` | owner | Replaces the keeper |
| `tighten(id, max_per_rescue, max_per_day, cooldown_secs)` | owner | Immediate. Each value may only get stricter |
| `queue_loosen(id, ...)`, `apply_loosen(id)` | owner | Loosening takes effect after 24 hours |
| `pause(id)`, `resume(id)` | owner | A paused position cannot rescue |
| `prepare_allowance(id, amount, fees)` | keeper or owner | Signs `USDC.approve(Pool, amount)` from the rescuer. `amount` is at most `30 * max_per_day` |
| `rescue(id, amount, fees)` | keeper | Signs `Pool.repay(USDC, amount, 2, borrower)`. See below |
| `withdraw_float(id, amount, fees)` | owner | Signs `USDC.transfer(borrower, amount)`. The destination is fixed |
| `sweep_gas(id, amount_wei, fees)` | owner | Signs a value transfer to `borrower` |
| `get_position(id)`, `rescuer_path(id)`, `preview_rescue(id, amount, fees)` | view | `preview_rescue` returns the unsigned tx hex and hash |

`fees` is `{ nonce: u64, max_fee_per_gas: U128, max_priority_fee_per_gas: U128 }`.

### `rescue` rules

Reject unless all of these hold:

1. The caller is the position's keeper.
2. The position is not paused.
3. `0 < amount <= max_per_rescue`.
4. `spent_today + amount <= max_per_day`, using a UTC day bucket from `env::block_timestamp`.
5. `now - last_rescue_at >= cooldown_secs`.
6. Both fee values are at or below the chain's ceilings.

The contract then builds an EIP-1559 transaction itself: chain id, nonce, fees, gas limit, `to = Pool`, value 0, the `repay` calldata and an empty access list. It hashes `keccak256(0x02 || rlp(fields))` and calls MPC with path `rescuer_path(id)`.

The keeper never supplies calldata, a target or a payload. It supplies only the position id, the amount and `fees`. The EVM nonce is not tracked on chain because the contract cannot see Base. A wrong nonce wastes budget but cannot move value anywhere else.

The budget is reserved before the MPC call and released if the MPC call fails.

The callback returns `{ kind, id, unsigned_tx, tx_hash, big_r, s, recovery_id }`, and logs the same as an event, so anyone can assemble and broadcast the signed transaction.

### Derivation

`rescuer_path(id) = "levee/v1/{id}"`, with the Levee contract as predecessor and domain 0. Each position has its own rescuer address.

### Events

NEP-297, standard `levee`, version `1.0.0`: `position_registered`, `rescue_requested`, `rescue_signed`, `rescue_failed`, `allowance_signed`, `float_withdrawn`, `caps_tightened`, `caps_loosen_queued`, `caps_loosened`, `keeper_changed`, `paused`, `resumed`.

### Mainnet lock

After deployment and `new`, all full-access keys are deleted. There is no upgrade path and no admin method.

## 5. Keeper

Package: `keeper`, TypeScript, Node 22. One keeper serves one or more positions from a config file.

Loop, every 5 seconds per position:

1. Read `getUserAccountData(borrower)` from at least two RPC endpoints. Act only if they agree within 0.5% and are less than 30 seconds old.
2. If `healthFactor < trigger`, compute `amount` to reach `target`, capped by the position, the rescuer USDC balance and the debt.
3. Read rescuer nonce and fees from the chain.
4. Call `rescue` with a function-call key. Wait for the callback result.
5. Assemble the signed EIP-1559 transaction, verify the recovered address equals the derived rescuer, and broadcast to both RPCs.
6. Wait for the receipt, read health factor again, and write `evidence/runs/<id>.json`.

Repay needed to reach target `T`, with collateral `C` (USD), liquidation threshold `L` and debt `D`:

```
R = D - (C * L) / T
```

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
  "evm_block": 0
}
```

Failures are recorded, not deleted. `evidence/claims.json` maps every public claim to a test or a run.

`make verify` resolves each hash and checks: the NEAR receipt succeeded, the EVM `from` equals the derived rescuer, `to` equals the Pool, the selector is `0x573ade81`, the asset is USDC, `onBehalfOf` is the borrower and the amount is within caps.

## 7. Public risk tool

No wallet and no login. Paste an address and see:

- Aave on Base and Arbitrum: health factor, debt, collateral, approximate price drop to liquidation, and the repay needed to reach a target.
- Hyperliquid: positions, cross or isolated, margin ratio, liquidation price and distance. Isolated positions are labelled as not covered.

`GET /api/risk?address=0x...` returns the same data as JSON. The approximation is labelled: for volatile collateral against stable debt, the drop to liquidation is about `1 - 1/HF`.

## 8. Wording rules

- Do not say "never", "trustless", "guaranteed" or "within seconds" unless a table backs it.
- Publish failure conditions: reserve empty, route slow, MPC down, a liquidator wins the race.
- Privacy claims need a "hidden from whom" table.
