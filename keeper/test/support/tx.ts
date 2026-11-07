import { type Hex, keccak256, parseTransaction as viemParse } from 'viem';

/** Parses a broadcast transaction, failing the test if none was sent. */
export function parseTransaction(serialized: Hex | undefined) {
  if (!serialized) throw new Error('nothing was broadcast');
  const parsed = viemParse(serialized);
  if (parsed.type !== 'eip1559') throw new Error(`expected EIP-1559, got ${parsed.type}`);
  return parsed;
}

export function parseTransactionKeccak(serialized: Hex | undefined): Hex {
  if (!serialized) throw new Error('nothing was broadcast');
  return keccak256(serialized);
}
