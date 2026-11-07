# Levee

Levee repays your Aave debt from a reserve when your health factor crosses a trigger you set. Your position stays in your wallet, and the keeper cannot send funds anywhere else.

Built at NEAR HACKATHON. Tracks: `defi`, `security`. Site: https://levee.qvkare.com

**Unaudited, and live on testnet only.** Do not use it with funds you cannot lose.

## The problem

Borrowers get liquidated in fast moves and pay a bonus to the liquidator. Protection bots usually need broad keys, or need the position moved into their own contract. Levee needs neither: Aave lets anyone repay a borrower's debt, so the rescuer never touches collateral.

## Try it with no keys

Open https://levee.qvkare.com, paste any address, and read its Aave and Hyperliquid positions in order of distance to liquidation. No wallet, no login.

Then, from a clone (Node 22.22 or newer, pnpm 10):

```sh
pnpm install
make judge
```

| Do | See |
|---|---|
| `make verify` | Every recorded run read back from public chains: the NEAR receipt, the rescuer derived from the MPC root key, the EVM sender, target, selector, asset, borrower and amount |
| `make replay` | One real rescue walked step by step, offline |
| `make backtest` | The backtest recomputed from cached data, including misses |
| `make quote-dry` | Live NEAR Intents dry quotes for the reserve routes: Arbitrum to Base, Base to Arbitrum, Base to Hyperliquid. Nothing moves |
| `make attack-demo` | A real function-call key tries every other method in near-sandbox and is refused. Needs Rust and `cargo-near` |
| `make test` | All suites. Needs Rust, `cargo-near` and Foundry |
| `curl 'https://levee.qvkare.com/api/risk?address=0x...'` | The same reading as JSON |
| `curl 'https://levee.qvkare.com/api/route?from=arbitrum&to=base&amount=20'` | A live confidential dry quote for moving a reserve to a rescuer |

## Live evidence

Thirteen rescues and one aborted read, on one position on Base Sepolia, on 2026-11-07. Records are in `evidence/runs/`, and failures stay there.

| Hop | Median | p95 |
|---|---|---|
| Detection to NEAR inclusion | 1.7 s | 3.5 s |
| NEAR inclusion to MPC signature | 5.3 s | 6.9 s |
| Broadcast to Base inclusion | 1.5 s | 1.5 s |
| Total from detection | 8.4 s | 10.2 s |

The sample is small and the testnet was calm. The keeper also reads every 5 seconds, which this table does not include. Separately, 15 of 15 signature requests through the contract completed, with a median of 6.6 s (`evidence/mpc-latency-testnet.json`).

Example rescue, health factor 1.06 to 1.50: [NEAR](https://testnet.nearblocks.io/txns/Cxd3vfhi49p3DRBSFMTvT3qPpvqTj6Bwq1zC6UmRFvMn), [Base Sepolia](https://sepolia.basescan.org/tx/0x501ee4e448e7d14594c59e64981aeafa5234913b93f07db0bfbc5bbf880c3b92).

| Item | Value |
|---|---|
| Levee contract | `levee-core-1503.testnet` |
| Keeper | `levee-keeper-1503.testnet`, key limited to `rescue` |
| MPC | `v1.signer-prod.testnet` |
| Position 1 rescuer | `0xEA3ce7f3AeC39CE95D0fA32F867BA65EFF3b8971` |
| Aave Pool, Base Sepolia | `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27` |

## How a rescue runs

1. The keeper reads `getUserAccountData` from at least two RPCs, and acts only if they agree and are fresh.
2. Below the trigger, it computes the repay needed to reach the target, within the caps.
3. It calls `rescue(id, amount, fees)` on NEAR. It supplies no calldata, no target and no payload.
4. The contract checks caps, budget, cooldown and fee ceilings, builds the EIP-1559 transaction itself, and asks the MPC network to sign `Pool.repay(USDC, amount, 2, borrower)`.
5. The keeper verifies the recovered signer and broadcasts. Anyone could: the signature is public.
6. The run is written to `evidence/runs/`.

The full design is in `docs/SPEC.md`.

## What each key can do

| Actor | Can | Cannot |
|---|---|---|
| Owner | Register, set caps, pause, approve, withdraw float to the registered borrower | |
| Keeper | Ask for a repay within caps, and fire early | Change destination, asset or borrower. Exceed caps. Withdraw. Approve |
| Contract | Sign `approve`, `repay` and `transfer` to fixed targets | Sign arbitrary payloads |
| MPC network | Sign for the derived address | It is trusted for the rescuer key |

The worst a stolen keeper key can do is repay debt early, burn rescuer gas up to the fee ceiling, or burn the daily budget. Caps bound signing, not landing: a signature already issued stays valid until its nonce is used, and it can only repay the registered borrower.

## NEAR pieces

- **Chain Signatures.** The rescuer address on Base belongs to the contract. Without it, this design would need a hot key or a contract on every chain.
- **Function-call keys.** The keeper's key is limited to `rescue` by the protocol. `make attack-demo` shows it.
- **NEAR contract as the policy layer.** One policy controls rescuers on several chains, and it has no admin or upgrade path. Keys on the testnet deployment have not been removed yet; `it_still_works_with_every_key_deleted` covers a locked contract in the sandbox.

- **NEAR Intents.** The site and `make quote-dry` take live confidential 1Click quotes for the reserve routes, with a partner key. No reserve moves through Intents yet: the reserve layer below is not built.

## Backtest

`backtest/` replays real Aave liquidations on Base and Arbitrum from 2025-10-10/11 and 2026-01-31 to 02-06: 5,977 positions, 5,008 in scope. With trigger 1.20, target 1.50 and a 60 second delay:

| Reserve, share of debt | Saved by Levee | Same money held as USDC collateral |
|---|---|---|
| 10% | 36% | 30% |
| 20% | 60% | 51% |
| 30% | 85% | 69% |
| 50% | 95% | 96% |

Limits: only liquidated positions are sampled, so false alarms are unmeasured. 54% of positions were already below the trigger when armed, and count as upfront repays. Infrastructure is assumed to be up with a fixed delay. See `backtest/results/summary.md`.

## When it fails

- The reserve runs out. In the backtest this was the main cause of misses.
- A move outruns the rescue, or a liquidator wins the race.
- NEAR, the MPC network or the RPCs are down.
- The rescuer lacks gas or allowance.

## Not built yet

- **Reserve layer.** The off-venue reserve in a NEAR Intents Agent API wallet needs partner access. Today the reserve is USDC held at the rescuer address.
- **Hyperliquid top-ups.** The site reads Hyperliquid, but Levee does not act on it.
- **Arbitrum.** The contract supports it and fork tests cover repay. There are no live runs.
- **Mainnet, audit and a reproducible build.**

## Repository

| Path | What |
|---|---|
| `contracts/levee` | NEAR contract, Rust |
| `contracts/mock-signer` | MPC stand-in for tests |
| `evm` | Aave fork tests, Foundry |
| `keeper` | Keeper, CLI and verifier, TypeScript |
| `web` | Site and risk API, Next.js on Cloudflare Workers |
| `backtest` | Liquidation replay |
| `evidence` | Run records and the claims ledger |

## Prior work and disclosures

This repository was started on 2026-11-07, inside the hackathon window. The design draws on ideas from the author's earlier projects Quoral (Monad) and Lentic (Zcash). No contract or keeper code was copied from them. `web/tools/design-check.mjs` was carried over from an earlier project, and is baseline under Q-005.

Most of the code was written by AI coding agents under human direction, as Q-005 allows. Third-party libraries are listed in `package.json`, `Cargo.toml` and `.gitmodules`.

## License

MIT
