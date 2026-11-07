// A position is one user on one chain in one window. Its race is against the first
// LiquidationCall it took in that window.
import type { ChainKey } from '../config.ts';
import { readJson } from '../paths.ts';
import { LIQUIDATIONS_FILE, type Liquidation } from './liquidations.ts';

export interface PositionKey {
  chain: ChainKey;
  window: string;
  user: string;
  firstBlock: number;
  events: Liquidation[];
}

export function loadPositions(): PositionKey[] {
  const events = readJson<Liquidation[]>(LIQUIDATIONS_FILE);
  const positions = new Map<string, PositionKey>();
  for (const event of events) {
    const key = `${event.chain}:${event.window}:${event.user}`;
    const known = positions.get(key);
    if (known) {
      known.events.push(event);
      known.firstBlock = Math.min(known.firstBlock, event.block);
    } else {
      positions.set(key, { chain: event.chain, window: event.window, user: event.user, firstBlock: event.block, events: [event] });
    }
  }
  return [...positions.values()];
}
