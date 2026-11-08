/**
 * Every contract and account the site names, with its explorer link, and the two key deletions.
 * Copied from the README's "Contracts" and "NEAR pieces" sections. contracts.test.ts holds them to
 * the run records and to the claims ledger, so a change there fails a test here.
 *
 * Everything below is on testnet. Nothing is deployed on any mainnet.
 */

const NEARBLOCKS = "https://testnet.nearblocks.io";
const BASESCAN = "https://sepolia.basescan.org";

export const nearAccountUrl = (account: string) => `${NEARBLOCKS}/address/${account}`;
export const nearTxUrl = (hash: string) => `${NEARBLOCKS}/txns/${hash}`;
export const baseAddressUrl = (address: string) => `${BASESCAN}/address/${address}`;

/** The Levee contract that repays from collateral, or from a reserve. */
export const LEVEE_V2 = "levee-core-v2-1503.testnet";
/** The first Levee contract, reserve mode only. Its runs stay on the record. */
export const LEVEE_V1 = "levee-core-1503.testnet";
/** The helper that sells collateral to repay. No owner, no upgrade. */
export const UNWIND = "0x308a7b2872F6006522280026a750fCD1c5Bd63D2";
export const UNWIND_SOURCE = `https://repo.sourcify.dev/84532/${UNWIND}`;

/** Which version each Levee contract is. */
export const VERSIONS: Record<string, string> = { [LEVEE_V2]: "v0.2", [LEVEE_V1]: "v0.1" };

export interface ContractRow {
  name: string;
  network: "NEAR testnet" | "Base Sepolia";
  address: string;
  href: string;
  /** Where its source is, when Levee wrote it. */
  source?: string;
  sourceHref?: string;
}

export const OWN: ContractRow[] = [
  { name: "Levee v0.2, repays from collateral or from a reserve", network: "NEAR testnet", address: LEVEE_V2, href: nearAccountUrl(LEVEE_V2), source: "contracts/levee" },
  { name: "LeveeUnwind, sells collateral to repay. No owner, no upgrade", network: "Base Sepolia", address: UNWIND, href: baseAddressUrl(UNWIND), source: "evm/src/LeveeUnwind.sol, verified on Sourcify", sourceHref: UNWIND_SOURCE },
  { name: "Levee v0.1, reserve mode only", network: "NEAR testnet", address: LEVEE_V1, href: nearAccountUrl(LEVEE_V1), source: "contracts/levee, before collateral mode was added" },
];

export const KEEPER = "levee-keeper-1503.testnet";

export const ACCOUNTS: ContractRow[] = [
  { name: "Keeper. One key limited to rescue_from_collateral on v0.2, one limited to rescue on v0.1", network: "NEAR testnet", address: KEEPER, href: nearAccountUrl(KEEPER) },
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
];

/** Collateral the testnet runs sold, by address in lower case, with its decimals. */
export const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
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

/** The last full-access key on each contract account, deleted. Neither account has a key left. */
export const KEY_DELETIONS: KeyDeletion[] = [
  { account: LEVEE_V1, version: "v0.1", key: "ed25519:AgX6NqakXdaJD4PzFABsTLxnKmEEisozd617LNVi8Ead", tx: "3u8yYEBB9eVJbRGjE27xiHru1aAA4W7Mh4C2rrsZ86fu", href: nearTxUrl("3u8yYEBB9eVJbRGjE27xiHru1aAA4W7Mh4C2rrsZ86fu"), block: 276_764_277 },
  { account: LEVEE_V2, version: "v0.2", key: "ed25519:GRz6zN114TpPrRB5Go6zANhjC2csyW7kuLwUsWJV2ZdE", tx: "C5aHVAahMMa3BjqddSDSf7AK8VCkuFiuqizGj7vbzJJA", href: nearTxUrl("C5aHVAahMMa3BjqddSDSf7AK8VCkuFiuqizGj7vbzJJA"), block: 276_764_289 },
];

/** The NEAR block of the rescue call made after both deletions, as the claims ledger states it. */
export const KEYLESS_RESCUE_NEAR_BLOCK = 276_764_677;
