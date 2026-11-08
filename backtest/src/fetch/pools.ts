// Which Uniswap v3 pools against native USDC are usable, read once at each period's first block.
// For every reserve with a threshold above zero other than native USDC and every fee tier: the
// pool, its native USDC balance, and a quote for 1,000 USDC out against AaveOracle.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAbi } from 'viem';
import { CHAINS, type ChainKey } from '../config.ts';
import { FEE_TIERS, PROBE_MAX_BPS, PROBE_USDC, UNISWAP } from '../collateral/config.ts';
import { COLLATERAL_DIR, POOLS_FILE, type AssetPools, type PeriodPools } from '../collateral/pools.ts';
import { DERIVED_DIR, readJson, writeJson } from '../paths.ts';
import { Rpc } from '../rpc.ts';
import { ERC20_ABI, ORACLE_ABI } from './abis.ts';
import { allRanges } from './borrowers.ts';
import { multicall, type Call } from './multicall.ts';
import type { MarketSnapshot } from './reserves.ts';

export const FACTORY_ABI = parseAbi(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)']);
export const QUOTER_ABI = parseAbi([
  'struct QuoteExactOutputSingleParams { address tokenIn; address tokenOut; uint256 amount; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactOutputSingle(QuoteExactOutputSingleParams params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
export const POOL_STATE_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
]);

/**
 * Free keyless endpoints for archive `eth_call`, measured on 2026-11-08. `base.merkle.io`, listed
 * for the headline reads, now answers "pruned history unavailable" below block 51,000,000. Sentio
 * caps `eth_call` at 10M gas, too little for a batch of quotes. Tenderly's second public hostname
 * and Blast's public Base endpoint also serve archive state and are added.
 */
export const QUOTE_RPCS: Record<ChainKey, string[]> = {
  base: [...CHAINS.base.archiveRpcs.filter((url) => !url.includes('merkle') && !url.includes('sentio')), 'https://gateway.tenderly.co/public/base', 'https://base-mainnet.public.blastapi.io'],
  arbitrum: [...CHAINS.arbitrum.archiveRpcs.filter((url) => !url.includes('sentio')), 'https://gateway.tenderly.co/public/arbitrum'],
};

const ZERO = /^0x0{40}$/i;

export function quoteCall(chain: ChainKey, asset: string, fee: number, usdcOut: bigint): Call {
  return {
    target: UNISWAP[chain].quoter,
    abi: QUOTER_ABI,
    functionName: 'quoteExactOutputSingle',
    args: [{ tokenIn: asset as `0x${string}`, tokenOut: CHAINS[chain].usdc, amount: usdcOut, fee, sqrtPriceLimitX96: 0n }],
  };
}

async function probe(rpc: Rpc, chain: ChainKey, period: string, block: number, market: MarketSnapshot): Promise<PeriodPools> {
  const usdc = CHAINS[chain].usdc.toLowerCase();
  const candidates = market.reserves.map((r, index) => ({ r, index })).filter(({ r }) => r.liquidationThreshold > 0 && r.asset !== usdc);
  const getPools: Call[] = candidates.flatMap(({ r }) => FEE_TIERS.map((fee) => ({ target: UNISWAP[chain].factory, abi: FACTORY_ABI, functionName: 'getPool', args: [r.asset, usdc, fee] })));
  const pools = (await multicall(rpc, block, getPools)) as Array<string | null>;
  const prices = (await multicall(
    rpc,
    block,
    [usdc, ...candidates.map(({ r }) => r.asset)].map((asset) => ({ target: market.oracle, abi: ORACLE_ABI, functionName: 'getAssetPrice', args: [asset] })),
  )) as Array<bigint | null>;
  const usdcPrice = Number(prices[0]);
  const out: PeriodPools = { chain, period, block, usdcPrice, assets: [] };
  let k = 0;
  for (const [i, { r, index }] of candidates.entries()) {
    const assetPrice = Number(prices[i + 1]);
    const entry: AssetPools = { asset: index, address: r.asset, symbol: r.symbol, decimals: r.decimals, tiers: [], configuredFee: null };
    for (const fee of FEE_TIERS) {
      const pool = pools[k++];
      if (!pool || ZERO.test(pool)) continue;
      const [balance, quote] = (await multicall(rpc, block, [
        { target: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [pool] },
        quoteCall(chain, r.asset, fee, BigInt(PROBE_USDC) * 10n ** 6n),
      ])) as [bigint | null, readonly [bigint, bigint, number, bigint] | null];
      let probeCostBps: number | null = null;
      if (quote) {
        const paid = Number(quote[0]) / 10 ** r.decimals;
        const atOracle = (PROBE_USDC * usdcPrice) / assetPrice;
        probeCostBps = (paid / atOracle - 1) * 1e4;
      }
      entry.tiers.push({
        fee,
        pool: pool.toLowerCase(),
        usdcBalance: Number(balance ?? 0n) / 1e6,
        probeCostBps,
        usable: probeCostBps !== null && probeCostBps <= PROBE_MAX_BPS,
      });
    }
    const usable = entry.tiers.filter((t) => t.usable).sort((a, b) => b.usdcBalance - a.usdcBalance || a.fee - b.fee);
    entry.configuredFee = usable[0]?.fee ?? null;
    out.assets.push(entry);
  }
  return out;
}

export async function fetchPools(): Promise<void> {
  mkdirSync(COLLATERAL_DIR, { recursive: true });
  const markets = [...readJson<MarketSnapshot[]>(join(DERIVED_DIR, 'markets.json')), ...readJson<MarketSnapshot[]>(join(DERIVED_DIR, 'portfolio', 'markets-calm.json'))];
  const out: PeriodPools[] = [];
  for (const range of allRanges()) {
    const market = markets.find((m) => m.chain === range.chain && m.window === range.window && m.block === range.fromBlock);
    if (!market) throw new Error(`no market snapshot at ${range.chain} ${range.window} ${range.fromBlock}`);
    const rpc = new Rpc(QUOTE_RPCS[range.chain]);
    const pools = await probe(rpc, range.chain, range.window, range.fromBlock, market);
    const usable = pools.assets.filter((a) => a.configuredFee !== null).map((a) => `${a.symbol} ${a.tiers.filter((t) => t.usable).map((t) => t.fee).join('/')}`);
    console.log(`pools ${range.chain} ${range.window} at ${range.fromBlock}: ${usable.join(', ')}`);
    out.push(pools);
  }
  writeJson(POOLS_FILE, out);
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchPools();
