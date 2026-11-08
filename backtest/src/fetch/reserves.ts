// Step 2a: reserve metadata and the Chainlink aggregators behind AaveOracle, read at
// both ends of every window so that a feed migration inside a window is caught.
import { join } from 'node:path';
import type { Abi } from 'viem';
import { CHAINS, type ChainKey } from '../config.ts';
import { DERIVED_DIR, writeJson } from '../paths.ts';
import { Rpc, sleep } from '../rpc.ts';
import { DATA_PROVIDER_ABI, ERC20_ABI, FEED_ABI, ORACLE_ABI, POOL_ABI, PROVIDER_ABI } from './abis.ts';
import { resolveBlocks } from './blocks.ts';
import { multicall, type Call } from './multicall.ts';

export interface Reserve {
  asset: string;
  symbol: string;
  decimals: number;
  aToken: string;
  variableDebtToken: string;
  /** Basis points. */
  liquidationThreshold: number;
  /** Basis points, for example 10500 for a 5% bonus. */
  liquidationBonus: number;
  /** Share of the bonus kept by the protocol, basis points. */
  protocolFee: number;
  source: string;
  feedDescription: string | null;
  /** Reserve id in the pool, which indexes the eMode collateral bitmap. */
  id: number;
  /** Aggregators whose updates move this reserve's price. Empty for a fixed price. */
  feeds: string[];
}

export interface EModeCategory {
  id: number;
  liquidationThreshold: number;
  liquidationBonus: number;
  /** Bitmap over reserve ids, as a decimal string. */
  collateralBitmap: string;
}

export interface MarketSnapshot {
  chain: ChainKey;
  window: string;
  block: number;
  provider: string;
  oracle: string;
  dataProvider: string;
  reserves: Reserve[];
  /** Chainlink contracts that emit AnswerUpdated for these reserves. */
  aggregators: string[];
  /** Pool-wide eMode categories, read for ids 1 to 32. Empty ids are left out. */
  emodes: EModeCategory[];
}

export const MARKETS_FILE = join(DERIVED_DIR, 'markets.json');

const one = (target: string, abi: Abi, functionName: string, args?: readonly unknown[]): Call =>
  args ? { target, abi, functionName, args } : { target, abi, functionName };

export async function snapshot(rpc: Rpc, chain: ChainKey, window: string, block: number): Promise<MarketSnapshot> {
  const { pool } = CHAINS[chain];
  const [provider] = (await multicall(rpc, block, [one(pool, POOL_ABI, 'ADDRESSES_PROVIDER')])) as [string];
  const [oracle, dataProvider, assets] = (await multicall(rpc, block, [
    one(provider, PROVIDER_ABI, 'getPriceOracle'),
    one(provider, PROVIDER_ABI, 'getPoolDataProvider'),
    one(pool, POOL_ABI, 'getReservesList'),
  ])) as [string, string, readonly string[]];

  const reserves: Reserve[] = [];
  const aggregators = new Set<string>();
  const resolved = new Map<string, string>();
  const toAggregator = async (feed: string): Promise<string> => {
    const cached = resolved.get(feed);
    if (cached) return cached;
    const [aggregator] = (await multicall(rpc, block, [one(feed, FEED_ABI, 'aggregator')])) as [string | null];
    // A capped adapter can point straight at an aggregator, which has no aggregator().
    const address = (aggregator ?? feed).toLowerCase();
    resolved.set(feed, address);
    return address;
  };
  for (const asset of assets) {
    const [symbol, config, fee, tokens, source, reserveData] = (await multicall(rpc, block, [
      one(asset, ERC20_ABI, 'symbol'),
      one(dataProvider, DATA_PROVIDER_ABI, 'getReserveConfigurationData', [asset]),
      one(dataProvider, DATA_PROVIDER_ABI, 'getLiquidationProtocolFee', [asset]),
      one(dataProvider, DATA_PROVIDER_ABI, 'getReserveTokensAddresses', [asset]),
      one(oracle, ORACLE_ABI, 'getSourceOfAsset', [asset]),
      one(pool, POOL_ABI, 'getReserveData', [asset]),
    ])) as [string, readonly bigint[], bigint | null, readonly string[], string, readonly unknown[]];
    const [description, aggregator, base, assetFeed] = (await multicall(rpc, block, [
      one(source, FEED_ABI, 'description'),
      one(source, FEED_ABI, 'aggregator'),
      one(source, FEED_ABI, 'BASE_TO_USD_AGGREGATOR'),
      one(source, FEED_ABI, 'ASSET_TO_USD_AGGREGATOR'),
    ])) as [string | null, string | null, string | null, string | null];
    const feeds = new Set<string>();
    if (aggregator) feeds.add(aggregator.toLowerCase());
    if (base) feeds.add(await toAggregator(base));
    if (assetFeed) feeds.add(await toAggregator(assetFeed));
    for (const feed of feeds) aggregators.add(feed);
    reserves.push({
      asset: asset.toLowerCase(),
      symbol,
      decimals: Number(config[0]),
      aToken: tokens[0]!.toLowerCase(),
      variableDebtToken: tokens[2]!.toLowerCase(),
      liquidationThreshold: Number(config[2]),
      liquidationBonus: Number(config[3]),
      protocolFee: fee === null ? 0 : Number(fee),
      source: source.toLowerCase(),
      feedDescription: description,
      id: Number(reserveData[7]),
      feeds: [...feeds],
    });
    await sleep(120);
  }

  const ids = Array.from({ length: 32 }, (_, i) => i + 1);
  const emodeRows = (await multicall(
    rpc,
    block,
    ids.flatMap((id) => [one(pool, POOL_ABI, 'getEModeCategoryCollateralConfig', [id]), one(pool, POOL_ABI, 'getEModeCategoryCollateralBitmap', [id])]),
  )) as Array<readonly number[] | { ltv: number; liquidationThreshold: number; liquidationBonus: number } | bigint | null>;
  const emodes: EModeCategory[] = [];
  ids.forEach((id, i) => {
    const config = emodeRows[i * 2] as readonly number[] | null;
    const bitmap = emodeRows[i * 2 + 1] as bigint | null;
    if (config && Number(config[1]) > 0) {
      emodes.push({ id, liquidationThreshold: Number(config[1]), liquidationBonus: Number(config[2]), collateralBitmap: String(bitmap ?? 0n) });
    }
  });
  return {
    chain,
    window,
    block,
    provider: provider.toLowerCase(),
    oracle: oracle.toLowerCase(),
    dataProvider: dataProvider.toLowerCase(),
    reserves,
    aggregators: [...aggregators].sort(),
    emodes,
  };
}

export async function fetchMarkets(): Promise<MarketSnapshot[]> {
  const ranges = await resolveBlocks();
  const snapshots: MarketSnapshot[] = [];
  for (const range of ranges) {
    const rpc = new Rpc(CHAINS[range.chain].archiveRpcs);
    for (const block of [range.fromBlock, range.toBlock]) {
      const snap = await snapshot(rpc, range.chain, range.window, block);
      console.log(`${range.chain} ${range.window} @${block}: ${snap.reserves.length} reserves, ${snap.aggregators.length} aggregators`);
      snapshots.push(snap);
    }
  }
  writeJson(MARKETS_FILE, snapshots);
  return snapshots;
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchMarkets();
