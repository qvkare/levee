# Levee contracts

| Crate | What it is |
|---|---|
| `levee` | The NEAR contract. Sections 2 to 4 and 9 of `docs/SPEC.md` define it |
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
| `levee` unit | 278 | Every rule on its boundaries, for `rescue` and `rescue_from_collateral`, and what leaves the contract: receipts, gas, deposits, logs, return values |
| `levee/tests/vectors.rs` | 6 | Calldata, RLP and signing hash against `cast`, byte for byte, for all five kinds, every Uniswap fee tier and `max_sold` from 1 to the largest u128 |
| `levee/tests/properties.rs` | 6 | Any amount, `max_sold`, nonce and fee decodes in alloy to the same fields, and `to`, selector, asset, borrower, collateral and fee do not change. The daily budget holds under any interleaving |
| `levee/tests/sandbox.rs` | 41 | The real wasm in near-sandbox against the mock signer |
| `mock-signer` unit | 9 | That the mock enforces what the real `sign` enforces |

The sandbox tests refuse a wasm older than its source, so run `build.sh` after any change.

The mock does not sign. The test process plays the MPC node: it signs each request with a key derived the way the real network derives it, and calls `respond`. Signed paths therefore end in a transaction that recovers to the rescuer address.

The 24-hour rules run for real. `max_block_production_delay` is raised in the sandbox config, which makes each fast-forwarded block move the clock by about an hour without slowing normal blocks.

### Gas

```sh
cargo test --manifest-path contracts/Cargo.toml -p levee --test sandbox gas_of_a_rescue -- --nocapture
```

This runs `gas_of_a_rescue` and `gas_of_a_rescue_from_collateral`, prints each receipt and fails if the budget stops fitting. On near-sandbox 2.14.0, `rescue` burns 2.61 to 2.62 Tgas and `rescue_from_collateral`, with its `max_sold`, 2.63 to 2.64, against the 5 Tgas the minimum leaves the method. `on_signed` burns 1.73 and 1.76. `docs/SPEC.md`, section "Gas", has the figures and the reasons for each constant.

### Fixtures

```sh
contracts/levee/fixtures/generate.sh
```

This writes `tx_vectors.json`. It builds each vector from `cast calldata`, `cast to-rlp` and `cast keccak`, builds it again with `cast mktx --raw-unsigned`, and aborts if they differ. The `unwind` vectors use placeholder helper addresses, since the encoding does not depend on what is deployed there, and encode `unwind(address,address,uint256,uint24,uint256)`, selector `0x65afae08`, with `max_sold` as the last word. `mpc_sign_response.json` is a real response read from the testnet signer, not generated.

## `rescue_from_collateral`

`rescue_from_collateral(id, amount, max_sold, fees)` and `preview_rescue_from_collateral(id, amount, max_sold, fees)`. `max_sold` is a `U128` string: the most collateral, in its base units, the helper may sell. The keeper sets it from a fresh Uniswap QuoterV2 quote plus a tolerance, so that a searcher who sees the signed transaction cannot sandwich it up to the borrower's whole slippage bound. The contract has no price to judge it by, so it refuses only zero, `max_sold must be above zero`, and encodes it as `unwind`'s fifth argument. It is not charged to the budget, which counts USDC. The helper applies the borrower's own bound as well, so a stolen keeper key can loosen the cap only up to that bound.

## Keeper keys

A keeper's NEAR key is a function-call key on the Levee contract, limited to the keeper methods its positions use:

| Positions in | `method_names` |
|---|---|
| Collateral mode | `rescue_from_collateral` |
| Reserve mode | `rescue` |
| Both | `rescue`, `rescue_from_collateral` |

Never an empty list: NEAR reads that as every method. A key limited to `rescue` cannot call `rescue_from_collateral`, so a v0.1 key does not gain collateral mode's worse case, a forced deleverage, without its owner adding the method. `a_function_call_key_limited_to_rescue_can_do_nothing_else` and `a_function_call_key_limited_to_rescue_from_collateral_can_do_nothing_else` show each key failing with `MethodNameMismatch` on every other method. `make attack-demo` runs both.

`prepare_allowance`, `withdraw_float` and `sweep_gas` stay owner only. Collateral mode needs no rescuer USDC and no allowance, only gas.

## Deploying

The contract cannot be upgraded, so v0.2, which adds `rescue_from_collateral`, is a new deployment on a new account. v0.1 stays live at `levee-core-1503.testnet` for its records. Nothing in this repo runs these commands.

1. Deploy and call `new` from the contract account. `new` is private, so a stranger cannot initialise it first.
2. Fund the contract above its storage cost. Each signature costs it 1 yoctoNEAR, because a function-call key cannot attach a deposit.
3. Delete every full-access key on mainnet. A sandbox test confirms the contract still works with none.

The wasm imports host functions such as `promise_batch_action_deploy_contract`. They come from near-sdk's generic promise dispatcher. No Levee code calls them, and there is no method that reaches them.

### v0.2 on testnet

Needs near-cli-rs 0.31 (`near`), `jq`, `contracts/build.sh` run, the owner and keeper accounts in the keychain, and `LeveeUnwind` deployed on Base Sepolia. `ChainConfig.unwind` is required, so list only chains with a helper: Arbitrum Sepolia has none yet, and is left out.

```sh
LEVEE=levee-core-v2-1503.testnet        # new, unused
OWNER=levee-owner-1503.testnet
KEEPER=levee-keeper-1503.testnet
UNWIND=0x...                            # LeveeUnwind on Base Sepolia
BORROWER=0x...                          # the account whose USDC debt is repaid
POOL_FEE=3000                           # fee tier of the WETH/USDC pool the helper swaps in
```

Create the contract account, then fund it from the owner. The 206 KB wasm needs about 2.1 NEAR of storage, and the rest is a float for the 1 yoctoNEAR each signature costs.

```sh
near account create-account sponsor-by-faucet-service "$LEVEE" autogenerate-new-keypair save-to-keychain network-config testnet create
near tokens "$OWNER" send-near "$LEVEE" '5 NEAR' network-config testnet sign-with-keychain send
```

Deploy and initialise in one transaction. The fee ceilings and the other gas limits are v0.1's, read from `get_chain` on `levee-core-1503.testnet`. `gas_limit_unwind` is 1,000,000, as `evm/README.md` recommends: the helper used up to 595,000 gas on the forks, and the 63/64 rule in its nested calls needs headroom.

```sh
near contract deploy "$LEVEE" use-file contracts/target/near/levee/levee.wasm \
  with-init-call new json-args "$(jq -cn --arg unwind "$UNWIND" '{
    mpc_contract: "v1.signer-prod.testnet",
    chains: [{
      chain_id: 84532,
      pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
      usdc: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
      unwind: $unwind,
      max_fee_per_gas_ceiling: "5000000000",
      max_priority_fee_ceiling: "2000000000",
      gas_limit_approve: 100000,
      gas_limit_repay: 300000,
      gas_limit_transfer: 100000,
      gas_limit_unwind: 1000000
    }]
  }')" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send

near contract call-function as-read-only "$LEVEE" get_chain json-args '{"chain_id":84532}' network-config testnet now
```

Register the position from the owner. WETH at `0x4200…0006` is a reserve in Aave's Base Sepolia market. The collateral config cannot be changed later, so check `UNWIND`, the asset and `POOL_FEE` first. Storage costs under 0.005 NEAR and the rest of the deposit is refunded. The call returns the position id, 1 on a fresh contract.

```sh
near contract call-function as-transaction "$LEVEE" register \
  json-args "$(jq -cn --arg borrower "$BORROWER" --arg keeper "$KEEPER" --argjson fee "$POOL_FEE" '{
    chain_id: 84532,
    borrower: $borrower,
    keeper: $keeper,
    max_per_rescue: "100000000",
    max_per_day: "500000000",
    cooldown_secs: 0,
    collateral: { asset: "0x4200000000000000000000000000000000000006", pool_fee: $fee }
  }')" prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' \
  sign-as "$OWNER" network-config testnet sign-with-keychain send

near contract call-function as-read-only "$LEVEE" get_position json-args '{"id":1}' network-config testnet now
```

Give the keeper a key for collateral mode only. The v0.1 key names `levee-core-1503.testnet`, so it cannot call v0.2 at all.

```sh
near account add-key "$KEEPER" grant-function-call-access --allowance unlimited \
  --contract-account-id "$LEVEE" --function-names rescue_from_collateral \
  autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send
```

On EVM, the borrower then calls the helper's `authorize` for the rescuer this prints, and approves the WETH aToken to the helper:

```sh
pnpm --silent --filter keeper keeper derive-address --id 1 --contract "$LEVEE" --network testnet
```

```solidity
authorize(rescuer, maxSlippageBps, triggerHf, targetHf, collateral, poolFee)
```

`collateral` and `poolFee` must be the asset and `POOL_FEE` registered above: the helper refuses any other, so an unwind for this position reverts with `TermsMismatch` if they differ, and the keeper refuses to start. `authorize` itself checks that the asset is an Aave reserve other than USDC and that the Uniswap pool for that fee exists. The trigger, target and slippage limit are the borrower's, and the keeper reads them back and must match them too. From the borrower's wallet, with its own signing flags such as `--account`, for example:

```sh
cast send "$UNWIND" "authorize(address,uint16,uint64,uint64,address,uint24)" \
  "$RESCUER" 100 1250000000000000000 1600000000000000000 \
  0x4200000000000000000000000000000000000006 "$POOL_FEE" --rpc-url https://sepolia.base.org
``` On mainnet, finish with `near account delete-keys "$LEVEE" public-keys <key> network-config mainnet sign-with-keychain send` for every full-access key.
