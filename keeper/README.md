# Levee keeper

Watches Aave health factors, asks the Levee contract on NEAR to sign a repay when one crosses its trigger, broadcasts the signed transaction and writes a record of every attempt. It holds no EVM key. Its NEAR key is a function-call key limited to `rescue`. See `docs/SPEC.md` sections 2, 5 and 6.

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
| `rescue-once --id <n> --amount <units>` | Fires now for that many USDC base units. The keeper may fire early, but the quorum and every cap still apply |
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
| `KEEPER_ACCOUNT`, `KEEPER_PRIVATE_KEY` | `run`, `rescue-once` | Function-call key limited to `rescue` |
| `BASE_RPC_URLS`, `ARBITRUM_RPC_URLS` | `status`, `run`, `rescue-once` | Comma separated, at least two distinct endpoints |
| `NEAR_RPC_URL` | optional | Defaults to a public endpoint for the network |
| `KEEPER_CONFIG` | optional | Defaults to `keeper/positions.json` |
| `EVIDENCE_DIR` | optional | Defaults to `evidence/` at the repo root |

`positions.json` holds what must stay off chain:

```json
{
  "positions": [{ "id": 1, "trigger": "1.25", "target": "1.6" }],
  "fee_ceilings": {
    "84532": { "max_fee_per_gas": "2000000000", "max_priority_fee_per_gas": "1000000000" }
  }
}
```

The borrower, chain and caps are read from `get_position`. `fee_ceilings` repeats the contract's `ChainConfig`, which has no view method, and must match it: the keeper clamps its bid to these values, and `rescue` rejects anything above the contract's.

Before a rescue can land:

- The rescuer needs USDC and gas on the lending chain. `derive-address` gives its address.
- The rescuer needs an allowance to the Pool. `prepare_allowance` signs it, but a key limited to `rescue` cannot call that method, so the owner has to. The keeper treats the allowance as a cap and shows it in `status`.
- The keeper key must allow enough gas. `rescue` attaches 300 Tgas, so give the key an unlimited allowance or a large one. Unused gas is refunded.

## How a pass works

1. Read the position from every RPC at one block each. At least two distinct endpoints on the right chain must be under 30 seconds old and agree within 0.5% on every number the decision uses. Any fresh endpoint can veto.
2. Decide, in `src/decision.ts`. Pure, with the formula, Aave's rounding and the caps.
3. Read the rescuer's nonce and fees, clamped to the ceilings.
4. Call `rescue` with no deposit, since a function-call key cannot attach one, and wait for the signature.
5. Assemble the transaction with viem. It is refused unless the signature recovers to the derived rescuer and every requested field matches.
6. Broadcast to every RPC, wait for the receipt, reread the health factor and write the record.

## Run records

Every attempt that wanted to act leaves `evidence/runs/<run-id>.json`. A file is created exclusively, so a later run cannot replace an earlier record.

| `outcome` | Meaning |
|---|---|
| `success` | The repay landed |
| `failed` | An attempt was made and did not land. Includes reverts, timeouts and NEAR failures |
| `aborted` | The keeper refused and nothing reached the lending chain. Includes quorum refusals, an empty rescuer and a refused signature |

In `run`, a refusal that repeats every 5 seconds is recorded once per 5 minutes per reason. A failure after the NEAR call is always recorded.

## `verify` verdicts

| Verdict | Meaning |
|---|---|
| `PASS` | Every check ran and held, on a real network, for a successful run |
| `FAIL` | A check did not hold or could not be made. An unreachable RPC is a FAIL, because a claim only passes on proof |
| `RECORDED` | On file but not proven here: a test `verify` did not run, a simulated run, or a failed run kept for the record |

Beyond spec section 6, `verify` recomputes the on-chain transaction's signing hash and requires it to equal the `tx_hash` the contract returned, so a NEAR receipt and a repay cannot be unrelated transactions paired in a record.

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

### What is simulated

The end-to-end test runs the real keeper code against the real Aave bytecode on a local fork, and makes real transactions on that fork. Two things are stand-ins, and every record it writes says `"network": "simulated"`:

- The NEAR call is mocked at the `NearRescuer` interface in `src/near.ts`.
- A local key, generated per run, stands in for the MPC signature. See `test/support/simulated-mpc.ts`.

So it says nothing about the real contract or the real MPC network. `verify` can only mark a simulated run `RECORDED`. No key is stored in the repo.

The price crash replaces the bytecode of the WETH feed that the Aave oracle reads, because anvil has no `vm.mockCall`.

## NEAR library

[`near-api-js`](https://github.com/near/near-api-js) 7.4.0, the maintained single package that replaced the `@near-js/*` split packages. It needs Node 22.22.2 or newer. `src/near.ts` signs locally to learn the transaction hash before sending, sends until `INCLUDED`, then polls for `EXECUTED_OPTIMISTIC`, because an MPC signature can outlast one RPC wait.
