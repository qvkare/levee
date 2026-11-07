/**
 * SIMULATED MPC. The keeper runs for real against a local anvil fork of Aave on Base:
 * real Pool bytecode, real state at a pinned block, real transactions on the fork.
 * Two things are stand-ins, and every record says so with `network: "simulated"`:
 *
 *  - The NEAR call is mocked at the `NearRescuer` interface.
 *  - A local key, generated per run, stands in for the MPC signature.
 *
 * Nothing here shows the real NEAR contract or the real MPC network working. Mainnet
 * is only read, to build the fork. Run with `pnpm --filter keeper test:e2e`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Address,
  type Hex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseWad } from '../src/decision.js';
import { type RunRecord, parseRun } from '../src/evidence.js';
import { type EvmClient, createEvmClient } from '../src/evm.js';
import { formatReplay, replayRun } from '../src/replay.js';
import { type RescueContext, type TickResult, tick } from '../src/rescue.js';
import { REPAY_SELECTOR } from '../src/signature.js';
import { verifyRun } from '../src/verify.js';
import { type Anvil, constantPriceCode, startAnvil } from './support/anvil.js';
import { chain, fakeNear, openPosition, positionTarget } from './support/fakes.js';
import { createSimulatedMpc } from './support/simulated-mpc.js';

const WETH: Address = '0x4200000000000000000000000000000000000006';
const AAVE_ORACLE: Address = '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156';
/** The aUSDC contract holds the Pool's USDC, which makes it a convenient faucet. */
const USDC_WHALE: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';

const COLLATERAL = parseEther('10');
const START_HEALTH_FACTOR = 1_500_000_000_000_000_000n;
const RESCUER_FLOAT = 50_000_000_000n;

const POOL_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReserveAToken(address asset) view returns (address)',
]);
const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);
const SCALED_ABI = parseAbi(['function scaledBalanceOf(address user) view returns (uint256)']);
const WETH_ABI = parseAbi(['function deposit() payable']);
const ORACLE_ABI = parseAbi([
  'function getAssetPrice(address asset) view returns (uint256)',
  'function getSourceOfAsset(address asset) view returns (address)',
]);

/** Generous, because a cold fork pages storage in from a public RPC. */
const FORK_TIMEOUT_MS = 60_000;

/**
 * Set rather than estimated. With blocks mining every second, an estimate can go stale
 * before its transaction lands, and Aave then runs out of gas in an inner call.
 */
const SETUP_GAS = 1_000_000n;

/** The default in support/simulated-mpc.ts, standing in for `gas_limit_repay`. */
const SIMULATED_REPAY_GAS_LIMIT = 300_000n;

let anvil: Anvil;
let evidenceDir: string;
let wethFeed: Address;
let startPrice: bigint;
let clients: EvmClient[];

const rescuerKey = generatePrivateKey();
const mpc = createSimulatedMpc(rescuerKey);

const publicClient = () =>
  createPublicClient({ transport: http(anvil.url, { timeout: FORK_TIMEOUT_MS }) });
const testClient = () =>
  createTestClient({ mode: 'anvil', transport: http(anvil.url, { timeout: FORK_TIMEOUT_MS }) });
const walletFor = (key: Hex) =>
  createWalletClient({
    account: privateKeyToAccount(key),
    transport: http(anvil.url, { timeout: FORK_TIMEOUT_MS }),
  });

const mined = async (hash: Hex) => {
  const client = publicClient();
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: FORK_TIMEOUT_MS });
  if (receipt.status === 'success') return;

  const tx = await client.getTransaction({ hash });
  const reason = await client
    .call({
      account: tx.from,
      to: tx.to,
      data: tx.input,
      value: tx.value,
      blockNumber: receipt.blockNumber,
    })
    .then(
      () => 'succeeds when replayed',
      (error: { shortMessage?: string; details?: string }) =>
        `${error.shortMessage ?? 'reverted'} ${error.details ?? ''}`,
    );
  throw new Error(`setup transaction reverted, gas ${receipt.gasUsed} of ${tx.gas}: ${reason}`);
};

const accountData = async (user: Address) => {
  const [collateral, debt, , threshold, , healthFactor] = await publicClient().readContract({
    address: chain.pool,
    abi: POOL_ABI,
    functionName: 'getUserAccountData',
    args: [user],
  });
  return { collateral, debt, threshold, healthFactor };
};

const usdcBalance = (owner: Address) =>
  publicClient().readContract({
    address: chain.usdc,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [owner],
  });

/** Replaces the feed the Aave oracle reads, the fork's version of vm.mockCall. */
const setWethPrice = async (price: bigint) => {
  await testClient().setCode({ address: wethFeed, bytecode: constantPriceCode(price) });
  const seen = await publicClient().readContract({
    address: AAVE_ORACLE,
    abi: ORACLE_ABI,
    functionName: 'getAssetPrice',
    args: [WETH],
  });
  expect(seen).toBe(price);
};

/** A fresh borrower with WETH collateral and variable USDC debt, on the real Pool. */
const openBorrower = async (): Promise<Address> => {
  await setWethPrice(startPrice);
  const key = generatePrivateKey();
  const wallet = walletFor(key);
  const address = wallet.account.address;
  await testClient().setBalance({ address, value: parseEther('100') });

  await mined(
    await wallet.writeContract({
      chain: null,
      gas: SETUP_GAS,
      address: WETH,
      abi: WETH_ABI,
      functionName: 'deposit',
      value: COLLATERAL,
    }),
  );
  await mined(
    await wallet.writeContract({
      chain: null,
      gas: SETUP_GAS,
      address: WETH,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [chain.pool, COLLATERAL],
    }),
  );
  await mined(
    await wallet.writeContract({
      chain: null,
      gas: SETUP_GAS,
      address: chain.pool,
      abi: POOL_ABI,
      functionName: 'supply',
      args: [WETH, COLLATERAL, address, 0],
    }),
  );

  const { collateral, threshold } = await accountData(address);
  const debtBase = (collateral * threshold * 10n ** 18n) / (10_000n * START_HEALTH_FACTOR);
  await mined(
    await wallet.writeContract({
      chain: null,
      gas: SETUP_GAS,
      address: chain.pool,
      abi: POOL_ABI,
      functionName: 'borrow',
      args: [chain.usdc, debtBase / 100n, 2n, 0, address],
    }),
  );
  return address;
};

/** Takes a 1.50 position to 1.20, below the 1.25 trigger. */
const crash = () => setWethPrice((startPrice * 8n) / 10n);

const contextFor = (borrower: Address, over: Partial<RescueContext> = {}): RescueContext => ({
  network: 'simulated',
  chain,
  position: positionTarget,
  borrower,
  rescuer: mpc.address,
  nearContract: 'simulated-levee.testnet',
  clients,
  near: fakeNear(mpc, { borrower, nearTx: 'SIMULATED-NOT-A-NEAR-HASH' }),
  views: { getPosition: async () => openPosition({ borrower }) },
  ceilings: { maxFeePerGas: parseEther('0.0000001'), maxPriorityFeePerGas: 10n ** 10n },
  evidenceDir,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: () => {},
  receiptTimeoutMs: 30_000,
  receiptPollMs: 200,
  ...over,
});

const recorded = (result: TickResult): RunRecord => {
  if (result.status !== 'recorded') {
    throw new Error(`expected a record, got ${result.status}: ${result.reason}`);
  }
  return result.run;
};

describe('SIMULATED MPC: keeper against a local Aave fork', () => {
  beforeAll(async () => {
    anvil = await startAnvil();
    evidenceDir = await mkdtemp(join(tmpdir(), 'levee-e2e-'));
    // Two URLs for one node. Agreement is real here but trivial, so the test below
    // that wraps a client is what exercises a refusal on this path.
    clients = [anvil.url, `${anvil.url}/`].map((url) =>
      createEvmClient(url, { timeoutMs: FORK_TIMEOUT_MS }),
    );

    // Bring chain time up to the wall clock, or every sample would be stale.
    const test = testClient();
    await test.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(Date.now() / 1000)) });
    await test.mine({ blocks: 1 });

    const client = publicClient();
    wethFeed = await client.readContract({
      address: AAVE_ORACLE,
      abi: ORACLE_ABI,
      functionName: 'getSourceOfAsset',
      args: [WETH],
    });
    startPrice = await client.readContract({
      address: AAVE_ORACLE,
      abi: ORACLE_ABI,
      functionName: 'getAssetPrice',
      args: [WETH],
    });

    // The simulated rescuer gets gas, USDC, and the allowance prepare_allowance would sign.
    await test.setBalance({ address: mpc.address, value: parseEther('10') });
    await test.setBalance({ address: USDC_WHALE, value: parseEther('1') });
    await test.impersonateAccount({ address: USDC_WHALE });
    const whale = createWalletClient({
      account: USDC_WHALE,
      transport: http(anvil.url, { timeout: FORK_TIMEOUT_MS }),
    });
    await mined(
      await whale.writeContract({
        chain: null,
        gas: SETUP_GAS,
        address: chain.usdc,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [mpc.address, RESCUER_FLOAT],
      }),
    );
    await test.stopImpersonatingAccount({ address: USDC_WHALE });
    await mined(
      await walletFor(rescuerKey).writeContract({
        chain: null,
        gas: SETUP_GAS,
        address: chain.usdc,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [chain.pool, RESCUER_FLOAT * 10n],
      }),
    );
  });

  afterAll(async () => {
    anvil?.stop();
    if (evidenceDir) await rm(evidenceDir, { recursive: true, force: true });
  });

  it('leaves a healthy position alone', async () => {
    const borrower = await openBorrower();
    const near = fakeNear(mpc, { borrower });

    const result = await tick(contextFor(borrower, { near }));

    expect(result).toMatchObject({ status: 'idle', reason: 'healthy' });
    expect(near.requests).toEqual([]);
  }, 90_000);

  describe('a crash through the trigger', () => {
    let borrower: Address;
    let aWeth: Address;
    let run: RunRecord;
    let healthAtCrash: bigint;
    let scaledBefore: bigint;
    let rescuerBefore: bigint;

    beforeAll(async () => {
      borrower = await openBorrower();
      aWeth = await publicClient().readContract({
        address: chain.pool,
        abi: POOL_ABI,
        functionName: 'getReserveAToken',
        args: [WETH],
      });
      await crash();
      healthAtCrash = (await accountData(borrower)).healthFactor;
      scaledBefore = await publicClient().readContract({
        address: aWeth,
        abi: SCALED_ABI,
        functionName: 'scaledBalanceOf',
        args: [borrower],
      });
      rescuerBefore = await usdcBalance(mpc.address);
      run = recorded(await tick(contextFor(borrower)));
    }, 120_000);

    it('crosses the trigger before the keeper acts', () => {
      expect(healthAtCrash).toBeLessThan(positionTarget.triggerWad);
      expect(healthAtCrash).toBeGreaterThan(parseWad('1'));
    });

    it('lands the repay and records a simulated success', () => {
      expect(run).toMatchObject({
        network: 'simulated',
        outcome: 'success',
        failure_reason: null,
        borrower,
        rescuer: mpc.address,
      });
      expect(BigInt(run.amount)).toBeGreaterThan(0n);
    });

    it('carries the live position to the target', async () => {
      const { healthFactor } = await accountData(borrower);
      // Interest accrues while the rescue is in flight, so this is a band, not a floor.
      const tolerance = 10n ** 12n;
      expect(healthFactor).toBeGreaterThan(positionTarget.targetWad - tolerance);
      expect(healthFactor).toBeLessThan(positionTarget.targetWad + tolerance);
    });

    it('spends exactly the amount from the rescuer', async () => {
      expect(rescuerBefore - (await usdcBalance(mpc.address))).toBe(BigInt(run.amount));
    });

    it('leaves the collateral untouched', async () => {
      const scaledAfter = await publicClient().readContract({
        address: aWeth,
        abi: SCALED_ABI,
        functionName: 'scaledBalanceOf',
        args: [borrower],
      });
      expect(scaledAfter).toBe(scaledBefore);
    });

    it('sends the transaction the spec describes, from the rescuer', async () => {
      const hash = run.evm_tx as Hex;
      const tx = await publicClient().getTransaction({ hash });
      const receipt = await publicClient().getTransactionReceipt({ hash });

      expect(tx.from.toLowerCase()).toBe(mpc.address.toLowerCase());
      expect(tx.to?.toLowerCase()).toBe(chain.pool.toLowerCase());
      expect(tx.input.slice(0, 10)).toBe(REPAY_SELECTOR);
      expect(tx.type).toBe('eip1559');
      expect(receipt.status).toBe('success');
      expect(BigInt(run.evm_block ?? 0)).toBe(receipt.blockNumber);
    });

    it('uses gas well inside the limit set for it', () => {
      const used = BigInt(run.trace?.receipt?.gas_used ?? 0);
      console.log(`repay gas used on the fork: ${used}`);
      expect(used).toBeGreaterThan(0n);
      expect(used).toBeLessThan(SIMULATED_REPAY_GAS_LIMIT);
    });

    it('writes a record that parses back', async () => {
      const path = join(evidenceDir, 'runs', `${run.run_id}.json`);
      expect(parseRun(await readFile(path, 'utf8'))).toEqual(run);
    });

    it('records timestamps in the order things happened', () => {
      const t = run.timestamps_ms;
      expect(t.detected).toBeTypeOf('number');
      expect(t.broadcast).toBeGreaterThanOrEqual(t.detected ?? 0);
      expect(t.included).toBeGreaterThanOrEqual(t.broadcast ?? 0);
    });

    it('replays with no network', async () => {
      const fetchSpy = vi.fn(() => {
        throw new Error('replay must not use the network');
      });
      vi.stubGlobal('fetch', fetchSpy);
      try {
        const result = await replayRun(run);
        expect(formatReplay(result)).toContain('Replay matches the record.');
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('is never accepted as proof by verify', async () => {
      const verdict = await verifyRun(run, {
        chain: () => {
          throw new Error('a simulated run must not be resolved');
        },
        near: () => {
          throw new Error('a simulated run must not be resolved');
        },
      });
      expect(verdict.verdict).toBe('RECORDED');
    });

    it('goes back to idle once the position is above the trigger', async () => {
      expect(await tick(contextFor(borrower))).toMatchObject({ status: 'idle', reason: 'healthy' });
    });
  });

  it('broadcasts nothing when the signature is from another key', async () => {
    const borrower = await openBorrower();
    await crash();
    const nonceBefore = await publicClient().getTransactionCount({ address: mpc.address });
    const stranger = createSimulatedMpc();

    const run = recorded(
      await tick(contextFor(borrower, { near: fakeNear(stranger, { borrower }) })),
    );

    expect(run.outcome).toBe('aborted');
    expect(run.failure_reason).toMatch(/^signer_mismatch/);
    expect(run.evm_tx).toBeNull();
    expect(await publicClient().getTransactionCount({ address: mpc.address })).toBe(nonceBefore);
    expect((await accountData(borrower)).healthFactor).toBeLessThan(positionTarget.triggerWad);
    expect((await replayRun(run)).ok).toBe(true);
  }, 90_000);

  it('does not call NEAR when an endpoint disagrees', async () => {
    const borrower = await openBorrower();
    await crash();
    const [first, second] = clients as [EvmClient, EvmClient];
    const lying: EvmClient = {
      ...second,
      readSample: async (query) => {
        const sample = await second.readSample(query);
        return { ...sample, healthFactor: (sample.healthFactor * 102n) / 100n };
      },
    };
    const near = fakeNear(mpc, { borrower });

    const run = recorded(await tick(contextFor(borrower, { clients: [first, lying], near })));

    expect(run.outcome).toBe('aborted');
    expect(run.failure_reason).toMatch(/^quorum_disagreement/);
    expect(near.requests).toEqual([]);
  }, 90_000);

  it('records a real revert on the fork, with the hash and block', async () => {
    const borrower = await openBorrower();
    await crash();
    const rescuerBefore = await usdcBalance(mpc.address);
    await mined(
      await walletFor(rescuerKey).writeContract({
        chain: null,
        gas: SETUP_GAS,
        address: chain.usdc,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [chain.pool, 0n],
      }),
    );
    // Both reads claim an allowance the chain does not have, so the repay reverts.
    const stale = clients.map(
      (client): EvmClient => ({
        ...client,
        readSample: async (query) => ({
          ...(await client.readSample(query)),
          rescuerAllowance: RESCUER_FLOAT,
        }),
      }),
    );

    const run = recorded(await tick(contextFor(borrower, { clients: stale })));

    expect(run.outcome).toBe('failed');
    expect(run.failure_reason).toBe('evm_reverted');
    expect(run.evm_tx).not.toBeNull();
    expect(run.evm_block).not.toBeNull();
    expect(await usdcBalance(mpc.address)).toBe(rescuerBefore);
    expect((await replayRun(run)).ok).toBe(true);
  }, 90_000);
});
