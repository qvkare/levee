# Levee

Spec: `docs/SPEC.md`. Read it before changing behaviour.

## Layout

- `contracts/levee`: NEAR contract (Rust)
- `contracts/mock-signer`: MPC stand-in for tests
- `evm`: Foundry fork tests and EVM vectors
- `keeper`: TypeScript keeper and CLI
- `web`: Next.js site and public risk tool
- `backtest`: replay of historic liquidations
- `evidence`: run records and the claims ledger

## Rules

- Keys live in environment variables. Never commit them.
- Commit one finished piece of work at a time, and describe it.
- Failed runs stay in `evidence/`.
