import { type Address, type Hex, encodeFunctionData, keccak256, parseAbi, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  REPAY_SELECTOR,
  type RepayIntent,
  type RescueResult,
  SignatureRefused,
  assembleSignedTransaction,
  assertMatchesIntent,
  decodeRepay,
  parseSignature,
  rescueResultSchema,
} from '../src/signature.js';
import { createSimulatedMpc, repayCalldata, unsignedTransaction } from './support/simulated-mpc.js';

const pool: Address = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const usdc: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const borrower: Address = '0x1111111111111111111111111111111111111111';
const attacker: Address = '0x2222222222222222222222222222222222222222';

const mpc = createSimulatedMpc();

const intent: RepayIntent = {
  chainId: 8453,
  nonce: 3,
  maxFeePerGas: 1_000_000n,
  maxPriorityFeePerGas: 1_000n,
  pool,
  usdc,
  borrower,
  amount: 2_500_000n,
  rescuer: mpc.address,
};

const fields = (over: Partial<Parameters<typeof unsignedTransaction>[0]> = {}) => ({
  chainId: intent.chainId,
  nonce: intent.nonce,
  maxFeePerGas: intent.maxFeePerGas,
  maxPriorityFeePerGas: intent.maxPriorityFeePerGas,
  to: pool,
  data: repayCalldata(usdc, intent.amount, 2n, borrower),
  ...over,
});

const signed = (over: Parameters<typeof fields>[0] = {}): RescueResult =>
  mpc.sign(unsignedTransaction(fields(over)), 1);

const refusedReason = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof SignatureRefused) return error.reason;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('parseSignature', () => {
  const r = 'ab'.repeat(32);
  const s = '11'.repeat(32);

  it('takes r from bytes 1..33 of the compressed big_r', () => {
    const parsed = parseSignature({ big_r: `02${r}`, s, recovery_id: 1 });
    expect(parsed).toEqual({ r: `0x${r}`, s: `0x${s}`, yParity: 1 });
  });

  it('accepts the MPC contract nested form, upper case, and 0x prefixes', () => {
    const nested = {
      big_r: { affine_point: `03${r}`.toUpperCase() },
      s: { scalar: `0x${s}`.toUpperCase().replace('0X', '0x') },
      recovery_id: 0,
    };
    expect(parseSignature(nested)).toEqual({ r: `0x${r}`, s: `0x${s}`, yParity: 0 });
  });

  it.each([
    ['an uncompressed big_r', { big_r: `04${r}`, s, recovery_id: 0 }],
    ['a short big_r', { big_r: `02${r.slice(2)}`, s, recovery_id: 0 }],
    ['a short s', { big_r: `02${r}`, s: s.slice(2), recovery_id: 0 }],
    ['a high s', { big_r: `02${r}`, s: 'ff'.repeat(32), recovery_id: 0 }],
    ['a recovery id above 1', { big_r: `02${r}`, s, recovery_id: 2 }],
  ])('refuses %s', async (_name, input) => {
    expect(await refusedReason(() => parseSignature(input))).toBe('malformed_signature');
  });
});

describe('assembleSignedTransaction', () => {
  it('rebuilds the exact bytes a local signer produces for the same fields', async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const unsigned = unsignedTransaction(fields());
    const parsed = parseTransaction(unsigned);
    if (parsed.type !== 'eip1559') throw new Error('unreachable');

    const expected = await account.signTransaction({
      type: 'eip1559',
      chainId: parsed.chainId,
      nonce: parsed.nonce ?? 0,
      maxFeePerGas: parsed.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? 0n,
      gas: parsed.gas ?? 0n,
      to: parsed.to ?? null,
      value: parsed.value ?? 0n,
      data: parsed.data ?? '0x',
      accessList: [],
    });

    const assembled = await assembleSignedTransaction(createSimulatedMpc(privateKey).sign(unsigned, 1));
    expect(assembled.serialized).toBe(expected);
    expect(assembled.hash).toBe(keccak256(expected));
    expect(assembled.signer).toBe(account.address);
  });

  it('recovers across many signatures, covering both parities and short r or s', async () => {
    const parities = new Set<number>();
    for (let nonce = 0; nonce < 64; nonce++) {
      const result = mpc.sign(unsignedTransaction(fields({ nonce })), 1);
      parities.add(result.recovery_id);
      const assembled = await assembleSignedTransaction(result);
      expect(assembled.signer).toBe(mpc.address);
      expect(assembled.tx.nonce).toBe(nonce);
    }
    expect(parities).toEqual(new Set([0, 1]));
  });

  it('keeps a zero nonce, a zero value and an empty access list', async () => {
    const { tx } = await assembleSignedTransaction(signed({ nonce: 0 }));
    expect(tx.nonce).toBe(0);
    expect(tx.value).toBe(0n);
    expect(tx.accessList).toEqual([]);
  });

  it('accepts a 0x prefix on unsigned_tx and tx_hash', async () => {
    const result = signed();
    const assembled = await assembleSignedTransaction({
      ...result,
      unsigned_tx: `0x${result.unsigned_tx}`,
      tx_hash: `0x${result.tx_hash}`,
    });
    expect(assembled.signer).toBe(mpc.address);
  });

  it('refuses a tx_hash that is not the hash of unsigned_tx', async () => {
    const result = { ...signed(), tx_hash: 'ab'.repeat(32) };
    expect(await refusedReason(() => assembleSignedTransaction(result))).toBe('hash_mismatch');
  });

  it('refuses a signature paired with swapped transaction fields', async () => {
    const original = signed();
    const swapped = unsignedTransaction(fields({ to: attacker }));
    const result = { ...original, unsigned_tx: swapped.slice(2), tx_hash: keccak256(swapped).slice(2) };
    const assembled = await assembleSignedTransaction(result);
    // The signature was over other bytes, so it recovers to a stranger.
    expect(assembled.signer).not.toBe(mpc.address);
    expect(await refusedReason(() => assertMatchesIntent(assembled, intent))).toBe('signer_mismatch');
  });

  it('refuses bytes that are not an EIP-1559 transaction', async () => {
    const result = { ...signed(), unsigned_tx: 'deadbeef' };
    expect(await refusedReason(() => assembleSignedTransaction(result))).toBe('malformed_transaction');
  });

  it('refuses an already signed transaction passed as unsigned', async () => {
    const assembled = await assembleSignedTransaction(signed());
    const hex = assembled.serialized;
    const result = { ...signed(), unsigned_tx: hex.slice(2), tx_hash: keccak256(hex).slice(2) };
    expect(await refusedReason(() => assembleSignedTransaction(result))).toBe('malformed_transaction');
  });
});

describe('assertMatchesIntent', () => {
  const check = async (over: Parameters<typeof fields>[0], expected: RepayIntent = intent) => {
    const assembled = await assembleSignedTransaction(signed(over));
    return refusedReason(() => assertMatchesIntent(assembled, expected));
  };

  it('passes the transaction that was asked for', async () => {
    const assembled = await assembleSignedTransaction(signed());
    expect(() => assertMatchesIntent(assembled, intent)).not.toThrow();
  });

  it('refuses a signer other than the derived rescuer', async () => {
    const stranger = createSimulatedMpc();
    const assembled = await assembleSignedTransaction(stranger.sign(unsignedTransaction(fields()), 1));
    expect(await refusedReason(() => assertMatchesIntent(assembled, intent))).toBe('signer_mismatch');
  });

  it.each<[string, Parameters<typeof fields>[0]]>([
    ['another chain', { chainId: 42161 }],
    ['another target', { to: attacker }],
    ['value attached', { value: 1n }],
    ['another nonce', { nonce: 9 }],
    ['higher max fee', { maxFeePerGas: 2_000_000n }],
    ['higher priority fee', { maxPriorityFeePerGas: 2_000n }],
    ['another asset', { data: repayCalldata(attacker, intent.amount, 2n, borrower) }],
    ['a larger amount', { data: repayCalldata(usdc, intent.amount + 1n, 2n, borrower) }],
    ['the wrong rate mode', { data: repayCalldata(usdc, intent.amount, 1n, borrower) }],
    ['another borrower', { data: repayCalldata(usdc, intent.amount, 2n, attacker) }],
  ])('refuses %s', async (_name, over) => {
    expect(await check(over)).toBe('intent_mismatch');
  });

  it('refuses a USDC transfer, the call that would move funds elsewhere', async () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function transfer(address to, uint256 amount)']),
      functionName: 'transfer',
      args: [attacker, intent.amount],
    });
    expect(await check({ data, to: usdc })).toBe('intent_mismatch');
    expect(await check({ data })).toBe('intent_mismatch');
  });

  it('refuses a USDC approval', async () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function approve(address spender, uint256 amount)']),
      functionName: 'approve',
      args: [attacker, 2n ** 256n - 1n],
    });
    expect(await check({ data })).toBe('intent_mismatch');
  });

  it('refuses repay calldata that does not decode', async () => {
    expect(await check({ data: REPAY_SELECTOR as Hex })).toBe('intent_mismatch');
  });

  it('compares addresses regardless of checksum case', async () => {
    const assembled = await assembleSignedTransaction(signed());
    const lower: RepayIntent = {
      ...intent,
      pool: pool.toLowerCase() as Address,
      usdc: usdc.toLowerCase() as Address,
      rescuer: mpc.address.toLowerCase() as Address,
    };
    expect(() => assertMatchesIntent(assembled, lower)).not.toThrow();
  });
});

describe('decodeRepay', () => {
  it('reads the fields back', () => {
    expect(decodeRepay(repayCalldata(usdc, 123n, 2n, borrower))).toEqual({
      asset: usdc,
      amount: 123n,
      rateMode: 2n,
      onBehalfOf: borrower,
    });
  });

  it('returns null for another selector', () => {
    expect(decodeRepay('0xa9059cbb')).toBeNull();
  });
});

describe('rescueResultSchema', () => {
  it('accepts the shape spec section 4 describes', () => {
    expect(rescueResultSchema.parse(signed()).kind).toBe('rescue');
  });

  it('rejects a result with a missing signature part', () => {
    const { s: _s, ...partial } = signed();
    expect(rescueResultSchema.safeParse(partial).success).toBe(false);
  });
});
