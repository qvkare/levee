# Levee

- **What.** Levee repays your Aave v3 USDC debt from your own collateral when your health factor falls below a trigger you set. It sells just enough to bring the health factor back to your target.
- **Why.** Repaying early costs a swap. Being liquidated costs a liquidation bonus, 5% of the debt closed on Aave's WETH on Base. Your position stays in your wallet, and every sale is checked on chain against your trigger and your price bound.
- **NEAR.** A NEAR contract with no keys decides when and how much, and signs for the rescuer address through Chain Signatures. The keeper's key can call one method on it and nothing else.
- **Proof.** 20 testnet rescues on Base Sepolia through NEAR testnet, 7 of them from collateral, the last two after both contract accounts had lost their last key. `make verify` reads them back from public chains. A backtest replays every USDC borrower on Aave v3 Base and Arbitrum through two crashes and a calm month, misses included.
- **Try it.** https://leveefi.xyz reads any address, with no wallet. From a clone, `pnpm install && make judge` needs no keys or funds and takes about 6 minutes.

## The problem

Borrowers get liquidated in fast moves and pay the liquidator a bonus. Repaying part of the debt before that point, by selling some collateral, costs the swap instead of the bonus. It has to happen at the right moment, often while the borrower is asleep, so it gets automated, and automation needs a way to act on the position. Levee keeps that way narrow:

- The borrower approves a capped amount of their collateral's aToken to `LeveeUnwind` and calls `authorize` with their trigger, target, price bound, collateral and Uniswap pool. There is no Safe, module or credit delegation.
- `LeveeUnwind` has no owner and cannot be upgraded. It sells only while the health factor is below the borrower's trigger, only within their bound against Aave's oracle, and only to repay their own USDC debt. `revoke()` stops it at once.
- When to act and how much is decided by a NEAR contract with no keys. It signs for the rescuer address on every chain through Chain Signatures.

## Who it is for

Borrowers with more than about $10k of USDC debt against volatile collateral. In the 2025-10 crash, at the 1% bound, the backtest made $34.5k net on positions with $10k to $100k of debt and $452.9k on larger ones, and lost $313k on smaller ones, mostly to gas. In the calm month it lost $122k in all: it avoided $22k of bonus and paid $134k for swaps. Wallets and lending front-ends that want to offer a rescue without holding their users' funds are the other audience.

**Proposal, not built:** a fee of 0.1% of the USDC repaid, charged only on an unwind that lands, to an address fixed when the helper is deployed, with nothing to set up. In the 2025-10 replay at trigger 1.20 and the 1% bound, unwinds repaid $58.2M on both chains, so the fee would have been about $58k, 7% of the $781k of bonus they avoided, and the net would have fallen from +$175k to about +$116k. DeFi Saver charges 0.05% per automation plus its swap fee, so this is not a claim to be cheaper.

## Try it with no keys

Open https://leveefi.xyz, paste any address, and read its Aave and Hyperliquid positions in order of distance to liquidation. No wallet, no login.

Then, from a clone (Node 22.22 or newer, pnpm 10):

```sh
pnpm install
make judge
```

| Do | See |
|---|---|
| `make verify` | Every recorded run read back from public chains: the NEAR receipt, the rescuer derived from the MPC root key, the EVM sender, target, calldata and outcome, and that both contract accounts have no keys. Each claim in `evidence/claims.json` ends as PASS, proven here from public chains, or RECORDED, on file but not proven by this command: claims backed by a test, which `make test` runs, and runs that were aborted or failed, kept for the record |
| `make replay` | The collateral rescue made after the contract lost its keys, walked step by step offline |
| `make backtest` | Both backtests recomputed from cached data, including misses. About 5 minutes |
| `make quote-dry` | Live NEAR Intents dry quotes for the reserve routes: Arbitrum to Base, Base to Arbitrum, Base to Hyperliquid. Nothing moves |
| `make attack-demo` | Real function-call keys try every other method in near-sandbox and are refused. Needs Rust and `cargo-near` |
| `make test` | All suites. Needs Rust, `cargo-near` and Foundry |
| `curl 'https://leveefi.xyz/api/risk?address=0x...'` | The same reading as JSON |
| `curl 'https://leveefi.xyz/api/route?from=arbitrum&to=base&amount=20'` | A live confidential dry quote for moving a reserve to a rescuer |

## Live evidence

On Base Sepolia and NEAR testnet. Records are in `evidence/runs/`, and failures stay there.

- **Repay from collateral**, 2026-11-08: seven rescues and one aborted run on one WETH position, each from health factor 1.48 to 1.80. The last two ran after both contract accounts had lost their last key. In the aborted run the keeper's quote put the sale past the borrower's 1% bound, so it sent nothing.
- **Repay from a reserve**, 2026-11-07: thirteen rescues and one aborted read.

| Hop | Collateral, median | p95 | Reserve, median | p95 |
|---|---|---|---|---|
| Detection to NEAR inclusion | 1.6 s | 1.9 s | 1.7 s | 3.5 s |
| NEAR inclusion to MPC signature | 5.2 s | 6.7 s | 5.3 s | 6.9 s |
| Broadcast to Base inclusion | 0.5 s | 1.6 s | 1.5 s | 1.5 s |
| Total from detection | 7.9 s | 9.2 s | 8.4 s | 10.2 s |

The samples are small and the testnet was calm. The keeper also reads every 5 seconds, which this table does not include. The team added the liquidity in the testnet pool at Aave's oracle price, so sale prices there are no measure of slippage. Separately, 15 of 15 signature requests through the contract completed, with a median of 6.6 s (`evidence/mpc-latency-testnet.json`).

Collateral rescue after the keys were deleted, health factor 1.48 to 1.80: [NEAR](https://testnet.nearblocks.io/txns/EXWuscQyobKfnFwUFvs7higAinm6RmRpCJ7ThLioan3j), [Base Sepolia](https://sepolia.basescan.org/tx/0xa852c9db6842bb23b92ac90db056a4d989bd872c375fb61c4004baad8901c897).

Reserve rescue, health factor 1.06 to 1.50: [NEAR](https://testnet.nearblocks.io/txns/Cxd3vfhi49p3DRBSFMTvT3qPpvqTj6Bwq1zC6UmRFvMn), [Base Sepolia](https://sepolia.basescan.org/tx/0x501ee4e448e7d14594c59e64981aeafa5234913b93f07db0bfbc5bbf880c3b92).

## Contracts

Everything below is on testnet. Nothing is deployed on any mainnet.

### Levee's own

| Contract | Network | Address | Source |
|---|---|---|---|
| Levee v0.2, repay from collateral or from a reserve | NEAR testnet | [levee-core-v2-1503.testnet](https://testnet.nearblocks.io/address/levee-core-v2-1503.testnet) | `contracts/levee` |
| LeveeUnwind, sells collateral to repay. No owner, no upgrade | Base Sepolia | [0x308a7b2872F6006522280026a750fCD1c5Bd63D2](https://sepolia.basescan.org/address/0x308a7b2872F6006522280026a750fCD1c5Bd63D2) | `evm/src/LeveeUnwind.sol`, verified on [Sourcify](https://repo.sourcify.dev/84532/0x308a7b2872F6006522280026a750fCD1c5Bd63D2) |
| Levee v0.1, reserve mode only | NEAR testnet | [levee-core-1503.testnet](https://testnet.nearblocks.io/address/levee-core-1503.testnet) | `contracts/levee`, before collateral mode was added |

### Accounts Levee acts through

| Account | Network | Address |
|---|---|---|
| Keeper. One key limited to `rescue_from_collateral` on v0.2, one limited to `rescue` on v0.1 | NEAR testnet | [levee-keeper-1503.testnet](https://testnet.nearblocks.io/address/levee-keeper-1503.testnet) |
| Rescuer for v0.2 position 1, derived from the contract by Chain Signatures | Base Sepolia | [0x95ad19E5382ebEfF2C190ed1711515263efDc462](https://sepolia.basescan.org/address/0x95ad19E5382ebEfF2C190ed1711515263efDc462) |
| Rescuer for v0.1 position 1 | Base Sepolia | [0xEA3ce7f3AeC39CE95D0fA32F867BA65EFF3b8971](https://sepolia.basescan.org/address/0xEA3ce7f3AeC39CE95D0fA32F867BA65EFF3b8971) |

### Third-party contracts it calls

| Contract | Network | Address |
|---|---|---|
| Chain Signatures MPC signer | NEAR testnet | [v1.signer-prod.testnet](https://testnet.nearblocks.io/address/v1.signer-prod.testnet) |
| Aave v3 Pool | Base Sepolia | [0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27](https://sepolia.basescan.org/address/0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27) |
| Aave v3 PoolAddressesProvider | Base Sepolia | [0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00](https://sepolia.basescan.org/address/0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00) |
| USDC, Aave's test token | Base Sepolia | [0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f](https://sepolia.basescan.org/address/0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f) |
| WETH | Base Sepolia | [0x4200000000000000000000000000000000000006](https://sepolia.basescan.org/address/0x4200000000000000000000000000000000000006) |
| Uniswap v3 Factory | Base Sepolia | [0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24](https://sepolia.basescan.org/address/0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24) |
| Uniswap v3 QuoterV2 | Base Sepolia | [0xC5290058841028F1614F3A6F0F5816cAd0df5E27](https://sepolia.basescan.org/address/0xC5290058841028F1614F3A6F0F5816cAd0df5E27) |
| Uniswap v3 WETH/USDC 0.30% pool. Liquidity added by the team at Aave's oracle price, so its prices are not a market measure | Base Sepolia | [0x92266210FacF124f190fbad79AA230dfB85926Ce](https://sepolia.basescan.org/address/0x92266210FacF124f190fbad79AA230dfB85926Ce) |

## How a rescue runs

1. The borrower calls `authorize(rescuer, maxSlippageBps, triggerHf, targetHf, collateral, poolFee)` on `LeveeUnwind` and approves a capped amount of the collateral's aToken to it.
2. The keeper reads `getUserAccountData` from at least two RPCs, and acts only if they agree and are fresh.
3. Below the trigger, it computes the USDC repay that brings the health factor to the target, within the caps, and quotes the sale on Uniswap's QuoterV2 from every RPC. It stops here if the quote is past the borrower's bound.
4. It calls `rescue_from_collateral(id, amount, max_sold, fees)` on NEAR, where `max_sold` is the quote plus 0.5%. It supplies no calldata, no target and no payload.
5. The contract checks caps, budget, cooldown and fee ceilings, builds the EIP-1559 transaction itself, and asks the MPC network to sign `LeveeUnwind.unwind(borrower, collateral, amount, poolFee, maxSold)`.
6. The keeper verifies the recovered signer and broadcasts. Anyone could: the signature is public.
7. On Base, the helper checks that the health factor is below the trigger and that the collateral and pool are the authorized ones. The pool sends the USDC first; the helper repays the debt, takes the aTokens the pool is owed, and withdraws them to the pool. The sale must be within the oracle bound and `maxSold`, and the health factor must rise without passing far beyond the target.
8. The run is written to `evidence/runs/`.

Repay from a reserve works the same way with `rescue(id, amount, fees)`, which signs `Pool.repay(USDC, amount, 2, borrower)` from USDC held at the rescuer.

The full design is in `docs/SPEC.md`.

## What each key can do

| Actor | Can | Cannot |
|---|---|---|
| Borrower | Authorize, revoke, and set the aToken allowance, on the lending chain without NEAR | |
| Owner | Register a position, set caps, pause, approve, withdraw float to the registered borrower | |
| Keeper | Ask for a repay within caps, set `max_sold`, fire early | Change the destination, asset, pool or borrower. Exceed caps. Loosen the borrower's price bound. Withdraw |
| NEAR contract | Sign `unwind` to the registered helper, and `approve`, `repay` and `transfer` to fixed targets | Sign arbitrary payloads. It has no keys, so nobody can change its code |
| LeveeUnwind | Sell the authorized collateral in the authorized pool to repay that borrower's USDC debt, below their trigger | Act for anyone else, change its terms, or be upgraded |
| MPC network | Sign for the derived address | It is trusted for the rescuer key |

A stolen keeper key can act only while the borrower's health factor is below their trigger, only on the collateral and pool they named, and not much past their target. Each sale is at most the borrower's bound worse than Aave's oracle, up to the daily cap. In effect it can do what the keeper was meant to do, with worse timing and worse prices within that bound, or burn rescuer gas up to the fee ceiling. The borrower can stop it at once with `revoke()` or a zero allowance. Caps bound signing, not landing: a signature already issued stays valid until its nonce is used, and it can only repay the registered borrower.

## NEAR pieces

- **Chain Signatures.** The rescuer address on Base belongs to the contract. Without it, this design would need a hot key or a contract on every chain.
- **Function-call keys.** The keeper's keys are limited to `rescue_from_collateral` or `rescue` by the protocol. `make attack-demo` shows both.
- **NEAR contract as the policy layer.** One policy controls rescuers on several chains, and it has no admin or upgrade path. Both testnet contract accounts have no keys: the last full-access key was deleted on `levee-core-1503.testnet` ([tx](https://testnet.nearblocks.io/txns/3u8yYEBB9eVJbRGjE27xiHru1aAA4W7Mh4C2rrsZ86fu)) and on `levee-core-v2-1503.testnet` ([tx](https://testnet.nearblocks.io/txns/C5aHVAahMMa3BjqddSDSf7AK8VCkuFiuqizGj7vbzJJA)). `make verify` checks it.
- **NEAR Intents.** The site and `make quote-dry` take live confidential 1Click quotes for the reserve routes, with a partner key. No reserve moves through Intents yet: the reserve layer below is not built.

## Backtest

`backtest/` replays every native USDC borrower on Aave v3 Base and Arbitrum through two crashes and a calm month. Each sale is priced from a real Uniswap v3 QuoterV2 quote at its landing block, against Aave's oracle in the same block. Trigger 1.20, target 1.50, a 60 second delay, and a price bound of 1% or 3%:

| Period | Borrowers | Liquidated | Saved, 1% / 3% | Same USDC as a 30% reserve / repaid upfront | Bonus at risk | Bonus avoided, 1% / 3% | Swap cost, 1% / 3% | Gas, 1% / 3% | Net, 1% / 3% |
|---|---|---|---|---|---|---|---|---|---|
| 2025-10-10 to 10-11 | 49,685 | 952 | 635 / 654 | 720 / 731 | $1.40M | $781k / $1.00M | $89k / $466k | $517k / $456k | +$175k / +$78k |
| 2026-01-31 to 02-06 | 54,479 | 4,077 | 3,424 / 3,547 | 3,541 / 3,541 | $1.42M | $1.07M / $1.14M | $280k / $657k | $18k / $11k | +$774k / +$473k |
| 2025-12-03 to 2026-01-01, calm | 58,170 | 229 | 114 / 114 | 189 / 191 | $26k | $22k / $22k | $134k / $308k | $9k / $3k | −$122k / −$290k |

What it says:

- In both crashes, repaying from collateral avoided more liquidation bonus than it cost. In the calm month, at the 1% bound, it cost $1.60 per borrower armed above the trigger over 30 days, and sold 2.0% of their collateral.
- In 2025-10 it lost $313k on positions under $10k of debt, mostly to gas, and made $487k on larger ones.
- At the 1% bound it saved fewer positions than a reserve or the same USDC repaid upfront, which both need the cash in hand. At 3% in 2026-02 it saved slightly more, 3,547 against 3,541.
- In 2025-10 the commonest reason for a miss was a sale the pool could not fill within the bound, 128 of 317 at 1%, followed by follow-up unwinds that came too late, 114. In 2026-02 late follow-ups led.
- The earlier reserve backtest (`backtest/results/portfolio.md`) found that repaying the same USDC upfront protects one position as well as a reserve, with no carry cost. That is why repaying from collateral is the main mode.

Read these with the figures:

- Saved counts include positions already below the trigger when armed, which unwind at once: 416 of 635 in 2025-10.
- The 2025-10 swap cost includes gains from pools that lagged a falling oracle. Counting no sale better than the oracle, it is $181k and the net is +$83k.
- The replayed keeper resends a reverted unwind every minute. In 2025-10 gas was high during Arbitrum's 41 gwei spike, and 63% of it went on reverted unwinds. The live keeper quotes before sending; with no gas on reverts, the 2025-10 net would be +$502k.
- Each sale fills at its quote, alone in its block. Infrastructure is up with a fixed delay. Two crashes say nothing about how often crashes happen, so none of this is annualised.

Method, validation and every table: `backtest/README.md` and `backtest/results/collateral.md`.

## When it fails

- The pool is too thin or off the oracle, so the sale would pass the borrower's bound. The keeper then sends nothing. In the 2025-10 backtest this was the commonest single reason for a miss.
- A move outruns the rescue, or a liquidator wins the race.
- Another collateral in the account has an LTV of 0, so Aave refuses the aToken transfer. The keeper records it and sends nothing.
- The collateral is paused, or the L2 sequencer is down and Aave's sentinel has stopped liquidations.
- NEAR, the MPC network or the RPCs are down.
- The rescuer lacks gas, or the aToken allowance is used up. In reserve mode, the reserve runs out.

## Not built yet

- **Reserve layer.** The off-venue reserve in a NEAR Intents Agent API wallet needs partner access. Today the reserve is USDC held at the rescuer address.
- **Hyperliquid top-ups.** The site reads Hyperliquid, but Levee does not act on it.
- **Arbitrum.** The contracts support it and fork tests cover both modes there. There are no live runs.
- **Mainnet, an external audit and a reproducible build.**

## Repository

| Path | What |
|---|---|
| `contracts/levee` | NEAR contract, Rust |
| `contracts/mock-signer` | MPC stand-in for tests |
| `evm` | `LeveeUnwind`, its scripts, and Aave and Uniswap fork tests, Foundry |
| `keeper` | Keeper, CLI and verifier, TypeScript |
| `web` | Site and risk API, Next.js on Cloudflare Workers |
| `backtest` | Liquidation replay |
| `evidence` | Run records and the claims ledger |

## Libraries

Third-party libraries are listed in `package.json`, `Cargo.toml` and `.gitmodules`. Most of the code was written by AI coding agents under human direction.

## License

MIT
