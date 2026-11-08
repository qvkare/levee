/**
 * Runs the real near-api-js client against a fake JSON-RPC endpoint, so the bytes it
 * would send to NEAR are what is asserted, not a mock of the library.
 */
import { base58, base64 } from '@scure/base';
import { KeyPair, decodeSignedTransaction, teraToGas } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NearRescueError,
  createNearRescuer,
  createNearViews,
  positionSchema,
  readNearTransaction,
  rescueArgs,
  summariseTransaction,
} from '../src/near.js';

const accountId = 'keeper.testnet';
const contract = 'levee.testnet';
const rpcUrl = 'https://near.invalid';

const request = {
  id: 7,
  amount: 2_500_000n,
  fees: { nonce: 3, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n },
};

const rescueResult = {
  kind: 'rescue',
  id: 7,
  unsigned_tx: '02f8',
  tx_hash: 'ab'.repeat(32),
  big_r: `02${'cd'.repeat(32)}`,
  s: '11'.repeat(32),
  recovery_id: 1,
};

const encodeValue = (value: unknown) =>
  base64.encode(new TextEncoder().encode(JSON.stringify(value)));

const outcomeWith = (status: unknown, receipts: unknown[] = []) => ({
  final_execution_status: 'EXECUTED_OPTIMISTIC',
  status,
  transaction: {
    signer_id: accountId,
    receiver_id: contract,
    actions: [
      {
        FunctionCall: {
          method_name: 'rescue',
          args: encodeValue(rescueArgs(request)),
          gas: 1,
          deposit: '0',
        },
      },
    ],
  },
  transaction_outcome: { block_hash: 'BLOCK', id: 'tx' },
  receipts_outcome: receipts,
});

const rpcError = (name: string, info: unknown) => ({
  error: {
    name: 'HANDLER_ERROR',
    cause: { name, info },
    code: -32000,
    message: 'Server error',
    data: 'error',
  },
});

const fakeRpc = (handlers: Record<string, (params: any) => unknown>) => {
  const calls: { method: string; params: any }[] = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const { id, method, params } = JSON.parse(init.body);
    calls.push({ method, params });
    const handler = handlers[method];
    if (!handler) throw new Error(`unexpected RPC ${method}`);
    const body = handler(params) as { error?: unknown };
    const payload = body && typeof body === 'object' && 'error' in body ? body : { result: body };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
};

const baseHandlers = {
  query: () => ({
    nonce: 41,
    permission: { FunctionCall: { allowance: null, method_names: ['rescue'], receiver_id: contract } },
    block_hash: base58.encode(new Uint8Array(32).fill(2)),
    block_height: 100,
  }),
  block: () => ({ header: { hash: base58.encode(new Uint8Array(32).fill(1)) } }),
  send_tx: () => ({ final_execution_status: 'INCLUDED' }),
};

const rescuer = (over = {}) =>
  createNearRescuer({
    rpcUrl,
    contract,
    accountId,
    privateKey: KeyPair.fromRandom('ed25519').toString(),
    timeoutMs: 5_000,
    ...over,
  });

const sentTransaction = (calls: { method: string; params: any }[]) => {
  const send = calls.find((call) => call.method === 'send_tx');
  if (!send) throw new Error('nothing was sent');
  return decodeSignedTransaction(base64.decode(send.params.signed_tx_base64)).transaction;
};

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rescueArgs', () => {
  it('encodes the shape spec section 4 defines', () => {
    expect(rescueArgs(request)).toEqual({
      id: 7,
      amount: '2500000',
      fees: { nonce: 3, max_fee_per_gas: '1000000', max_priority_fee_per_gas: '1000' },
    });
  });
});

describe('NearRescuer.rescue', () => {
  it('calls rescue on the contract with no deposit, which a function-call key requires', async () => {
    const calls = fakeRpc({
      ...baseHandlers,
      tx: () => outcomeWith({ SuccessValue: encodeValue(rescueResult) }),
    });

    await rescuer().rescue(request);

    const tx = sentTransaction(calls);
    expect(tx.signerId).toBe(accountId);
    expect(tx.receiverId).toBe(contract);
    expect(tx.actions).toHaveLength(1);
    const call = tx.actions[0]?.functionCall;
    expect(call?.methodName).toBe('rescue');
    expect(call?.deposit).toBe(0n);
    expect(call?.gas).toBe(teraToGas(300));
    const sentArgs = new TextDecoder().decode(new Uint8Array(call?.args ?? []));
    expect(JSON.parse(sentArgs)).toEqual(rescueArgs(request));
  });

  it('returns the callback result and the hash of what it signed', async () => {
    const calls = fakeRpc({
      ...baseHandlers,
      tx: () => outcomeWith({ SuccessValue: encodeValue(rescueResult) }),
    });

    const outcome = await rescuer().rescue(request);

    expect(outcome.result).toEqual(rescueResult);
    expect(outcome.nearSender).toBe(accountId);
    const lookup = calls.find((call) => call.method === 'tx');
    expect(lookup?.params.tx_hash).toBe(outcome.nearTx);
    expect(lookup?.params.sender_account_id).toBe(accountId);
    expect(lookup?.params.wait_until).toBe('EXECUTED_OPTIMISTIC');
  });

  it('keeps waiting through RPC timeouts while the MPC signs', async () => {
    let lookups = 0;
    fakeRpc({
      ...baseHandlers,
      tx: () => {
        lookups += 1;
        if (lookups < 2) return rpcError('TIMEOUT_ERROR', {});
        return outcomeWith({ SuccessValue: encodeValue(rescueResult) });
      },
    });

    const outcome = await rescuer().rescue(request);

    expect(lookups).toBe(2);
    expect(outcome.result.kind).toBe('rescue');
  });

  it('keeps waiting through an RPC fault, since the transaction is already in flight', async () => {
    let lookups = 0;
    fakeRpc({
      ...baseHandlers,
      tx: () => {
        lookups += 1;
        if (lookups < 2) return rpcError('INTERNAL_ERROR', { error_message: 'node restarting' });
        return outcomeWith({ SuccessValue: encodeValue(rescueResult) });
      },
    });

    const outcome = await rescuer().rescue(request);

    expect(lookups).toBe(2);
    expect(outcome.result.kind).toBe('rescue');
  });

  it('keeps the hash and the last error when the faults outlast the deadline', async () => {
    fakeRpc({
      ...baseHandlers,
      tx: () => rpcError('INTERNAL_ERROR', { error_message: 'node restarting' }),
    });

    let clock = 0;
    const error = await rescuer({
      // Each read of the clock moves it 600, which leaves room for exactly one poll.
      timeoutMs: 1_500,
      now: () => {
        clock += 600;
        return clock;
      },
    })
      .rescue(request)
      .catch((caught) => caught);

    expect(error.reason).toBe('near_timeout');
    expect(error.nearTx).toEqual(expect.any(String));
    expect(error.message).toContain('node restarting');
  });

  it('treats a timeout on the send as sent, because the transaction may still land', async () => {
    fakeRpc({
      ...baseHandlers,
      send_tx: () => rpcError('TIMEOUT_ERROR', {}),
      tx: () => outcomeWith({ SuccessValue: encodeValue(rescueResult) }),
    });

    const outcome = await rescuer().rescue(request);

    expect(outcome.result.kind).toBe('rescue');
  });

  it('treats a lost answer to the send as sent, then finds the result by polling', async () => {
    fakeRpc({
      ...baseHandlers,
      send_tx: () => {
        throw new Error('socket hang up');
      },
      tx: () => outcomeWith({ SuccessValue: encodeValue(rescueResult) }),
    });

    const outcome = await rescuer().rescue(request);

    expect(outcome.result.kind).toBe('rescue');
  });

  it('retries an invalid nonce with a fresh read of the chain', async () => {
    let sends = 0;
    const calls = fakeRpc({
      ...baseHandlers,
      send_tx: () => {
        sends += 1;
        if (sends > 1) return { final_execution_status: 'INCLUDED' };
        return {
          error: {
            name: 'HANDLER_ERROR',
            cause: { name: 'INVALID_TRANSACTION', info: {} },
            code: -32000,
            message: 'Server error',
            data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: 50, tx_nonce: 42 } } } },
          },
        };
      },
      tx: () => outcomeWith({ SuccessValue: encodeValue(rescueResult) }),
    });

    await rescuer().rescue(request);

    expect(sends).toBe(2);
    expect(calls.filter((call) => call.method === 'query').length).toBeGreaterThanOrEqual(2);
  });

  it('reports a contract panic with the transaction hash', async () => {
    const failure = { ActionError: { kind: { FunctionCallError: { ExecutionError: 'cooldown' } } } };
    fakeRpc({ ...baseHandlers, tx: () => outcomeWith({ Failure: failure }) });

    const error = await rescuer()
      .rescue(request)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(NearRescueError);
    expect(error.reason).toBe('near_failed');
    expect(error.message).toContain('cooldown');
    expect(error.nearTx).toEqual(expect.any(String));
    expect(error.nearSender).toBe(accountId);
  });

  it('refuses a result that lacks the signature', async () => {
    const { s: _s, ...withoutS } = rescueResult;
    fakeRpc({
      ...baseHandlers,
      tx: () => outcomeWith({ SuccessValue: encodeValue(withoutS) }),
    });

    await expect(rescuer().rescue(request)).rejects.toMatchObject({ reason: 'near_bad_result' });
  });

  it('gives up at the deadline and keeps the hash for the record', async () => {
    fakeRpc({ ...baseHandlers, tx: () => rpcError('TIMEOUT_ERROR', {}) });

    let clock = 0;
    const error = await rescuer({
      timeoutMs: 1_000,
      now: () => {
        clock += 600;
        return clock;
      },
    })
      .rescue(request)
      .catch((caught) => caught);

    expect(error.reason).toBe('near_timeout');
    expect(error.nearTx).toEqual(expect.any(String));
  });

  it('reports a rejected send without a hash, since nothing landed', async () => {
    fakeRpc({
      ...baseHandlers,
      send_tx: () => rpcError('INVALID_TRANSACTION', {}),
    });

    const error = await rescuer()
      .rescue(request)
      .catch((caught) => caught);

    expect(error.reason).toBe('near_rejected');
    expect(error.nearTx).toBeNull();
    expect(error.nearSender).toBeNull();
  });
});

describe('createNearViews', () => {
  const position = {
    owner: 'owner.testnet',
    keeper: accountId,
    chain_id: 84532,
    borrower: '0x1111111111111111111111111111111111111111',
    max_per_rescue: '5000000',
    max_per_day: '10000000',
    cooldown_secs: 600,
    paused: false,
    spent_today: '0',
    day: 20_766,
    last_rescue_at: 1_794_042_375_000_000_000,
  };
  const viewResult = (value: unknown) => ({
    result: [...new TextEncoder().encode(JSON.stringify(value))],
    logs: [],
    block_hash: 'x',
    block_height: 1,
  });

  it('reads a position and turns u128 and u64 values into bigints', async () => {
    const calls = fakeRpc({ query: () => viewResult(position) });

    const views = createNearViews({ rpcUrl, contract, mpc: 'v1.signer-prod.testnet' });
    const read = await views.getPosition(4);

    expect(read.max_per_rescue).toBe(5_000_000n);
    expect(read.day).toBe(20_766n);
    expect(read.last_rescue_at).toBeGreaterThan(0n);
    const query = calls[0]?.params;
    expect(query.method_name).toBe('get_position');
    expect(query.account_id).toBe(contract);
    expect(query.finality).toBe('final');
    expect(JSON.parse(new TextDecoder().decode(base64.decode(query.args_base64)))).toEqual({ id: 4 });
  });

  it('reads historical caps by block when asked', async () => {
    const calls = fakeRpc({ query: () => viewResult(position) });

    const views = createNearViews({ rpcUrl, contract, mpc: 'v1.signer-prod.testnet' });
    await views.getPosition(4, 'SomeBlockHash');

    expect(calls[0]?.params.block_id).toBe('SomeBlockHash');
  });

  it('rejects a position that does not match the spec shape', () => {
    expect(positionSchema.safeParse({ ...position, paused: 'no' }).success).toBe(false);
  });
});

describe('summariseTransaction', () => {
  const receipt = (status: unknown) => ({ outcome: { status } });

  it('reads the call back out of the transaction', () => {
    const summary = summariseTransaction(
      outcomeWith({ SuccessValue: encodeValue(rescueResult) }, [
        receipt({ SuccessValue: '' }),
      ]) as never,
    );
    expect(summary).toMatchObject({
      success: true,
      failure: null,
      signerId: accountId,
      receiverId: contract,
      methodName: 'rescue',
      args: rescueArgs(request),
      blockHash: 'BLOCK',
      returnValue: rescueResult,
    });
  });

  it('fails when any receipt failed, even if the transaction status looks fine', () => {
    const summary = summariseTransaction(
      outcomeWith({ SuccessValue: '' }, [
        receipt({ SuccessValue: '' }),
        receipt({ Failure: { ActionError: 'boom' } }),
      ]) as never,
    );
    expect(summary.success).toBe(false);
    expect(summary.failure).toContain('boom');
  });
});

describe('readNearTransaction', () => {
  it('falls back to the next endpoint, as an archival node would need', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        attempts += 1;
        const { id } = JSON.parse(init.body);
        const body =
          url === 'https://pruned.invalid'
            ? rpcError('UNKNOWN_TRANSACTION', { requested_transaction_hash: 'x' })
            : { result: outcomeWith({ SuccessValue: encodeValue(rescueResult) }) };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
      }),
    );

    const status = await readNearTransaction(
      ['https://pruned.invalid', 'https://archival.invalid'],
      'hash',
      accountId,
    );

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(status.success).toBe(true);
  });

  it('throws when no endpoint knows the transaction', async () => {
    fakeRpc({ tx: () => rpcError('UNKNOWN_TRANSACTION', { requested_transaction_hash: 'x' }) });

    await expect(readNearTransaction([rpcUrl], 'hash', accountId)).rejects.toThrow(
      /could not resolve/,
    );
  });
});

describe('collateral mode on NEAR', () => {
  const viewResult = (value: unknown) => ({
    result: [...new TextEncoder().encode(JSON.stringify(value))],
    logs: [],
    block_hash: 'x',
    block_height: 1,
  });

  it('calls rescue_from_collateral with the same arguments and no deposit', async () => {
    const calls = fakeRpc({
      ...baseHandlers,
      tx: () => outcomeWith({ SuccessValue: encodeValue({ ...rescueResult, kind: 'unwind' }) }),
    });

    const outcome = await rescuer().rescue({ ...request, mode: 'collateral' });

    const call = sentTransaction(calls).actions[0]?.functionCall;
    expect(call?.methodName).toBe('rescue_from_collateral');
    expect(call?.deposit).toBe(0n);
    const sentArgs = new TextDecoder().decode(new Uint8Array(call?.args ?? []));
    expect(JSON.parse(sentArgs)).toEqual(rescueArgs(request));
    expect(outcome.result.kind).toBe('unwind');
  });

  it('calls rescue when the mode is reserve or not given', async () => {
    for (const mode of ['reserve', undefined] as const) {
      const calls = fakeRpc({
        ...baseHandlers,
        tx: () => outcomeWith({ SuccessValue: encodeValue(rescueResult) }),
      });
      await rescuer().rescue({ ...request, ...(mode ? { mode } : {}) });
      expect(sentTransaction(calls).actions[0]?.functionCall?.methodName).toBe('rescue');
    }
  });

  it('reads a position with a collateral config, and one without', () => {
    const base = {
      owner: 'owner.testnet',
      keeper: accountId,
      chain_id: 84532,
      borrower: '0x1111111111111111111111111111111111111111',
      max_per_rescue: '5000000',
      max_per_day: '10000000',
      cooldown_secs: 600,
      paused: false,
      spent_today: '0',
      day: 20_766,
      last_rescue_at: 0,
    };
    const collateral = { asset: '0x4200000000000000000000000000000000000006', pool_fee: 3000 };
    expect(positionSchema.parse({ ...base, collateral }).collateral).toEqual(collateral);
    expect(positionSchema.parse({ ...base, collateral: null }).collateral).toBeNull();
    // A v0.1 contract has no such field at all.
    expect(positionSchema.parse(base).collateral).toBeUndefined();
  });

  it('reads get_chain for the helper, and null for an unknown chain', async () => {
    const config = {
      chain_id: 84532,
      pool: '0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27',
      usdc: '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f',
      unwind: '0x5555555555555555555555555555555555555555',
      gas_limit_unwind: 600000,
    };
    const calls = fakeRpc({ query: () => viewResult(config) });
    const views = createNearViews({ rpcUrl, contract, mpc: 'v1.signer-prod.testnet' });

    expect((await views.getChain(84532))?.unwind).toBe(config.unwind);
    expect(calls[0]?.params.method_name).toBe('get_chain');
    expect(
      JSON.parse(new TextDecoder().decode(base64.decode(calls[0]?.params.args_base64))),
    ).toEqual({ chain_id: 84532 });

    fakeRpc({ query: () => viewResult(null) });
    expect(await views.getChain(1)).toBeNull();
  });
});
