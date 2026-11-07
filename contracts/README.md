# Levee contracts

| Crate | What it is |
|---|---|
| `levee` | The NEAR contract. Sections 2 to 4 of `docs/SPEC.md` define it |
| `mock-signer` | Stand-in for the MPC signer, used only by tests |

## Prerequisites

- Rust 1.96.1 with `wasm32-unknown-unknown`
- `cargo-near` 0.23.0: `cargo install --locked cargo-near`
- To regenerate fixtures only: Foundry's `cast` and `jq`

The sandbox tests download near-sandbox 2.14.0 the first time they run.

## Build

```sh
contracts/build.sh
```

That runs these two commands from `contracts/`, then marks the output as current:

```sh
cargo near build non-reproducible-wasm --no-abi --locked --manifest-path levee/Cargo.toml
cargo near build non-reproducible-wasm --no-abi --locked --manifest-path mock-signer/Cargo.toml
```

Output goes to `target/near/levee/levee.wasm` and `target/near/mock_signer/mock_signer.wasm`.

Do not build with plain `cargo build --target wasm32-unknown-unknown`. It compiles and it deploys, but cargo-near sets `--cfg near`, which selects near-sdk's host functions, and near-sdk documents output without it as not for on-chain use. For the same reason `cargo check` needs `--target wasm32-unknown-unknown`, and fails without it.

### Why this wasm is accepted

Rust 1.96 emits `memory.copy`, `memory.fill` and sign-extension instructions, and `wasm-opt` does not remove them: `levee.wasm` contains all three. Older NEAR VMs rejected such code. It is accepted here because protocol 88 runs Wasmtime with `reftypes_bulk_memory` on.

The contract was deployed and run on near-sandbox 2.14.0, which is the nearcore commit (`bc4e9e8`) mainnet runs. `EXPERIMENTAL_protocol_config` showed no differences between the sandbox's `runtime_config` and mainnet's at protocol 88. Read on 2026-11-07. Check this again before a mainnet deployment if either has moved.

## Test

```sh
contracts/build.sh
cargo test --manifest-path contracts/Cargo.toml --workspace
```

| Suite | Tests | What it covers |
|---|---|---|
| `levee` unit | 199 | Every rule on its boundaries, and what leaves the contract: receipts, gas, deposits, logs, return values |
| `levee/tests/vectors.rs` | 5 | Calldata, RLP and signing hash against `cast`, byte for byte |
| `levee/tests/properties.rs` | 5 | Any amount, nonce and fee decodes in alloy to the same fields, and `to`, selector, asset and `onBehalfOf` do not change. The daily budget holds under any interleaving |
| `levee/tests/sandbox.rs` | 33 | The real wasm in near-sandbox against the mock signer |
| `mock-signer` unit | 9 | That the mock enforces what the real `sign` enforces |

The sandbox tests refuse a wasm older than its source, so run `build.sh` after any change.

The mock does not sign. The test process plays the MPC node: it signs each request with a key derived the way the real network derives it, and calls `respond`. Signed paths therefore end in a transaction that recovers to the rescuer address.

The 24-hour rules run for real. `max_block_production_delay` is raised in the sandbox config, which makes each fast-forwarded block move the clock by about an hour without slowing normal blocks.

### Gas

```sh
cargo test --manifest-path contracts/Cargo.toml -p levee --test sandbox gas_of_a_rescue -- --nocapture
```

This prints each receipt and fails if the budget stops fitting. `docs/SPEC.md`, section "Gas", has the figures and the reasons for each constant.

### Fixtures

```sh
contracts/levee/fixtures/generate.sh
```

This writes `tx_vectors.json`. It builds each vector from `cast calldata`, `cast to-rlp` and `cast keccak`, builds it again with `cast mktx --raw-unsigned`, and aborts if they differ. `mpc_sign_response.json` is a real response read from the testnet signer, not generated.

## Deploying

Nothing here deploys to a live network. When that happens:

1. Deploy and call `new` from the contract account. `new` is private, so a stranger cannot initialise it first.
2. Fund the contract above its storage cost. Each signature costs it 1 yoctoNEAR, because a function-call key cannot attach a deposit.
3. Delete every full-access key. A sandbox test confirms the contract still works with none.

Give the keeper a function-call key limited to `rescue`, with an allowance that covers the gas it attaches. At the minimum gas price, 100 Tgas needs 0.01 NEAR up front, and the unused part is refunded. `prepare_allowance` needs either a second key or the owner, because a key limited to `rescue` cannot call it.

The wasm imports host functions such as `promise_batch_action_deploy_contract`. They come from near-sdk's generic promise dispatcher. No Levee code calls them, and there is no method that reaches them.
