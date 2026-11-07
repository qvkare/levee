/** Fee selection for a rescue. Pure, for the same reason as the decision. */

export interface FeeCeilings {
  /** The contract's `max_fee_per_gas_ceiling` for the chain, wei. */
  maxFeePerGas: bigint;
  /** The contract's `max_priority_fee_ceiling` for the chain, wei. */
  maxPriorityFeePerGas: bigint;
}

export interface FeeQuote {
  baseFeePerGas: bigint;
  priorityFeePerGas: bigint;
}

export type FeeChoice =
  | { ok: true; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { ok: false; reason: 'fees_unavailable' | 'fee_above_ceiling'; detail: string };

const largest = (values: bigint[]): bigint => values.reduce((a, b) => (b > a ? b : a));

/**
 * Bids twice the highest base fee seen plus the priority fee, so the transaction
 * survives a few full blocks, and clamps to the contract's ceilings. `rescue` rejects
 * anything above them (rule 6), and a bid under the base fee would never land, so
 * that case stops here rather than spending a NEAR call.
 */
export function chooseFees(quotes: FeeQuote[], ceilings: FeeCeilings): FeeChoice {
  if (quotes.length === 0) {
    return { ok: false, reason: 'fees_unavailable', detail: 'no RPC returned fees' };
  }
  const baseFee = largest(quotes.map((quote) => quote.baseFeePerGas));
  const priorityFee = largest(quotes.map((quote) => quote.priorityFeePerGas));

  const wantedMaxFee = baseFee * 2n + priorityFee;
  const maxFeePerGas = wantedMaxFee < ceilings.maxFeePerGas ? wantedMaxFee : ceilings.maxFeePerGas;
  if (baseFee > maxFeePerGas) {
    return {
      ok: false,
      reason: 'fee_above_ceiling',
      detail: `base fee ${baseFee} is above the ceiling ${ceilings.maxFeePerGas}`,
    };
  }

  const cappedPriority =
    priorityFee < ceilings.maxPriorityFeePerGas ? priorityFee : ceilings.maxPriorityFeePerGas;
  return {
    ok: true,
    maxFeePerGas,
    maxPriorityFeePerGas: cappedPriority < maxFeePerGas ? cappedPriority : maxFeePerGas,
  };
}

/** Takes the highest nonce any endpoint reports. A low one would be rejected as used. */
export function chooseNonce(nonces: number[]): number | null {
  return nonces.length === 0 ? null : Math.max(...nonces);
}
