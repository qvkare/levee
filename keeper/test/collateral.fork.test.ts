/**
 * Collateral mode's new reads against a local anvil fork of Base at the block the
 * Foundry tests pin: the QuoterV2 quote `max_sold` is set from, and the LTV-0 rule that
 * Aave applies to an aToken transfer. Real Pool, real QuoterV2, real state. Mainnet is
 * only read, to build the fork.
 */
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAINS } from '../src/chains.js';
import { createEvmClient, readLtvZeroBlocker } from '../src/evm.js';
import { type Anvil, startAnvil } from './support/anvil.js';

const base = CHAINS[8453] as NonNullable<(typeof CHAINS)[8453]>;
const WETH: Address = '0x4200000000000000000000000000000000000006';
const CBBTC: Address = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';

const FORK_TIMEOUT_MS = 60_000;
const SETUP_GAS = 1_000_000n;
/** Aave v3.7's freeze also moves the reserve's LTV aside, and needs more than a million. */
const FREEZE_GAS = 5_000_000n;

const POOL_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function getReserveAToken(address asset) view returns (address)',
  'function getConfiguration(address asset) view returns ((uint256 data))',
  'function ADDRESSES_PROVIDER() view returns (address)',
]);
const PROVIDER_ABI = parseAbi([
  'function getACLManager() view returns (address)',
  'function getACLAdmin() view returns (address)',
  'function getPoolConfigurator() view returns (address)',
]);
const ACL_ABI = parseAbi(['function addPoolAdmin(address admin)']);
const CONFIGURATOR_ABI = parseAbi(['function setReserveFreeze(address asset, bool freeze)']);
const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const WETH_ABI = parseAbi(['function deposit() payable']);

let anvil: Anvil;

const publicClient = () =>
  createPublicClient({ transport: http(anvil.url, { timeout: FORK_TIMEOUT_MS }) });
const testClient = () =>
  createTestClient({ mode: 'anvil', transport: http(anvil.url, { timeout: FORK_TIMEOUT_MS }) });
const walletAs = (account: Address | Hex) =>
  createWalletClient({
    account: account.length === 42 ? (account as Address) : privateKeyToAccount(account as Hex),
    transport: http(anvil.url, { timeout: FORK_TIMEOUT_MS }),
  });
type Wallet = ReturnType<typeof walletAs>;

const mined = async (hash: Hex) => {
  const client = publicClient();
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: FORK_TIMEOUT_MS });
  if (receipt.status === 'success') return;
  const tx = await client.getTransaction({ hash });
  const reason = await client
    .call({ account: tx.from, to: tx.to, data: tx.input, blockNumber: receipt.blockNumber - 1n })
    .then(
      () => 'succeeds when replayed',
      (error: { shortMessage?: string; details?: string }) =>
        `${error.shortMessage ?? 'reverted'} ${error.details ?? ''}`,
    );
  throw new Error(`setup transaction from ${tx.from} to ${tx.to} reverted: ${reason}`);
};

/** Sends one call from `wallet` and waits for it to succeed. */
const send = async (
  wallet: Wallet,
  call: { address: Address; abi: readonly unknown[]; functionName: string; args?: unknown[]; value?: bigint },
  gas = SETUP_GAS,
) => mined(await wallet.writeContract({ ...call, chain: null, gas } as never));

/** Sends as `address` on the fork, with gas money. */
const asImpersonated = async (address: Address, run: (wallet: Wallet) => Promise<void>) => {
  const test = testClient();
  await test.setBalance({ address, value: parseEther('1') });
  await test.impersonateAccount({ address });
  try {
    await run(walletAs(address));
  } finally {
    await test.stopImpersonatingAccount({ address });
  }
};

const blocker = async (borrower: Address, asset: Address) => {
  const client = publicClient();
  const block = await client.getBlockNumber();
  return readLtvZeroBlocker(client, base.pool, borrower, asset, block);
};

/** Freezes `asset` as Aave governance would, through the ACL admin. */
const freeze = async (asset: Address) => {
  const client = publicClient();
  const provider = await client.readContract({
    address: base.pool,
    abi: POOL_ABI,
    functionName: 'ADDRESSES_PROVIDER',
  });
  const read = (functionName: 'getACLManager' | 'getACLAdmin' | 'getPoolConfigurator') =>
    client.readContract({ address: provider, abi: PROVIDER_ABI, functionName });
  const [acl, aclAdmin, configurator] = await Promise.all([
    read('getACLManager'),
    read('getACLAdmin'),
    read('getPoolConfigurator'),
  ]);
  await asImpersonated(aclAdmin, async (admin) => {
    await send(admin, { address: acl, abi: ACL_ABI, functionName: 'addPoolAdmin', args: [aclAdmin] });
    await send(
      admin,
      { address: configurator, abi: CONFIGURATOR_ABI, functionName: 'setReserveFreeze', args: [asset, true] },
      FREEZE_GAS,
    );
  });
};

const ltvOf = async (asset: Address) => {
  const config = await publicClient().readContract({
    address: base.pool,
    abi: POOL_ABI,
    functionName: 'getConfiguration',
    args: [asset],
  });
  return config.data & 0xffffn;
};

/** A borrower with 1 WETH and 0.01 cbBTC supplied, both enabled as collateral. */
const openTwoCollateralBorrower = async (): Promise<Address> => {
  const wallet = walletAs(generatePrivateKey());
  const borrower = wallet.account.address;
  await testClient().setBalance({ address: borrower, value: parseEther('10') });
  const supply = async (asset: Address, amount: bigint) => {
    await send(wallet, { address: asset, abi: ERC20_ABI, functionName: 'approve', args: [base.pool, amount] });
    await send(wallet, {
      address: base.pool,
      abi: POOL_ABI,
      functionName: 'supply',
      args: [asset, amount, borrower, 0],
    });
  };

  await send(wallet, { address: WETH, abi: WETH_ABI, functionName: 'deposit', value: parseEther('1') });
  await supply(WETH, parseEther('1'));

  // The cbBTC aToken holds the reserve's cbBTC, which makes it a convenient faucet.
  const aCbBtc = await publicClient().readContract({
    address: base.pool,
    abi: POOL_ABI,
    functionName: 'getReserveAToken',
    args: [CBBTC],
  });
  await asImpersonated(aCbBtc, (whale) =>
    send(whale, { address: CBBTC, abi: ERC20_ABI, functionName: 'transfer', args: [borrower, 1_000_000n] }),
  );
  await supply(CBBTC, 1_000_000n);
  return borrower;
};

describe('collateral mode reads against a local Aave fork', () => {
  beforeAll(async () => {
    anvil = await startAnvil();
  });

  afterAll(() => anvil?.stop());

  /** cast call at block 54,260,000 gave the same answer from mainnet.base.org. */
  it('quotes a sale from QuoterV2 as cast does', async () => {
    const quote = await createEvmClient(anvil.url, { timeoutMs: FORK_TIMEOUT_MS }).quoteExactOutput(
      base.quoterV2 as Address,
      { tokenIn: WETH, tokenOut: base.usdc, amount: 10_000_000_000n, fee: 500n },
    );
    expect(quote).toBe(4_453_320_615_222_339_456n);
  }, 90_000);

  it('finds another enabled collateral at LTV 0, and only when it blocks', async () => {
    const borrower = await openTwoCollateralBorrower();
    expect(await blocker(borrower, WETH)).toBeNull();

    // From Aave v3.6 a freeze sets the reserve's LTV to 0.
    await freeze(CBBTC);
    expect(await ltvOf(CBBTC)).toBe(0n);

    expect(await blocker(borrower, WETH)).toBe(CBBTC);
    // The LTV-0 asset itself may leave first.
    expect(await blocker(borrower, CBBTC)).toBeNull();

    // With WETH at LTV 0 too, Aave lets WETH leave, so nothing blocks it.
    await freeze(WETH);
    expect(await blocker(borrower, WETH)).toBeNull();
  }, 180_000);
});
