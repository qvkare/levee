// `pnpm fetch-data`: every network step, in order, then `derive`. Each stage caches what it reads
// in data/raw and skips it on the next run, so a killed run resumes.
import { derive } from '../derive.ts';
import { crossCheck } from './crosscheck.ts';
import { fetchHyperliquid } from './hyperliquid.ts';
import { fetchLiquidations } from './liquidations.ts';
import { fetchOracleUpdates } from './oracle.ts';
import { fetchPaths } from './paths.ts';
import { fetchPrices } from './prices.ts';
import { fetchMarkets } from './reserves.ts';
import { fetchSnapshots } from './snapshots.ts';
import { fetchTimes } from './times.ts';

await fetchLiquidations();
await fetchMarkets();
await fetchOracleUpdates();
await fetchTimes();
await fetchSnapshots();
await fetchPrices();
await fetchPaths();
await crossCheck();
await fetchHyperliquid();
await derive();
