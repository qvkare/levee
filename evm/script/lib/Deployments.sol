// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// LeveeUnwind's constructor arguments on one chain.
struct UnwindArgs {
    string name;
    address addressesProvider;
    address usdc;
    address uniswapV3Factory;
}

/// Addresses the helper and its scripts depend on. Each was read on chain at the blocks
/// pinned in evm/README.md, and the fork tests check them again.
///
/// Aave PoolAddressesProvider and USDC: bgd-labs/aave-address-book, src/AaveV3Base.sol,
/// AaveV3Arbitrum.sol and AaveV3BaseSepolia.sol at commit d4c2848e. Uniswap v3: the
/// official deployment tables at developers.uniswap.org/docs/protocols/v3/deployments,
/// and for QuoterV2 the feed at developers.uniswap.org/deployments.json, generated on
/// 2026-11-04 from Uniswap/contracts at commit 036160f7.
library Deployments {
    uint256 internal constant BASE = 8453;
    uint256 internal constant ARBITRUM = 42161;
    uint256 internal constant BASE_SEPOLIA = 84532;

    address internal constant BASE_ADDRESSES_PROVIDER = 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D;
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_UNISWAP_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    /// What the keeper quotes `max_sold` from. The helper never calls it.
    address internal constant BASE_QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;

    address internal constant ARBITRUM_ADDRESSES_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    address internal constant ARBITRUM_USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address internal constant ARBITRUM_UNISWAP_V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address internal constant ARBITRUM_QUOTER_V2 = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;

    address internal constant BASE_SEPOLIA_ADDRESSES_PROVIDER = 0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00;
    /// Aave's test USDC, not Circle's.
    address internal constant BASE_SEPOLIA_USDC = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f;
    /// The chain's WETH9 predeploy, which Aave's Base Sepolia market lists as WETH.
    address internal constant BASE_SEPOLIA_WETH = 0x4200000000000000000000000000000000000006;
    address internal constant BASE_SEPOLIA_UNISWAP_V3_FACTORY = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address internal constant BASE_SEPOLIA_QUOTER_V2 = 0xC5290058841028F1614F3A6F0F5816cAd0df5E27;
    address internal constant BASE_SEPOLIA_POSITION_MANAGER = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
    /// `owner()` of the test USDC. Not in the address book.
    address internal constant BASE_SEPOLIA_AAVE_FAUCET = 0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc;

    function unwindArgs(uint256 chainId) internal pure returns (UnwindArgs memory) {
        if (chainId == BASE) {
            return UnwindArgs({
                name: "Base",
                addressesProvider: BASE_ADDRESSES_PROVIDER,
                usdc: BASE_USDC,
                uniswapV3Factory: BASE_UNISWAP_V3_FACTORY
            });
        }
        if (chainId == ARBITRUM) {
            return UnwindArgs({
                name: "Arbitrum One",
                addressesProvider: ARBITRUM_ADDRESSES_PROVIDER,
                usdc: ARBITRUM_USDC,
                uniswapV3Factory: ARBITRUM_UNISWAP_V3_FACTORY
            });
        }
        if (chainId == BASE_SEPOLIA) {
            return UnwindArgs({
                name: "Base Sepolia",
                addressesProvider: BASE_SEPOLIA_ADDRESSES_PROVIDER,
                usdc: BASE_SEPOLIA_USDC,
                uniswapV3Factory: BASE_SEPOLIA_UNISWAP_V3_FACTORY
            });
        }
        revert("LeveeUnwind has no verified addresses for this chain");
    }

    /// Uniswap v3 QuoterV2 on `chainId`, which the keeper quotes `max_sold` from.
    function quoterV2(uint256 chainId) internal pure returns (address) {
        if (chainId == BASE) return BASE_QUOTER_V2;
        if (chainId == ARBITRUM) return ARBITRUM_QUOTER_V2;
        if (chainId == BASE_SEPOLIA) return BASE_SEPOLIA_QUOTER_V2;
        revert("no verified QuoterV2 for this chain");
    }
}
