/** Every outside link the site prints, in one place. Contract data is in contracts.ts. */
import { LEVEE_TWO_CHAINS, UNWIND_TWO_CHAINS, arbitrumAddressUrl, baseAddressUrl, nearAccountUrl } from "./contracts.ts";

/** The Levee contract on NEAR testnet that rescues on Base Sepolia and Arbitrum Sepolia. */
export const CONTRACT_ID = LEVEE_TWO_CHAINS;

export const CONTRACT_URL = nearAccountUrl(CONTRACT_ID);

/** LeveeUnwind, the helper, at the same address on both chains. */
export const UNWIND_URL = baseAddressUrl(UNWIND_TWO_CHAINS);
export const UNWIND_ARBITRUM_URL = arbitrumAddressUrl(UNWIND_TWO_CHAINS);

/** The source repository, linked from the footer and the /proof cards. */
export const GITHUB_URL: string = "https://github.com/qvkare/levee";
