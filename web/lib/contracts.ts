/**
 * Every contract and account the site names, with its explorer link, and the two key deletions.
 * Copied from the README's "Contracts" and "NEAR pieces" sections. contracts.test.ts holds them to
 * the run records and to the claims ledger, so a change there fails a test here.
 *
 * Everything below is on testnet. Nothing is deployed on any mainnet.
 */

const NEARBLOCKS = "https://testnet.nearblocks.io";
const BASESCAN = "https://sepolia.basescan.org";
const ARBISCAN = "https://sepolia.arbiscan.io";

export const nearAccountUrl = (account: string) => `${NEARBLOCKS}/address/${account}`;
export const nearTxUrl = (hash: string) => `${NEARBLOCKS}/txns/${hash}`;
export const baseAddressUrl = (address: string) => `${BASESCAN}/address/${address}`;
export const arbitrumAddressUrl = (address: string) => `${ARBISCAN}/address/${address}`;

/** The same v0.2 code, deployed again with Base Sepolia and Arbitrum Sepolia in its chain list. */
export const LEVEE_TWO_CHAINS = "levee-v2-multi-1503.testnet";
/** The Levee contract that repays from collateral, or from a reserve. Base Sepolia only. */
export const LEVEE_V2 = "levee-core-v2-1503.testnet";
/** The first Levee contract, reserve mode only. Its runs stay on the record. */
export const LEVEE_V1 = "levee-core-1503.testnet";
/** The helper that sells collateral to repay. No owner, no upgrade. */
export const UNWIND = "0x308a7b2872F6006522280026a750fCD1c5Bd63D2";
export const UNWIND_SOURCE = `https://repo.sourcify.dev/84532/${UNWIND}`;
/** The helper with the Aave v3.0 rounding fix, at the same address on Base Sepolia and Arbitrum Sepolia. */
export const UNWIND_TWO_CHAINS = "0xD9a54F7743B5BbA3fdC77c96b932f50ce67177e8";

/** Which version each Levee contract is. */
export const VERSIONS: Record<string, string> = { [LEVEE_TWO_CHAINS]: "v0.2, two chains", [LEVEE_V2]: "v0.2", [LEVEE_V1]: "v0.1" };

/** The helper each contract's collateral runs called. */
export const HELPERS: Record<string, string> = { [LEVEE_TWO_CHAINS]: UNWIND_TWO_CHAINS, [LEVEE_V2]: UNWIND };

export interface ContractRow {
  name: string;
  network: "NEAR testnet" | "Base Sepolia" | "Arbitrum Sepolia";
  address: string;
  href: string;
  /** Where its source is, when Levee wrote it. */
  source?: string;
  sourceHref?: string;
}

export const OWN: ContractRow[] = [
  { name: "Levee v0.2 on two chains, the same code with Base Sepolia and Arbitrum Sepolia", network: "NEAR testnet", address: LEVEE_TWO_CHAINS, href: nearAccountUrl(LEVEE_TWO_CHAINS), source: "contracts/levee" },
  { name: "LeveeUnwind with the Aave v3.0 fix. No owner, no upgrade", network: "Base Sepolia", address: UNWIND_TWO_CHAINS, href: baseAddressUrl(UNWIND_TWO_CHAINS), source: "evm/src/LeveeUnwind.sol, verified on Sourcify", sourceHref: `https://repo.sourcify.dev/84532/${UNWIND_TWO_CHAINS}` },
  { name: "LeveeUnwind with the Aave v3.0 fix. No owner, no upgrade", network: "Arbitrum Sepolia", address: UNWIND_TWO_CHAINS, href: arbitrumAddressUrl(UNWIND_TWO_CHAINS), source: "evm/src/LeveeUnwind.sol, verified on Sourcify", sourceHref: `https://repo.sourcify.dev/421614/${UNWIND_TWO_CHAINS}` },
  { name: "Levee v0.2, Base Sepolia only, repays from collateral or from a reserve", network: "NEAR testnet", address: LEVEE_V2, href: nearAccountUrl(LEVEE_V2), source: "contracts/levee" },
  { name: "LeveeUnwind, before the Aave v3.0 fix. No owner, no upgrade", network: "Base Sepolia", address: UNWIND, href: baseAddressUrl(UNWIND), source: "evm/src/LeveeUnwind.sol, verified on Sourcify", sourceHref: UNWIND_SOURCE },
  { name: "Levee v0.1, reserve mode only", network: "NEAR testnet", address: LEVEE_V1, href: nearAccountUrl(LEVEE_V1), source: "contracts/levee, before collateral mode was added" },
];

export const KEEPER = "levee-keeper-1503.testnet";

export const ACCOUNTS: ContractRow[] = [
  { name: "Keeper. One key limited to rescue_from_collateral on each v0.2 contract, one limited to rescue on v0.1", network: "NEAR testnet", address: KEEPER, href: nearAccountUrl(KEEPER) },
  { name: "Rescuer for two-chain position 1, derived from the contract by Chain Signatures", network: "Arbitrum Sepolia", address: "0x008418a72481867d027E2b9cA179AC089de69403", href: arbitrumAddressUrl("0x008418a72481867d027E2b9cA179AC089de69403") },
  { name: "Rescuer for two-chain position 2, derived from the contract by Chain Signatures", network: "Base Sepolia", address: "0x6d65fC5Cb4536abae4cD6526856bB10526e80295", href: baseAddressUrl("0x6d65fC5Cb4536abae4cD6526856bB10526e80295") },
  { name: "Rescuer for v0.2 position 1, derived from the contract by Chain Signatures", network: "Base Sepolia", address: "0x95ad19E5382ebEfF2C190ed1711515263efDc462", href: baseAddressUrl("0x95ad19E5382ebEfF2C190ed1711515263efDc462") },
  { name: "Rescuer for v0.1 position 1", network: "Base Sepolia", address: "0xEA3ce7f3AeC39CE95D0fA32F867BA65EFF3b8971", href: baseAddressUrl("0xEA3ce7f3AeC39CE95D0fA32F867BA65EFF3b8971") },
];

export const THIRD_PARTY: ContractRow[] = [
  { name: "Chain Signatures MPC signer", network: "NEAR testnet", address: "v1.signer-prod.testnet", href: nearAccountUrl("v1.signer-prod.testnet") },
  { name: "Aave v3 Pool", network: "Base Sepolia", address: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27", href: baseAddressUrl("0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27") },
  { name: "Aave v3 PoolAddressesProvider", network: "Base Sepolia", address: "0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00", href: baseAddressUrl("0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00") },
  { name: "USDC, Aave's test token", network: "Base Sepolia", address: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", href: baseAddressUrl("0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f") },
  { name: "WETH", network: "Base Sepolia", address: "0x4200000000000000000000000000000000000006", href: baseAddressUrl("0x4200000000000000000000000000000000000006") },
  { name: "Uniswap v3 Factory", network: "Base Sepolia", address: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", href: baseAddressUrl("0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24") },
  { name: "Uniswap v3 QuoterV2", network: "Base Sepolia", address: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27", href: baseAddressUrl("0xC5290058841028F1614F3A6F0F5816cAd0df5E27") },
  {
    name: "Uniswap v3 WETH/USDC 0.30% pool. The team added its liquidity at Aave's oracle price, so its prices are no market measure",
    network: "Base Sepolia",
    address: "0x92266210FacF124f190fbad79AA230dfB85926Ce",
    href: baseAddressUrl("0x92266210FacF124f190fbad79AA230dfB85926Ce"),
  },
  { name: "Aave v3 Pool, revision 3", network: "Arbitrum Sepolia", address: "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff", href: arbitrumAddressUrl("0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff") },
  { name: "Aave v3 PoolAddressesProvider", network: "Arbitrum Sepolia", address: "0xB25a5D144626a0D488e52AE717A051a2E9997076", href: arbitrumAddressUrl("0xB25a5D144626a0D488e52AE717A051a2E9997076") },
  { name: "USDC, Circle's testnet token", network: "Arbitrum Sepolia", address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", href: arbitrumAddressUrl("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d") },
  { name: "WETH, Aave's test wrapper", network: "Arbitrum Sepolia", address: "0x1dF462e2712496373A347f8ad10802a5E95f053D", href: arbitrumAddressUrl("0x1dF462e2712496373A347f8ad10802a5E95f053D") },
  { name: "Uniswap v3 Factory", network: "Arbitrum Sepolia", address: "0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e", href: arbitrumAddressUrl("0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e") },
  { name: "Uniswap v3 QuoterV2", network: "Arbitrum Sepolia", address: "0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B", href: arbitrumAddressUrl("0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B") },
  {
    name: "Uniswap v3 WETH/USDC 0.30% pool. The team added its liquidity at Aave's oracle price, so its prices are no market measure",
    network: "Arbitrum Sepolia",
    address: "0x99A927D8127b7215FC11Ce1F1009e77ff8B1d1b0",
    href: arbitrumAddressUrl("0x99A927D8127b7215FC11Ce1F1009e77ff8B1d1b0"),
  },
];

/** Collateral the testnet runs sold, by address in lower case, with its decimals. */
export const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
  "0x1df462e2712496373a347f8ad10802a5e95f053d": { symbol: "WETH", decimals: 18 },
};

export interface KeyDeletion {
  account: string;
  version: string;
  /** The last full-access key, now deleted. */
  key: string;
  tx: string;
  href: string;
  block: number;
}

/** The last full-access key on each contract account, deleted. No account has a key left. */
export const KEY_DELETIONS: KeyDeletion[] = [
  { account: LEVEE_TWO_CHAINS, version: "v0.2, two chains", key: "ed25519:F5ZXz26BWNVyBK8bDD97thjdESAYv58FarwTzgoieZML", tx: "6SAwnLxi8QTR4UKqCSfpAASkzZzENDrjXudakVJyti62", href: nearTxUrl("6SAwnLxi8QTR4UKqCSfpAASkzZzENDrjXudakVJyti62"), block: 277_265_005 },
  { account: LEVEE_V1, version: "v0.1", key: "ed25519:AgX6NqakXdaJD4PzFABsTLxnKmEEisozd617LNVi8Ead", tx: "3u8yYEBB9eVJbRGjE27xiHru1aAA4W7Mh4C2rrsZ86fu", href: nearTxUrl("3u8yYEBB9eVJbRGjE27xiHru1aAA4W7Mh4C2rrsZ86fu"), block: 276_764_277 },
  { account: LEVEE_V2, version: "v0.2", key: "ed25519:GRz6zN114TpPrRB5Go6zANhjC2csyW7kuLwUsWJV2ZdE", tx: "C5aHVAahMMa3BjqddSDSf7AK8VCkuFiuqizGj7vbzJJA", href: nearTxUrl("C5aHVAahMMa3BjqddSDSf7AK8VCkuFiuqizGj7vbzJJA"), block: 276_764_289 },
];

/**
 * The NEAR block of the rescue the site walks through: the Arbitrum Sepolia rescue made after the
 * two-chain contract lost its last key, as the first keyless claim in the ledger states it.
 */
export const KEYLESS_RESCUE_NEAR_BLOCK = 277_265_219;
