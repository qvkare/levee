# Levee keeper

Watches Aave health factors, asks the Levee contract on NEAR to sign a repay when one crosses its trigger, broadcasts the signed transaction and writes a record of every attempt. It holds no EVM key. Its NEAR key is a function-call key limited to the keeper methods its positions use. See `docs/SPEC.md` sections 2, 5, 6 and 9.

A position runs in one of two modes:

| Mode | NEAR method | The repay is paid by |
|---|---|---|
| `collateral` | `rescue_from_collateral` | Selling a slice of the borrower's own collateral, in one `LeveeUnwind.unwind` call. The primary mode from v0.2 |
| `reserve` | `rescue` | USDC held by the rescuer, through `Pool.repay` |

Needs Node 22.22.2 or newer and pnpm 10. Run everything from the repo root.

```sh
pnpm install
```

## Commands

`status`, `verify`, `derive-address` and `replay` need no keys.

```sh
pnpm --silent --filter keeper keeper status
pnpm --silent --filter keeper keeper run
pnpm --silent --filter keeper keeper rescue-once --id 1
pnpm --silent --filter keeper keeper rescue-once --id 1 --amount 2500000
pnpm --silent --filter keeper keeper derive-address --id 1 --contract levee.testnet --network testnet
pnpm --silent --filter keeper keeper verify
pnpm --silent --filter keeper keeper replay test/fixtures/simulated-run.json
```

The fixture is a run captured from the end-to-end test, so `replay` works before any real run exists. It is labelled `simulated`. For a real run, pass its id, such as `2026-11-09T10-12-03Z-base-1`.

| Command | Does |
|---|---|
| `status` | Reads each position from every RPC and shows the quorum, caps and what the keeper would do. Sends nothing |
| `run` | One pass per position every 5 seconds until interrupted |
| `rescue-once --id <n>` | One pass for a position, deciding as the loop would |
| `rescue-once --id <n> --amount <units>` | Fires now for that many USDC base units, in the position's mode. The keeper may fire early, but the quorum and every cap still apply. In collateral mode the helper still refuses above the borrower's trigger |
| `derive-address` | Derives a rescuer locally and checks it against the live `derived_public_key` |
| `verify` | Checks `evidence/` against public RPCs. Same as `make verify`. Exits non-zero on any FAIL |
| `replay <run>` | Repeats a recorded run offline. Takes a run id or a file path. Exits non-zero on a mismatch |

## Setup for `status`, `run` and `rescue-once`

```sh
cp .env.example .env
cp keeper/positions.example.json keeper/positions.json
```

The CLI reads `.env` from the repo root.

| Variable | Needed by | Notes |
|---|---|---|
| `NEAR_NETWORK` | all | `testnet` or `mainnet`. Defaults to `testnet` |
| `LEVEE_CONTRACT` | `status`, `run`, `rescue-once` | The Levee account |
| `KEEPER_ACCOUNT`, `KEEPER_PRIVATE_KEY` | `run`, `rescue-once` | Function-call key limited to `rescue_from_collateral`, `rescue`, or both. See "Keeper keys" in `contracts/README.md` |
| `BASE_RPC_URLS`, `ARBITRUM_RPC_URLS` | `status`, `run`, `rescue-once` | Comma separated, at least two distinct endpoints |
| `NEAR_RPC_URL` | optional | Defaults to a public endpoint for the network |
| `KEEPER_CONFIG` | optional | Defaults to `keeper/positions.json` |
| `EVIDENCE_DIR` | optional | Defaults to `evidence/` at the repo root |

`positions.json` holds what must stay off chain:

```json
{
  "positions": [
    { "id": 1, "trigger": "1.25", "target": "1.6", "mode": "collateral", "max_slippage_bps": 100, "quote_tolerance_bps": 50 },
    { "id": 2, "trigger": "1.25", "target": "1.6" }
  ],
  "fee_ceilings": {
    "84532": { "max_fee_per_gas": "2000000000", "max_priority_fee_per_gas": "1000000000" }
  }
}
```

A position with no `mode` is in reserve mode, as every position was before v0.2. `max_slippage_bps` is for collateral mode only, and is required there: above 0 and at most 300, as `authorize` allows. `quote_tolerance_bps` is for collateral mode only, optional, from 0 to 300, and defaults to 50: the headroom over a fresh quote when the keeper sets `max_sold`, below.

The borrower, chain and caps are read from `get_position`. `fee_ceilings` repeats the contract's fee ceilings and must match them: the keeper clamps its bid to these values, and the contract rejects anything above its own.

Before a rescue can land, in either mode:

- The rescuer needs gas on the lending chain. `derive-address` gives its address.
- The keeper key must allow enough gas. A rescue attaches 300 Tgas, so give the key an unlimited allowance or a large one. Unused gas is refunded.

In reserve mode only:

- The rescuer needs USDC.
- The rescuer needs an allowance to the Pool. `prepare_allowance` signs it, but a keeper key cannot call that method, so the owner has to. The keeper treats the balance and the allowance as caps and shows them in `status`.

In collateral mode only:

- The position was registered with a collateral config: the asset and the Uniswap fee tier.
- The contract's `get_chain` names a `LeveeUnwind` helper for the chain.
- The borrower called `authorize(rescuer, maxSlippageBps, triggerHf, targetHf, collateral, poolFee)` on the helper for the derived rescuer, with the keeper's own `trigger`, `target` and `max_slippage_bps`, and the collateral and fee tier the position registered on NEAR, and approved the collateral's aToken to the helper.
- The chain has a known Uniswap v3 QuoterV2 in `src/chains.ts`: Base, Arbitrum One, Base Sepolia and Arbitrum Sepolia.

## Collateral mode

The helper enforces the borrower's own settings: `unwind` reverts unless the health factor is below their trigger, checks the result against their target, and sells only the collateral, in only the pool, they authorized. So the keeper acts on what the helper holds, and refuses to start, in `wirePosition`, unless every endpoint that answers reports the derived rescuer, the same trigger, target and slippage as the positions file, and the same collateral and pool fee as the position on NEAR. Each pass reads them again with the position, and a change since start stops the pass as `helper_config_mismatch`.

Each sample also reads, at the same block, the collateral's oracle price, its own liquidation threshold and decimals from `getReserveData`, the borrower's aToken balance and allowance to the helper, and what Aave's LTV-0 rule needs: the borrower's collateral bits, their eMode category and each enabled reserve's LTV. The quorum compares the figures within 0.5%, and the helper's settings and the LTV-0 reading exactly.

If another collateral the borrower has enabled sits at LTV 0, which from Aave v3.6 every frozen reserve does, Aave lets only that asset leave the account first and reverts the helper's aToken transfer with `LtvValidationFailed`. `src/ltv.ts` applies Aave's own `getUserReserveLtv`, eMode included, and below the trigger the keeper records an aborted run with `ltv_zero_collateral`, naming the asset, instead of sending an unwind that would fail. `status` shows it. Only the borrower can clear it, by withdrawing that asset or disabling it as collateral. The collateral being sold may itself be frozen: the helper sells it.

The repay to reach target `T` is spec section 9's

```
R = (T × D − C × L) / (T − L_c × (1 + s))
```

with `s` the pool fee plus `max_slippage_bps`, the most the helper can be charged. It rounds as reserve mode does: `R` up in base currency, the USDC conversion up, then two base units for Aave's rounding. It is capped by `max_per_rescue`, the day's remaining budget, the USDC debt, and the USDC that the borrower's aToken balance, and separately their allowance to the helper, can pay for at `(1 + s)` over the oracle. The rescuer's USDC balance and allowance are not caps in this mode.

### `max_sold`

The NEAR contract publishes the signed transaction before it lands, so a searcher could sandwich it up to the borrower's whole slippage bound. Just before calling `rescue_from_collateral`, after it has the fees and nonce, the keeper therefore asks every endpoint for Uniswap QuoterV2's `quoteExactOutputSingle` for the position's pool and the amount, and sets

```
max_sold = highest quote × (10000 + quote_tolerance_bps) / 10000, rounded down
```

At least two answers must agree within 0.5%, as the quorum does, so one endpoint can stop the unwind but cannot loosen the cap past what the others report. A quote above the helper's own oracle bound, `amount × price(USDC) / price(collateral) × (1 + max_slippage_bps)`, would revert on chain, so it is refused too. The refusals are `quote_unavailable`, `quote_disagreement` and `quote_over_slippage_bound`, all aborted before NEAR is asked. The helper takes the tighter of `max_sold` and its oracle bound, so the cap never loosens what the borrower allowed. The broadcast gate refuses a signed `unwind` whose `max_sold` is not the one the keeper asked for.

After a successful unwind, the record takes `sold` and the swap's price from the helper's `Unwound` event, priced against Aave's oracle at the receipt's block. A reverted unwind is replayed with `eth_call` at its block to read the reason. The helper's above-trigger error means the health factor recovered between the read and inclusion: the run is `aborted` with `above_trigger`, a no-op that cost only gas. Any other revert is `failed`, `evm_reverted`, with the error selector.

Everything that depends on the helper's source, its `unwind` and `authorizationOf` ABIs, its above-trigger error, the indexing of `Unwound` and the QuoterV2 call, sits in `src/unwind.ts`, matched to `evm/src/LeveeUnwind.sol`.

## How a pass works

1. Read the position from every RPC at one block each. At least two distinct endpoints on the right chain must be under 30 seconds old and agree within 0.5% on every number the decision uses. Any fresh endpoint can veto.
2. Decide, in `src/decision.ts`. Pure, with the formula, Aave's rounding and the caps.
3. Read the rescuer's nonce and fees, clamped to the ceilings. In collateral mode, quote `max_sold`.
4. Call `rescue` or `rescue_from_collateral` with no deposit, since a function-call key cannot attach one, and wait for the signature.
5. Assemble the transaction with viem. It is refused unless the signature recovers to the derived rescuer and every requested field matches: the Pool, USDC and borrower for a repay; the helper, borrower, collateral, fee tier and `max_sold` for an unwind.
6. Broadcast to every RPC, wait for the receipt, reread the health factor and write the record.

## Run records

Every attempt that wanted to act leaves `evidence/runs/<run-id>.json`. A file is created exclusively, so a later run cannot replace an earlier record.

| `outcome` | Meaning |
|---|---|
| `success` | The repay landed |
| `failed` | An attempt was made and did not land. Includes reverts, timeouts and NEAR failures |
| `aborted` | The keeper refused and nothing reached the lending chain. Includes quorum refusals, an empty rescuer and a refused signature. Also `above_trigger`: the helper refused on chain because the health factor had recovered, so only gas was spent |

In `run`, a refusal that repeats every 5 seconds is recorded once per 5 minutes per reason. Anything that reached the lending chain is always recorded.

Records carry `mode`. A record without it predates v0.2 and is reserve mode. Collateral records also carry `collateral`, the asset, `max_sold`, the cap the keeper sent, `sold`, from the `Unwound` event, and `swap`: what was repaid and sold, the oracle prices at the block, the effective price and how many basis points below the oracle it was. Their trace holds `quote`: each endpoint's QuoterV2 answer, the tolerance, the oracle bound and the choice.

## `verify` verdicts

| Verdict | Meaning |
|---|---|
| `PASS` | Every check ran and held, on a real network, for a successful run |
| `FAIL` | A check did not hold or could not be made. An unreachable RPC is a FAIL, because a claim only passes on proof |
| `RECORDED` | On file but not proven here: a test `verify` did not run, a simulated run, or a failed run kept for the record |

Beyond spec section 6, `verify` recomputes the on-chain transaction's signing hash and requires it to equal the `tx_hash` the contract returned, so a NEAR receipt and a repay cannot be unrelated transactions paired in a record. It also requires the contract's result to be of the run's kind, `rescue` or `unwind`.

A run claim can list `no_access_keys`, NEAR accounts that must have no keys. `verify` reads each one's `view_access_key_list` on the run's network, at the final block, and the claim fails if any key is left or a list cannot be read. `contracts-keyless-rescue-after` uses it for both testnet contract accounts.

For a collateral run, `verify` checks the NEAR method is `rescue_from_collateral` and its `max_sold` is the record's, `to` is the helper named by the contract's `get_chain`, the selector is `unwind`'s, the decoded borrower, collateral, fee tier and `max_sold` match the record and the registered position, and the amount is within caps. For a success it also requires exactly one `Unwound` event from the helper, agreeing on the borrower, the derived rescuer, the collateral and `sold`, with `repaid` above zero and at most the amount signed, and `sold` at most `max_sold`.

`replay` recomputes the same for a collateral run, from the helper's settings in the recorded samples, and adds a `Quote` step that chooses `max_sold` again from the recorded quotes and recomputes the oracle bound from the sample, a `Swap` step that prices the recorded event again and a `Revert` step that checks the above-trigger reading.

Until a real run exists, every claim is `RECORDED`, and `make verify` reports 0 PASS.

## Tests

```sh
pnpm --filter keeper test        # everything, needs network and anvil
pnpm --filter keeper test:unit   # no network
pnpm --filter keeper test:live   # read-only view calls to v1.signer and v1.signer-prod.testnet
pnpm --filter keeper test:e2e    # local anvil fork of Base
pnpm --filter keeper typecheck
```

`test:e2e` needs `anvil` on the path and reads `BASE_FORK_RPC_URL`, defaulting to `https://mainnet.base.org`. It forks the block pinned in `evm/`, moves chain time up to the wall clock and takes about two minutes.

`test/collateral-*.test.ts`, `test/unwind.test.ts` and `test/ltv.test.ts` run collateral mode against fakes of the helper's config view, its `Unwound` event, its revert and QuoterV2, with the formula's numbers worked by hand. `test/collateral.fork.test.ts` runs the two new reads against the anvil fork: the QuoterV2 quote equals what `cast` reads at the pinned block, and the LTV-0 read names a second collateral once Aave's own configurator freezes it. The helper's own behaviour is tested in `evm/`.

### What is simulated

The end-to-end test runs the real keeper code against the real Aave bytecode on a local fork, and makes real transactions on that fork. Two things are stand-ins, and every record it writes says `"network": "simulated"`:

- The NEAR call is mocked at the `NearRescuer` interface in `src/near.ts`.
- A local key, generated per run, stands in for the MPC signature. See `test/support/simulated-mpc.ts`.

So it says nothing about the real contract or the real MPC network. `verify` can only mark a simulated run `RECORDED`. No key is stored in the repo.

The price crash replaces the bytecode of the WETH feed that the Aave oracle reads, because anvil has no `vm.mockCall`.

## NEAR library

[`near-api-js`](https://github.com/near/near-api-js) 7.4.0, the maintained single package that replaced the `@near-js/*` split packages. It needs Node 22.22.2 or newer. `src/near.ts` signs locally to learn the transaction hash before sending, sends until `INCLUDED`, then polls for `EXECUTED_OPTIMISTIC`, because an MPC signature can outlast one RPC wait.
