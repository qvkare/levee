# Hyperliquid reference: 2025-10-10

**This is not part of the Aave result and says nothing about a Levee rescue.** Hyperliquid is a separate gate in `docs/SPEC.md` section 1. No delay is modelled here.

Source: `ConejoCapital/HyperMultiAssetedADL` at commit `79bad0fae259fc1fcd9fce960953ae3b398f2db7`, `liquidations_full_12min.csv`, sha256 `1afd4c09494665d82fadf3ad65fb210b6b3a2213ab66ed2bc179aa23b2b55684`. 63637 rows. 1465 liquidated cross-margin BTC and ETH longs used, 32 left out because their fills show no loss against entry.

## What the file cannot show

- **No survivors.** It lists liquidations only, so a true survival rate at any leverage cannot be computed from it.
- **No account margin.** Leverage below is inferred from entry and fill, as if the position were alone in the account. Cross accounts often are not.
- **No marks.** Liquidation uses the mark price. The file has fills, which can print below it. An earlier note puts the 1-day BTC low on Hyperliquid at 100,837, above the lowest fill here.
- **Twelve minutes only.** The first BTC or ETH cross fill is after the fall had begun, so the drop below understates the full move.
- **No timing.** With no mark path there is no way to place a trigger in time, so a top-up is assumed to arrive. ADL is out of scope.

## Fresh long opened at the highest fill in the file

A lone cross long entered at the highest fill price and marked to the lowest. This is arithmetic on a proxy, not an observed position.

| Coin | Leverage | Fall to liquidation | Fall in file | Survives with no top-up | Top-up needed |
|---|---|---|---|---|---|
| BTC | 3x | 32.5% | 10.6% | yes | none |
| BTC | 5x | 19.0% | 10.6% | yes | none |
| BTC | 10x | 8.9% | 10.6% | no | 0.17 E |
| ETH | 3x | 32.0% | 13.1% | yes | none |
| ETH | 5x | 18.4% | 13.1% | yes | none |
| ETH | 10x | 8.2% | 13.1% | no | 0.49 E |

E is starting equity.

## Positions that were liquidated, by inferred leverage

Conditional on liquidation, so 0% survived with no top-up by construction. Each column is the share that would have stayed above maintenance at the lowest fill in the file if that top-up had arrived in time. Buckets: 3x is up to 3.5x, 5x is 3.5x to 7x, 10x is 7x to 15x.

| Coin | Inferred leverage | Positions | Notional | 0.25 E | 0.5 E | 1 E | 2 E |
|---|---|---|---|---|---|---|---|
| BTC | 3x | 0 | $0k | n/a | n/a | n/a | n/a |
| BTC | 5x | 115 | $19.5M | 24.3% | 93.9% | 100.0% | 100.0% |
| BTC | 10x | 490 | $403.2M | 1.0% | 23.1% | 89.6% | 100.0% |
| BTC | over 15x | 259 | $204.8M | 0.0% | 0.0% | 6.6% | 56.8% |
| ETH | 3x | 38 | $2.7M | 100.0% | 100.0% | 100.0% | 100.0% |
| ETH | 5x | 403 | $177.7M | 34.2% | 92.6% | 100.0% | 100.0% |
| ETH | 10x | 118 | $75.1M | 1.7% | 19.5% | 85.6% | 100.0% |
| ETH | over 15x | 42 | $31.9M | 0.0% | 0.0% | 2.4% | 78.6% |

Many liquidated positions show low inferred leverage because they were entered far above the crash price, not because they started safe. A long opened near the top is not the same as a fresh long at that leverage.
