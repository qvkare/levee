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

These are the values the deployment below used.

```sh
LEVEE=levee-core-v2-1503.testnet
OWNER=levee-owner-1503.testnet
KEEPER=levee-keeper-1503.testnet
UNWIND=0x308a7b2872F6006522280026a750fCD1c5Bd63D2   # LeveeUnwind on Base Sepolia
BORROWER=0x1BA01ceF25983F71e508f139Ecb10030b0403331 # the account whose USDC debt is repaid
POOL_FEE=3000                                       # fee tier of the WETH/USDC pool the helper swaps in
```

Create the contract account from the owner, which funds it. The 207 KB wasm needs about 2.1 NEAR of storage, and the rest is a float for the 1 yoctoNEAR each signature costs.

```sh
near account create-account fund-myself "$LEVEE" '4 NEAR' autogenerate-new-keypair save-to-keychain \
  sign-as "$OWNER" network-config testnet sign-with-keychain send
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

Give the keeper a key for collateral mode only. The v0.1 key names `levee-core-1503.testnet`, so it cannot call v0.2 at all. The keeper reads its key from `KEEPER_PRIVATE_KEY`, so generate the pair locally, write the private key straight into a gitignored env file such as `.env.testnet-v2` in the repo root, and add only the public key:

```sh
near account add-key "$KEEPER" grant-function-call-access --allowance unlimited \
  --contract-account-id "$LEVEE" --function-names rescue_from_collateral \
  use-manually-provided-public-key "$KEEPER_PUBLIC_KEY" network-config testnet sign-with-keychain send
```

On EVM, the borrower then calls the helper's `authorize` for the rescuer this prints, and approves the WETH aToken to the helper:

```sh
pnpm --silent --filter keeper keeper derive-address --id 1 --contract "$LEVEE" --network testnet
```

```solidity
authorize(rescuer, maxSlippageBps, triggerHf, targetHf, collateral, poolFee)
```

`collateral` and `poolFee` must be the asset and `POOL_FEE` registered above: the helper refuses any other, so an unwind for this position reverts with `TermsMismatch` if they differ, and the keeper refuses to start. `authorize` itself checks that the asset is an Aave reserve other than USDC and that the Uniswap pool for that fee exists. The trigger, target and slippage limit are the borrower's, and the keeper reads them back and must match them too. From the borrower's wallet, with its own signing flags such as `--account`, as the deployment below did:

```sh
cast send "$UNWIND" "authorize(address,uint16,uint64,uint64,address,uint24)" \
  "$RESCUER" 100 1500000000000000000 1800000000000000000 \
  0x4200000000000000000000000000000000000006 "$POOL_FEE" --rpc-url https://sepolia.base.org
```

The rescuer needs Base Sepolia ETH for gas, and nothing else: six unwinds cost it 0.000019 ETH in all at 0.006 gwei. On mainnet, finish with `near account delete-keys "$LEVEE" public-keys <key> network-config mainnet sign-with-keychain send` for every full-access key.

#### Deployed

Run on 2026-11-08 with the steps above, from wasm SHA-256 `991dda79c3cff0138c871dbc4a9d96087450dd76dcf3ecf3892db8995003eab3`, which `view-account-summary` reports as the account's code hash.

| Step | Result | NEAR transaction |
|---|---|---|
| Create `levee-core-v2-1503.testnet`, 4 NEAR from the owner | Created | [`7ZUAEtnx…uFzhd`](https://testnet.nearblocks.io/txns/7ZUAEtnxCTGZnnnKNjLMBQRd4URWge6V8yrtLs1uFzhd) |
| Deploy and `new` | `get_chain(84532)` returns the config above, with `unwind` `0x308a7b2872f6006522280026a750fcd1c5bd63d2` | [`HMoJJjFR…9WgX`](https://testnet.nearblocks.io/txns/HMoJJjFRxbEBEhaHK1Aritk5Cy9sCE4rJ3LBeWti9WgX) |
| `register` | Position 1, borrower `0x1ba0…3331`, keeper `levee-keeper-1503.testnet`, WETH at fee 3000, 100 USDC per rescue, 500 a day, no cooldown | [`4KgMnudS…LvX6`](https://testnet.nearblocks.io/txns/4KgMnudSMJNY43q42V3sD1LoySwyZzRcL3TGzrbxLvX6) |
| `add-key` | `ed25519:CDpEuXw2jkzsywk592Qo4HFRjA8oi27GcYVh2QLDJGXq` on the keeper, `rescue_from_collateral` on `levee-core-v2-1503.testnet` only | [`3FYnnZeL…69QK`](https://testnet.nearblocks.io/txns/3FYnnZeL6B5RTByyu4JAh2gq757pRs3tHbsvj1H869QK) |
| `derive-address --id 1` | Rescuer `0x95ad19E5382ebEfF2C190ed1711515263efDc462`, matching the live `derived_public_key` | |
| `delete-keys` on v0.1, `levee-core-1503.testnet` | Its only full-access key, `ed25519:AgX6NqakXdaJD4PzFABsTLxnKmEEisozd617LNVi8Ead`, deleted at block 276,764,277. No access key is left | [`3u8yYEBB…86fu`](https://testnet.nearblocks.io/txns/3u8yYEBB9eVJbRGjE27xiHru1aAA4W7Mh4C2rrsZ86fu) |
| `delete-keys` on v0.2, `levee-core-v2-1503.testnet` | Its only full-access key, `ed25519:GRz6zN114TpPrRB5Go6zANhjC2csyW7kuLwUsWJV2ZdE`, deleted at block 276,764,289. No access key is left | [`C5aHVAah…zJJA`](https://testnet.nearblocks.io/txns/C5aHVAahMMa3BjqddSDSf7AK8VCkuFiuqizGj7vbzJJA) |
| `rescue_from_collateral` after the deletion | Run `2026-11-08T10-39-36Z-base-sepolia-1`: the keeper's function-call key asked, the keyless contract signed through MPC, and the unwind repaid 7.31 USDC on Base Sepolia, health factor 1.48 to 1.8035 | [`EXWuscQy…oan3j`](https://testnet.nearblocks.io/txns/EXWuscQyobKfnFwUFvs7higAinm6RmRpCJ7ThLioan3j), block 276,764,677 |

Both testnet contract accounts were then locked as a mainnet deployment would be: no key can sign for them, so only their own code acts for them, and the 1 yoctoNEAR each signature costs still comes from their balance. The claim `contracts-keyless-rescue-after` in `evidence/claims.json` names both accounts in `no_access_keys`, so `make verify` reads their key lists every time. The EVM side, the rescues and their records are in `evm/README.md` ("Base Sepolia deployment") and `docs/SPEC.md` section 9 ("Testnet").

### v0.2 on two chains

The same wasm, deployed again on 2026-11-11 to a new account, with Base Sepolia and Arbitrum Sepolia in its chain list. Base Sepolia uses a new `LeveeUnwind`, which has the Aave v3.0 fix that the Arbitrum Sepolia fork found. That helper is at the same address on both chains (`evm/README.md`, "Two-chain deployment").

`contracts/build.sh` on 2026-11-11 gave wasm SHA-256 `991dda79c3cff0138c871dbc4a9d96087450dd76dcf3ecf3892db8995003eab3`, the same as v0.2. Both accounts report code hash `BJhnFqoK1e6JJQqKiciUtfQxmouGi81hhfJ3qPVRUASE`, its base58 form. Anyone can compare them:

```sh
for a in levee-core-v2-1503.testnet levee-v2-multi-1503.testnet; do
  curl -s https://rpc.testnet.near.org -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$a\"}}" | jq -r '.result.code_hash'
done
```

The account was created by the testnet faucet service, which funds it with 10 NEAR, so the owner's balance was not touched. Its key went to the legacy keychain:

```sh
near account create-account sponsor-by-faucet-service levee-v2-multi-1503.testnet \
  autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

Deploy and `new` with both chains. The fee ceilings and gas limits are v0.2's on both chains. Arbitrum's NodeInterface read zero L1 data gas for an `unwind` on Arbitrum Sepolia, and 938 on Arbitrum One, so 1,000,000 fits.

```sh
UNWIND=0xD9a54F7743B5BbA3fdC77c96b932f50ce67177e8
near contract deploy levee-v2-multi-1503.testnet use-file contracts/target/near/levee/levee.wasm \
  with-init-call new json-args "$(jq -cn --arg unwind "$UNWIND" '{
    mpc_contract: "v1.signer-prod.testnet",
    chains: [
      { chain_id: 84532, pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27", usdc: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", unwind: $unwind,
        max_fee_per_gas_ceiling: "5000000000", max_priority_fee_ceiling: "2000000000",
        gas_limit_approve: 100000, gas_limit_repay: 300000, gas_limit_transfer: 100000, gas_limit_unwind: 1000000 },
      { chain_id: 421614, pool: "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff", usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", unwind: $unwind,
        max_fee_per_gas_ceiling: "5000000000", max_priority_fee_ceiling: "2000000000",
        gas_limit_approve: 100000, gas_limit_repay: 300000, gas_limit_transfer: 100000, gas_limit_unwind: 1000000 }
    ]}')" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send
```

The owner registers one position per chain, with the same borrower, keeper and caps: 421614 with Aave's WETH `0x1dF462e2712496373A347f8ad10802a5E95f053D`, then 84532 with WETH `0x4200000000000000000000000000000000000006`. Both use `pool_fee` 3000, `max_per_rescue` "100000000", `max_per_day` "500000000" and `cooldown_secs` 0, with the same `register` call as above and `sign-with-legacy-keychain`.

The keeper's new key was generated locally. Its private half went straight into the gitignored `.env.testnet-v2m`, and only the public half was added:

```sh
near account add-key levee-keeper-1503.testnet grant-function-call-access --allowance unlimited \
  --contract-account-id levee-v2-multi-1503.testnet --function-names rescue_from_collateral \
  use-manually-provided-public-key "$KEEPER_PUBLIC_KEY" network-config testnet sign-with-legacy-keychain send
```

One keeper process serves both positions. Its positions file lists ids 1 and 2, each with trigger 1.5, target 1.6, `mode` collateral, `max_slippage_bps` 100 and `quote_tolerance_bps` 50. Its `fee_ceilings` give 5 and 2 gwei for both 84532 and 421614. `BASE_RPC_URLS` and `ARBITRUM_RPC_URLS` each name two endpoints.

#### Deployed

| Step | Result | NEAR transaction |
|---|---|---|
| Create `levee-v2-multi-1503.testnet` through the faucet service | Created with 10 NEAR | [`Hwtdfic3…gY4U`](https://testnet.nearblocks.io/txns/Hwtdfic38KCCjBeiJZfTVTcdAfmY4tLzWnhTEyStgY4U) |
| Deploy and `new` | `get_chain(84532)` and `get_chain(421614)` return the config above, each with `unwind` `0xd9a54f7743b5bba3fdc77c96b932f50ce67177e8` | [`CCSEgJer…c3gz`](https://testnet.nearblocks.io/txns/CCSEgJergAAGKMwXyfumzFqG488GYoALxRrwSWVrc3gz) |
| `register`, Arbitrum Sepolia | Position 1 | [`CeQ2mnSh…m1aJn`](https://testnet.nearblocks.io/txns/CeQ2mnShUevhUbW2Wc58Q2Td9ounvvSeiNoREqom1aJn) |
| `register`, Base Sepolia | Position 2 | [`9SmWN8QU…Srnn`](https://testnet.nearblocks.io/txns/9SmWN8QU2HWiXNwfc7Fkw2c1EaBqBWyrya7b4DfxSrnn) |
| `add-key` | `ed25519:4PR4WfCfq421aCxP5wt9udHnYGxu93owDt7rvSKNfGKW` on the keeper, `rescue_from_collateral` on `levee-v2-multi-1503.testnet` only | [`FxQxXNiq…M48Z1`](https://testnet.nearblocks.io/txns/FxQxXNiqH5rqbd3Wv96uR6Ww8wfcfiDE4hjJo6CM48Z1) |
| `derive-address --id 1`, `--id 2` | Rescuers `0x008418a72481867d027E2b9cA179AC089de69403` and `0x6d65fC5Cb4536abae4cD6526856bB10526e80295`, matching the live `derived_public_key` | |
| Rescues on both chains, before the deletion | Runs `2026-11-11T20-30-08Z-arbitrum-sepolia-1` and `…-base-sepolia-2`, both NEAR calls at block 277,264,508 | in the records |
| `delete-keys` | The only full-access key, `ed25519:F5ZXz26BWNVyBK8bDD97thjdESAYv58FarwTzgoieZML`, deleted at block 277,265,005. No access key is left | [`6SAwnLxi…yti62`](https://testnet.nearblocks.io/txns/6SAwnLxi8QTR4UKqCSfpAASkzZzENDrjXudakVJyti62) |
| Rescues on both chains, after the deletion | Runs `2026-11-11T20-37-17Z-base-sepolia-2` and `…-arbitrum-sepolia-1`, NEAR calls at blocks 277,265,218 and 277,265,219 | in the records |

The claims `one-keyless-policy-two-chains-arbitrum` and `one-keyless-policy-two-chains-base` name this account in `no_access_keys`, so `make verify` reads its empty key list every time.
