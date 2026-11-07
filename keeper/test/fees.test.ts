import { describe, expect, it } from 'vitest';
import { chooseFees, chooseNonce } from '../src/fees.js';

const ceilings = { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n };

describe('chooseFees', () => {
  it('bids twice the base fee plus the priority fee', () => {
    const choice = chooseFees([{ baseFeePerGas: 100n, priorityFeePerGas: 10n }], ceilings);
    expect(choice).toEqual({ ok: true, maxFeePerGas: 210n, maxPriorityFeePerGas: 10n });
  });

  it('takes the highest quote across endpoints', () => {
    const choice = chooseFees(
      [
        { baseFeePerGas: 100n, priorityFeePerGas: 20n },
        { baseFeePerGas: 150n, priorityFeePerGas: 10n },
      ],
      ceilings,
    );
    expect(choice).toEqual({ ok: true, maxFeePerGas: 320n, maxPriorityFeePerGas: 20n });
  });

  it('clamps the bid to the ceiling while the base fee still fits under it', () => {
    const choice = chooseFees([{ baseFeePerGas: 900n, priorityFeePerGas: 10n }], ceilings);
    expect(choice).toEqual({ ok: true, maxFeePerGas: 1_000n, maxPriorityFeePerGas: 10n });
  });

  it('clamps the priority fee to its own ceiling', () => {
    const choice = chooseFees([{ baseFeePerGas: 10n, priorityFeePerGas: 500n }], ceilings);
    expect(choice).toEqual({ ok: true, maxFeePerGas: 520n, maxPriorityFeePerGas: 100n });
  });

  it('keeps the priority fee at or below the max fee', () => {
    const choice = chooseFees([{ baseFeePerGas: 1n, priorityFeePerGas: 500n }], {
      maxFeePerGas: 50n,
      maxPriorityFeePerGas: 100n,
    });
    expect(choice).toEqual({ ok: true, maxFeePerGas: 50n, maxPriorityFeePerGas: 50n });
  });

  it('accepts a base fee exactly at the ceiling', () => {
    const choice = chooseFees([{ baseFeePerGas: 1_000n, priorityFeePerGas: 1n }], ceilings);
    expect(choice).toMatchObject({ ok: true, maxFeePerGas: 1_000n });
  });

  it('stops when the base fee is above the ceiling, since the bid could never land', () => {
    const choice = chooseFees([{ baseFeePerGas: 1_001n, priorityFeePerGas: 1n }], ceilings);
    expect(choice).toMatchObject({ ok: false, reason: 'fee_above_ceiling' });
  });

  it('stops when no endpoint returned fees', () => {
    expect(chooseFees([], ceilings)).toMatchObject({ ok: false, reason: 'fees_unavailable' });
  });
});

describe('chooseNonce', () => {
  it('takes the highest nonce seen', () => {
    expect(chooseNonce([4, 7, 5])).toBe(7);
  });

  it('keeps a zero nonce', () => {
    expect(chooseNonce([0, 0])).toBe(0);
  });

  it('returns null when no endpoint answered', () => {
    expect(chooseNonce([])).toBeNull();
  });
});
