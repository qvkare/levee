import { describe, expect, it } from 'vitest';
import { MAX_UINT256 } from '../src/decision.js';
import { DEFAULT_QUORUM, type Sample, evaluateQuorum, readQuorum } from '../src/quorum.js';

const nowMs = 1_800_000_000_000;
const options = { ...DEFAULT_QUORUM, chainId: 8453, nowMs };

const sample = (rpc: string, over: Partial<Sample> = {}): Sample => ({
  rpc,
  chainId: 8453,
  blockNumber: 100n,
  blockTimestamp: BigInt(nowMs / 1000 - 2),
  healthFactor: 1_200_000_000_000_000_000n,
  totalCollateralBase: 20_000_000_000_00n,
  totalDebtBase: 13_000_000_000_00n,
  liquidationThresholdBps: 8_400n,
  usdcPriceBase: 99_975_000n,
  usdcDebt: 13_000_000_000n,
  rescuerUsdc: 5_000_000_000n,
  rescuerAllowance: 50_000_000_000n,
  ...over,
});

describe('evaluateQuorum: agreement', () => {
  it('accepts two endpoints that match', () => {
    const result = evaluateQuorum([sample('a'), sample('b')], [], options);
    expect(result.ok).toBe(true);
  });

  it('acts on the most recent block', () => {
    const result = evaluateQuorum(
      [sample('a', { blockNumber: 100n }), sample('b', { blockNumber: 103n }), sample('c', { blockNumber: 101n })],
      [],
      options,
    );
    expect(result).toMatchObject({ ok: true, sample: { rpc: 'b' } });
  });

  it('accepts a gap of exactly 0.5%', () => {
    const high = 1_000_000_000_000_000_000n;
    const low = (high * 995n) / 1000n;
    const result = evaluateQuorum(
      [sample('a', { healthFactor: high }), sample('b', { healthFactor: low })],
      [],
      options,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a gap just over 0.5%', () => {
    const high = 1_000_000_000_000_000_000n;
    const low = (high * 995n) / 1000n - 1n;
    const result = evaluateQuorum(
      [sample('a', { healthFactor: high }), sample('b', { healthFactor: low })],
      [],
      options,
    );
    expect(result).toMatchObject({ ok: false, reason: 'disagreement' });
  });

  it.each([
    'healthFactor',
    'totalCollateralBase',
    'totalDebtBase',
    'liquidationThresholdBps',
    'usdcPriceBase',
    'usdcDebt',
    'rescuerUsdc',
    'rescuerAllowance',
  ] as const)('refuses when only %s disagrees', (field) => {
    const result = evaluateQuorum(
      [sample('a'), sample('b', { [field]: (sample('a')[field] * 102n) / 100n })],
      [],
      options,
    );
    expect(result).toMatchObject({ ok: false, reason: 'disagreement' });
    if (!result.ok) expect(result.detail).toContain(field);
  });

  it('lets any one endpoint veto, even outvoted two to one', () => {
    const result = evaluateQuorum(
      [sample('a'), sample('b'), sample('liar', { healthFactor: 500_000_000_000_000_000n })],
      [],
      options,
    );
    expect(result).toMatchObject({ ok: false, reason: 'disagreement' });
  });

  it('treats a repaid account as agreement, not as a divide by zero', () => {
    const noDebt = { healthFactor: MAX_UINT256, totalDebtBase: 0n, usdcDebt: 0n };
    const result = evaluateQuorum([sample('a', noDebt), sample('b', noDebt)], [], options);
    expect(result.ok).toBe(true);
  });

  it('refuses when one endpoint sees debt and the other sees none', () => {
    const result = evaluateQuorum(
      [sample('a'), sample('b', { healthFactor: MAX_UINT256 })],
      [],
      options,
    );
    expect(result).toMatchObject({ ok: false, reason: 'disagreement' });
  });
});

describe('evaluateQuorum: endpoint count', () => {
  it('refuses a single endpoint', () => {
    const result = evaluateQuorum([sample('a')], [{ rpc: 'b', error: 'down' }], options);
    expect(result).toMatchObject({ ok: false, reason: 'too_few_rpcs' });
  });

  it('refuses when nothing answered', () => {
    const result = evaluateQuorum([], [], options);
    expect(result).toMatchObject({ ok: false, reason: 'too_few_rpcs' });
  });

  it('survives a third endpoint being down', () => {
    const result = evaluateQuorum(
      [sample('a'), sample('b')],
      [{ rpc: 'c', error: 'timeout' }],
      options,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.failures).toHaveLength(1);
  });

  it('does not count one endpoint listed twice', () => {
    const result = evaluateQuorum([sample('a'), sample('a')], [], options);
    expect(result).toMatchObject({ ok: false, reason: 'too_few_rpcs' });
  });

  it('does not count an endpoint on another chain', () => {
    const result = evaluateQuorum([sample('a'), sample('b', { chainId: 1 })], [], options);
    expect(result).toMatchObject({ ok: false, reason: 'too_few_rpcs' });
    expect(result.failures).toEqual([{ rpc: 'b', error: 'serves chain 1' }]);
  });
});

describe('evaluateQuorum: freshness', () => {
  const aged = (rpc: string, secs: number) =>
    sample(rpc, { blockTimestamp: BigInt(nowMs / 1000 - secs) });

  it('accepts 29 seconds', () => {
    expect(evaluateQuorum([aged('a', 29), aged('b', 29)], [], options).ok).toBe(true);
  });

  it('refuses 30 seconds, the spec says less than', () => {
    const result = evaluateQuorum([aged('a', 30), aged('b', 30)], [], options);
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('refuses when only one endpoint is fresh', () => {
    const result = evaluateQuorum([aged('a', 1), aged('b', 120)], [], options);
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('does not let a stale endpoint veto two fresh ones', () => {
    const result = evaluateQuorum(
      [aged('a', 1), aged('b', 1), { ...aged('c', 120), healthFactor: 1n }],
      [],
      options,
    );
    expect(result.ok).toBe(true);
  });

  it('does not trust a block dated far in the future', () => {
    const result = evaluateQuorum([aged('a', -60), aged('b', -60)], [], options);
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
  });
});

describe('readQuorum', () => {
  const { nowMs: _unused, ...quorumOptions } = options;
  const now = () => nowMs;

  it('reads each endpoint and judges the answers', async () => {
    const result = await readQuorum(
      [
        { url: 'a', read: async () => sample('a') },
        { url: 'b', read: async () => sample('b') },
      ],
      quorumOptions,
      now,
    );
    expect(result.ok).toBe(true);
  });

  it('judges freshness after the reads finish, so slow reads cannot hide an old block', async () => {
    let clock = nowMs;
    const slow = async (rpc: string) => {
      clock += 60_000;
      return sample(rpc);
    };
    const result = await readQuorum(
      [
        { url: 'a', read: () => slow('a') },
        { url: 'b', read: () => slow('b') },
      ],
      quorumOptions,
      () => clock,
    );
    expect(result).toMatchObject({ ok: false, reason: 'stale', nowMs: nowMs + 120_000 });
  });

  it('records an endpoint that fails instead of throwing', async () => {
    const result = await readQuorum(
      [
        { url: 'a', read: async () => sample('a') },
        { url: 'b', read: () => Promise.reject(new Error('connection refused')) },
      ],
      quorumOptions,
      now,
    );
    expect(result).toMatchObject({ ok: false, reason: 'too_few_rpcs' });
    expect(result.failures[0]?.rpc).toBe('b');
    expect(result.failures[0]?.error).toContain('connection refused');
  });

  it('uses the short message of a viem error', async () => {
    const error = Object.assign(new Error('long'), { shortMessage: 'HTTP request failed.' });
    const result = await readQuorum(
      [
        { url: 'a', read: async () => sample('a') },
        { url: 'b', read: () => Promise.reject(error) },
      ],
      quorumOptions,
      now,
    );
    expect(result.failures[0]?.error).toBe('HTTP request failed.');
  });
});
