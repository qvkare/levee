// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AaveReserveData, IAaveAddressesProvider, IAavePool, IAavePriceOracle} from "../src/interfaces/IAaveV3.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "../src/interfaces/IUniswapV3.sol";
import {Deployments} from "./lib/Deployments.sol";
import {IAaveFaucet, INonfungiblePositionManager, IWETH9, PoolPriceMover, TestnetPoolMath} from "./lib/TestnetPool.sol";

/// Puts a Uniswap v3 pool for Aave's Base Sepolia WETH and test USDC at Aave's oracle
/// price and adds liquidity around it, so LeveeUnwind can be run live on testnet.
///
/// Every fee tier for this pair already exists on Base Sepolia, left by others at
/// arbitrary prices, so "create" usually means "move": the script swaps the pool to the
/// oracle price with PoolPriceMover, then mints a position with the official
/// NonfungiblePositionManager. The oracle tracks the real ETH price and nobody
/// arbitrages this pool, so run it again shortly before each live unwind.
///
/// It funds itself if it can: test USDC from Aave's faucet, WETH by wrapping the
/// deployer's Base Sepolia ETH.
contract SeedTestnetPool is Script {
    struct Params {
        uint24 fee;
        uint256 wethAmount;
        /// Zero means the oracle value of `wethAmount`.
        uint256 usdcAmount;
        /// Half-width of the position around the oracle price, in ticks.
        int24 rangeTicks;
        /// Kept in the deployer's wallet for gas when wrapping ETH.
        uint256 gasReserveWei;
        /// An earlier PoolPriceMover to reuse. Zero deploys one if the price must move.
        address mover;
    }

    struct Result {
        address pool;
        address mover;
        uint160 targetSqrtPriceX96;
        uint160 sqrtPriceX96;
        int24 tick;
        int24 tickLower;
        int24 tickUpper;
        uint256 tokenId;
        uint128 liquidity;
        uint256 wethAdded;
        uint256 usdcAdded;
    }

    /// Test USDC minted on top of the liquidity, to pay for moving the price up.
    uint256 internal constant RECENTER_USDC_BUDGET = 10_000e6;

    /// How long the mint stays valid after the block the script ran on. `forge script`
    /// simulates and sends each transaction on later blocks, so a deadline of that block's
    /// own timestamp has passed by then and the position manager refuses the mint with
    /// "Transaction too old". The minimum amounts are zero, so the deadline guards nothing
    /// the script relies on.
    uint256 public constant MINT_DEADLINE = 30 minutes;

    address internal constant WETH = Deployments.BASE_SEPOLIA_WETH;
    address internal constant USDC = Deployments.BASE_SEPOLIA_USDC;

    function run() external returns (Result memory r) {
        Params memory p = Params({
            fee: SafeCast.toUint24(vm.envOr("SEED_POOL_FEE", uint256(3000))),
            wethAmount: vm.envOr("SEED_WETH_WEI", uint256(0.2 ether)),
            usdcAmount: vm.envOr("SEED_USDC_UNITS", uint256(0)),
            rangeTicks: SafeCast.toInt24(SafeCast.toInt256(vm.envOr("SEED_RANGE_TICKS", uint256(600)))),
            gasReserveWei: vm.envOr("SEED_GAS_RESERVE_WEI", uint256(0.005 ether)),
            mover: vm.envOr("PRICE_MOVER", address(0))
        });

        // The key is read here and handed to Foundry, never printed.
        uint256 key = vm.envUint("TEST_EOA_PRIVATE_KEY");
        address deployer = vm.addr(key);
        vm.startBroadcast(key);
        r = _seed(deployer, p);
        vm.stopBroadcast();
        _log(deployer, r);
    }

    /// The same steps from an address without a key, for the fork test that rehearses this
    /// script.
    function seedFrom(address deployer, Params memory p) external returns (Result memory r) {
        vm.startBroadcast(deployer);
        r = _seed(deployer, p);
        vm.stopBroadcast();
    }

    function _seed(address deployer, Params memory p) internal returns (Result memory r) {
        require(block.chainid == Deployments.BASE_SEPOLIA, "SeedTestnetPool runs on Base Sepolia only");
        require(p.rangeTicks > 0, "SEED_RANGE_TICKS must be above zero");

        IUniswapV3Factory factory = IUniswapV3Factory(Deployments.BASE_SEPOLIA_UNISWAP_V3_FACTORY);
        INonfungiblePositionManager manager = INonfungiblePositionManager(Deployments.BASE_SEPOLIA_POSITION_MANAGER);
        require(manager.factory() == address(factory), "position manager is on another factory");
        require(factory.feeAmountTickSpacing(p.fee) != 0, "fee tier is not enabled");

        (address token0, address token1) = WETH < USDC ? (WETH, USDC) : (USDC, WETH);
        r.targetSqrtPriceX96 = _oracleSqrtPrice(token0, token1);
        if (p.usdcAmount == 0) p.usdcAmount = _oracleValueInUsdc(p.wethAmount);

        _fund(deployer, p);

        r.pool = factory.getPool(token0, token1, p.fee);
        if (r.pool == address(0) || _sqrtPrice(r.pool) == 0) {
            r.pool = manager.createAndInitializePoolIfNecessary(token0, token1, p.fee, r.targetSqrtPriceX96);
        } else {
            r.mover = _recenter(deployer, factory, r.pool, token0, token1, p, r.targetSqrtPriceX96);
        }

        (r.sqrtPriceX96, r.tick,,,,,) = IUniswapV3Pool(r.pool).slot0();
        require(r.sqrtPriceX96 == r.targetSqrtPriceX96, "pool is not at the oracle price");

        int24 spacing = IUniswapV3Pool(r.pool).tickSpacing();
        r.tickLower = TestnetPoolMath.floorToSpacing(r.tick - p.rangeTicks, spacing);
        r.tickUpper = TestnetPoolMath.floorToSpacing(r.tick + p.rangeTicks, spacing) + spacing;

        uint256 wethIn = Math.min(p.wethAmount, IERC20(WETH).balanceOf(deployer));
        uint256 usdcIn = Math.min(p.usdcAmount, IERC20(USDC).balanceOf(deployer));
        IERC20(WETH).approve(address(manager), wethIn);
        IERC20(USDC).approve(address(manager), usdcIn);
        uint256 amount0;
        uint256 amount1;
        (r.tokenId, r.liquidity, amount0, amount1) = manager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: p.fee,
                tickLower: r.tickLower,
                tickUpper: r.tickUpper,
                amount0Desired: token0 == WETH ? wethIn : usdcIn,
                amount1Desired: token0 == WETH ? usdcIn : wethIn,
                amount0Min: 0,
                amount1Min: 0,
                recipient: deployer,
                deadline: block.timestamp + MINT_DEADLINE
            })
        );
        IERC20(WETH).approve(address(manager), 0);
        IERC20(USDC).approve(address(manager), 0);
        (r.wethAdded, r.usdcAdded) = token0 == WETH ? (amount0, amount1) : (amount1, amount0);
    }

    function _fund(address deployer, Params memory p) internal {
        uint256 usdcWanted = p.usdcAmount + RECENTER_USDC_BUDGET;
        uint256 usdcHeld = IERC20(USDC).balanceOf(deployer);
        if (usdcHeld < usdcWanted) {
            IAaveFaucet faucet = IAaveFaucet(Deployments.BASE_SEPOLIA_AAVE_FAUCET);
            (uint256 timelock, uint256 maxMintWhole) = faucet.getTokenConfig(USDC);
            uint256 lastMint = faucet.getUserLastUpdated(USDC, deployer);
            if (lastMint == 0 || block.timestamp >= lastMint + timelock) {
                uint256 shortfall = usdcWanted - usdcHeld;
                require(shortfall <= maxMintWhole * 1e6, "SEED_USDC_UNITS is above the faucet's per-call limit");
                faucet.mint(USDC, deployer, shortfall);
            } else {
                // The faucet is on its timelock. Go ahead only if the liquidity itself is covered.
                require(usdcHeld >= p.usdcAmount, "faucet timelock: wait an hour or lower SEED_USDC_UNITS");
            }
        }

        uint256 wethHeld = IERC20(WETH).balanceOf(deployer);
        if (wethHeld < p.wethAmount) {
            uint256 shortfall = p.wethAmount - wethHeld;
            require(
                deployer.balance >= shortfall + p.gasReserveWei,
                "not enough Base Sepolia ETH to wrap SEED_WETH_WEI and keep the gas reserve"
            );
            IWETH9(WETH).deposit{value: shortfall}();
        }
    }

    function _recenter(
        address deployer,
        IUniswapV3Factory factory,
        address pool,
        address token0,
        address token1,
        Params memory p,
        uint160 target
    ) internal returns (address mover) {
        (uint160 current,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (current == target) return p.mover;

        mover = p.mover;
        if (mover == address(0) || mover.code.length == 0) mover = address(new PoolPriceMover(factory));
        require(address(PoolPriceMover(mover).FACTORY()) == address(factory), "PRICE_MOVER is on another factory");

        // Moving the price down sells token0 into the pool, moving it up sells token1.
        address tokenIn = target < current ? token0 : token1;
        uint256 maxIn = IERC20(tokenIn).balanceOf(deployer);
        IERC20(tokenIn).approve(mover, maxIn);
        PoolPriceMover(mover).moveTo(token0, token1, p.fee, target, maxIn);
        IERC20(tokenIn).approve(mover, 0);
    }

    function _sqrtPrice(address pool) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
    }

    function _oracle() internal view returns (IAavePriceOracle) {
        return IAavePriceOracle(IAaveAddressesProvider(Deployments.BASE_SEPOLIA_ADDRESSES_PROVIDER).getPriceOracle());
    }

    function _unit(address asset) internal view returns (uint256) {
        IAavePool pool = IAavePool(IAaveAddressesProvider(Deployments.BASE_SEPOLIA_ADDRESSES_PROVIDER).getPool());
        AaveReserveData memory data = pool.getReserveData(asset);
        return 10 ** ((data.configuration >> 48) & 0xff);
    }

    function _oracleSqrtPrice(address token0, address token1) internal view returns (uint160) {
        IAavePriceOracle oracle = _oracle();
        return TestnetPoolMath.oracleSqrtPriceX96(
            oracle.getAssetPrice(token0), _unit(token0), oracle.getAssetPrice(token1), _unit(token1)
        );
    }

    function _oracleValueInUsdc(uint256 wethAmount) internal view returns (uint256) {
        IAavePriceOracle oracle = _oracle();
        return
            Math.mulDiv(wethAmount, oracle.getAssetPrice(WETH) * _unit(USDC), oracle.getAssetPrice(USDC) * _unit(WETH));
    }

    function _log(address deployer, Result memory r) internal pure {
        console2.log("deployer", deployer);
        console2.log("pool", r.pool);
        console2.log("price mover (set PRICE_MOVER to reuse)", r.mover);
        console2.log("sqrtPriceX96", r.sqrtPriceX96);
        console2.log("tick", r.tick);
        console2.log("position tick range lower", r.tickLower);
        console2.log("position tick range upper", r.tickUpper);
        console2.log("position NFT id", r.tokenId);
        console2.log("liquidity", r.liquidity);
        console2.log("WETH added (wei)", r.wethAdded);
        console2.log("USDC added (base units)", r.usdcAdded);
    }
}
