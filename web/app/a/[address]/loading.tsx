import { ReadState } from "@/components/read-state.tsx";

/** Shown at once on every new address, so no figure from the last one stays on screen. */
export default function Loading() {
  return <ReadState title="Reading this address" body="Aave on Base, Aave on Arbitrum and Hyperliquid, each with a few seconds to answer." busy />;
}
