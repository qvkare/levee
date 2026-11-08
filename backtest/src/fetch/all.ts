// `pnpm fetch-data`: every network step, in order, then `derive`. Each stage caches what it reads
// in data/raw and skips it on the next run, so a killed run resumes.
import { derive } from '../derive.ts';
import { derivePortfolio } from '../portfolio/derive.ts';
import { fetchActions } from './actions.ts';
import { fetchBorrowers } from './borrowers.ts';
import { fetchCalmPrices } from './calmPrices.ts';
import { validateQuotes } from './collateralCheck.ts';
import { crossCheck } from './crosscheck.ts';
import { fetchDaily } from './daily.ts';
import { fetchHyperliquid } from './hyperliquid.ts';
import { fetchIndexes } from './indexes.ts';
import { fetchLiquidations } from './liquidations.ts';
import { fetchMembers } from './members.ts';
import { fetchOracleUpdates } from './oracle.ts';
import { fetchPaths } from './paths.ts';
import { fetchPools } from './pools.ts';
import { fetchPortfolios } from './portfolios.ts';
import { fetchPrices } from './prices.ts';
import { fetchQuotes } from './quotes.ts';
import { fetchMarkets } from './reserves.ts';
import { fetchSample } from './sample.ts';
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

// The population, shared-reserve, calm-period and carry parts. They read the headline set
// written by `derive` above.
await fetchDaily();
await fetchBorrowers();
await fetchMembers();
await fetchCalmPrices();
await fetchActions();
await fetchIndexes();
await fetchPortfolios();
await derivePortfolio();
await fetchSample();

// Repay from collateral. It reads the population files written above.
await fetchPools();
await fetchQuotes();
await validateQuotes();
