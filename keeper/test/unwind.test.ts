import {
  type Address,
  encodeAbiParameters,
  encodeErrorResult,
  keccak256,
  pad,
  parseAbi,
  toBytes,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { decimalsOf, liquidationThresholdOf } from '../src/evm.js';
import { parseWad } from '../src/decision.js';
import {
  ABOVE_TRIGGER_ERROR,
  ABOVE_TRIGGER_SELECTOR,
  UNWIND_SELECTOR,
  UNWOUND_TOPIC,
  decodeUnwind,
  decodeUnwound,
  helperConfigMismatch,
  isAboveTrigger,
  swapPrice,
  unwindCalldata,
  unwoundEvents,
} from '../src/unwind.js';
import { borrower, helper, unwoundLog, weth } from './support/fakes.js';

const rescuer: Address = '0x3333333333333333333333333333333333333333';
const stranger: Address = '0x4444444444444444444444444444444444444444';

describe('the unwind call', () => {
  it('uses the selector of unwind(address,address,uint256,uint24)', () => {
    const digest = keccak256(toBytes('unwind(address,address,uint256,uint24)'));
    expect(UNWIND_SELECTOR).toBe(digest.slice(0, 10));
    expect(UNWIND_SELECTOR).toBe('0xd0cda3c2');
  });

  /** The same vector the contract's tests check, from `cast calldata`. */
  it('encodes byte for byte as cast does', () => {
    const data = unwindCalldata({
      borrower: '0x1234567890AbcdEF1234567890aBcdef12345678',
      collateral: weth,
      amount: 2_500_000n,
      poolFee: 3_000n,
    });
    expect(data).toBe(
      '0xd0cda3c2' +
        '0000000000000000000000001234567890abcdef1234567890abcdef12345678' +
        '0000000000000000000000004200000000000000000000000000000000000006' +
        '00000000000000000000000000000000000000000000000000000000002625a0' +
        '0000000000000000000000000000000000000000000000000000000000000bb8',
    );
  });

  it('decodes back to the same fields', () => {
    const call = { borrower, collateral: weth, amount: 7n, poolFee: 10_000n };
    expect(decodeUnwind(unwindCalldata(call))).toEqual(call);
  });

  it('returns null for another selector or broken calldata', () => {
    expect(decodeUnwind('0x573ade81')).toBeNull();
    expect(decodeUnwind(`${UNWIND_SELECTOR}00`)).toBeNull();
  });
});

describe('the Unwound event', () => {
  const fields = { borrower, rescuer, collateral: weth, repaid: 5n, sold: 6n };

  it('uses the topic of Unwound(address,address,address,uint256,uint256)', () => {
    expect(UNWOUND_TOPIC).toBe(keccak256(toBytes('Unwound(address,address,address,uint256,uint256)')));
  });

  it('decodes with every address indexed', () => {
    expect(decodeUnwound(unwoundLog(fields))).toEqual(fields);
  });

  it('decodes with none indexed', () => {
    const log = {
      address: helper,
      topics: [UNWOUND_TOPIC],
      data: encodeAbiParameters(
        [
          { type: 'address' },
          { type: 'address' },
          { type: 'address' },
          { type: 'uint256' },
          { type: 'uint256' },
        ],
        [borrower, rescuer, weth, 5n, 6n],
      ),
    };
    expect(decodeUnwound(log)).toEqual(fields);
  });

  it('decodes with only the borrower indexed', () => {
    const log = {
      address: helper,
      topics: [UNWOUND_TOPIC, pad(borrower)],
      data: encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
        [rescuer, weth, 5n, 6n],
      ),
    };
    expect(decodeUnwound(log)).toEqual(fields);
  });

  it('ignores another event and a malformed one', () => {
    expect(decodeUnwound({ ...unwoundLog(fields), topics: [keccak256('0x01')] })).toBeNull();
    expect(decodeUnwound({ ...unwoundLog(fields), data: '0x' })).toBeNull();
  });

  it('counts only events from the helper itself', () => {
    const forged = unwoundLog({ ...fields, sold: 1n, address: stranger });
    expect(unwoundEvents([forged, unwoundLog(fields)], helper)).toEqual([fields]);
  });
});

describe('the above-trigger refusal', () => {
  it('is recognised from its revert data', () => {
    const abi = parseAbi([`error ${ABOVE_TRIGGER_ERROR}`]);
    const data = encodeErrorResult({ abi, errorName: 'AboveTrigger' });
    expect(data).toBe(ABOVE_TRIGGER_SELECTOR);
    expect(isAboveTrigger(data)).toBe(true);
    expect(isAboveTrigger(data.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('is not any other revert, or none', () => {
    expect(isAboveTrigger('0x08c379a0')).toBe(false);
    expect(isAboveTrigger(null)).toBe(false);
    expect(isAboveTrigger(undefined)).toBe(false);
  });
});

describe('helperConfigMismatch', () => {
  const expected = { triggerWad: parseWad('1.25'), targetWad: parseWad('1.6'), maxSlippageBps: 100n };
  const actual = {
    rescuer,
    maxSlippageBps: 100n,
    triggerHf: parseWad('1.25'),
    targetHf: parseWad('1.6'),
  };

  it('agrees when every value matches', () => {
    expect(helperConfigMismatch(expected, actual, rescuer)).toBeNull();
  });

  it('compares the rescuer in any case', () => {
    expect(
      helperConfigMismatch(expected, actual, rescuer.toUpperCase().replace('0X', '0x') as Address),
    ).toBeNull();
  });

  it.each([
    ['rescuer', { rescuer: stranger }, 'authorized rescuer'],
    ['revoked rescuer', { rescuer: `0x${'00'.repeat(20)}` as Address }, 'authorized rescuer'],
    ['trigger', { triggerHf: parseWad('1.3') }, 'trigger'],
    ['target', { targetHf: parseWad('1.5') }, 'target'],
    ['slippage', { maxSlippageBps: 50n }, 'max_slippage_bps'],
  ])('names a different %s', (_name, change, word) => {
    expect(helperConfigMismatch(expected, { ...actual, ...change }, rescuer)).toContain(word);
  });

  it('lists every difference at once', () => {
    const all = { rescuer: stranger, maxSlippageBps: 1n, triggerHf: 1n, targetHf: 2n };
    expect(helperConfigMismatch(expected, all, rescuer)?.split('; ')).toHaveLength(4);
  });
});

describe('swapPrice', () => {
  it('prices a sale against the oracle', () => {
    // 5,000 USDC for 2.5075 WETH: 5,000 / 2.5075 = $1,994.01794616... each. Against
    // $2,000: (2,000 − 1,994.01794616) / 2,000 = 0.0029910 = 29.91 bps, so 29.
    const price = swapPrice(
      { repaid: 5_000n * 10n ** 6n, sold: 2_507_500_000_000_000_000n },
      18n,
      2_000n * 10n ** 8n,
      10n ** 8n,
    );
    expect(price).toEqual({
      repaid: 5_000n * 10n ** 6n,
      sold: 2_507_500_000_000_000_000n,
      collateralPriceBase: 2_000n * 10n ** 8n,
      usdcPriceBase: 10n ** 8n,
      effectivePriceBase: 199_401_794_616n,
      discountBps: 29n,
    });
  });

  it('values the USDC at its own oracle price', () => {
    // 2,000 USDC at $0.999 for 1 WETH: $1,998 each, 10 bps under $2,000.
    const price = swapPrice({ repaid: 2_000n * 10n ** 6n, sold: 10n ** 18n }, 18n, 2_000n * 10n ** 8n, 99_900_000n);
    expect(price.effectivePriceBase).toBe(1_998n * 10n ** 8n);
    expect(price.discountBps).toBe(10n);
  });

  it('is negative when the sale beat the oracle', () => {
    const price = swapPrice({ repaid: 2_010n * 10n ** 6n, sold: 10n ** 18n }, 18n, 2_000n * 10n ** 8n, 10n ** 8n);
    expect(price.discountBps).toBe(-50n);
  });

  it('does not divide by zero', () => {
    expect(swapPrice({ repaid: 1n, sold: 0n }, 18n, 1n, 1n).effectivePriceBase).toBe(0n);
    expect(swapPrice({ repaid: 1n, sold: 1n }, 18n, 0n, 1n).discountBps).toBe(0n);
  });
});

describe('Aave reserve configuration', () => {
  it('reads the liquidation threshold and decimals from their bits', () => {
    // WETH on Base: LTV 8,000 at bits 0 to 15, threshold 8,300 at 16 to 31, bonus 10,500
    // at 32 to 47, 18 decimals at 48 to 55, and the active flag at 56.
    const configuration =
      8_000n | (8_300n << 16n) | (10_500n << 32n) | (18n << 48n) | (1n << 56n);
    expect(liquidationThresholdOf(configuration)).toBe(8_300n);
    expect(decimalsOf(configuration)).toBe(18n);
  });
});
