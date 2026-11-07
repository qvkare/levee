/**
 * Public addresses taken from Aave Borrow logs and the Hyperliquid leaderboard on 2026-11-07. They
 * show what the tool reads. Levee has no relationship with their owners. Labels say what kind of
 * position each is and nothing more.
 */
export const EXAMPLES = [
  { label: "A borrower on Aave and Hyperliquid", address: "0x972b0F9cDE1266e860E546ac92E783741769400F" },
  { label: "A borrower on Base and Arbitrum", address: "0xe5EC006540bE4F7CbB2CBc7Be79708a6d96F90dC" },
  { label: "A wstETH loop against WETH debt", address: "0xC4C00d8b323f37527eEda27c87412378be9F68Ec" },
  { label: "A unified Hyperliquid account with isolated positions", address: "0x585f4fBe2d2A889c286fa71FB81D01f30773F4B1" },
] as const;

/** The home page reads these, in order. Each has more than one position, so the wall has an order to show. */
export const HOME_ADDRESSES = [EXAMPLES[0].address, EXAMPLES[1].address];
