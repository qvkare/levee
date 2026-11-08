// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LeveeUnwind} from "../src/LeveeUnwind.sol";
import {IAavePriceOracle} from "../src/interfaces/IAaveV3.sol";
import {IUniswapV3Pool} from "../src/interfaces/IUniswapV3.sol";
import {Deployments} from "../script/lib/Deployments.sol";
import {IAaveFaucet, TestnetPoolMath} from "../script/lib/TestnetPool.sol";
import {SeedTestnetPool} from "../script/SeedTestnetPool.s.sol";
import {ForkTarget, Targets} from "./lib/AaveFork.sol";
import {UnwindTarget, UnwindTargets} from "./lib/UnwindFork.sol";
import {UnwindPath} from "./lib/UnwindPath.sol";

interface IERC721Owner {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// The live testnet set-up, rehearsed. Aave's Base Sepolia market has no real DEX
/// liquidity, so setUp runs SeedTestnetPool from an address that holds only Base Sepolia
/// ETH, exactly as the script runs live, and every shared test then runs on that pool.
contract UnwindBaseSepoliaTest is UnwindPath {
    uint24 internal constant SEED_FEE = 3000;
    uint256 internal constant SEED_WETH = 300 ether;
    int24 internal constant SEED_RANGE_TICKS = 600;

    address internal deployer = makeAddr("testnet deployer");
    SeedTestnetPool internal seeder;
    SeedTestnetPool.Result internal seeded;
    uint160 internal sqrtPriceBeforeSeed;
    uint256 internal seedGas;

    function forkTarget() internal pure override returns (ForkTarget memory) {
        return Targets.baseSepolia();
    }

    function unwindTarget() internal pure override returns (UnwindTarget memory) {
        return UnwindTargets.baseSepolia();
    }

    function preparePool() internal override {
        (sqrtPriceBeforeSeed,,,,,,) = IUniswapV3Pool(UnwindTargets.baseSepolia().deepPool).slot0();
        seeder = new SeedTestnetPool();
        vm.deal(deployer, SEED_WETH + 1 ether);
        uint256 gasBefore = gasleft();
        seeded = seeder.seedFrom(deployer, seedParams(address(0)));
        seedGas = gasBefore - gasleft();
    }

    function seedParams(address mover) internal pure returns (SeedTestnetPool.Params memory) {
        return SeedTestnetPool.Params({
            fee: SEED_FEE,
            wethAmount: SEED_WETH,
            usdcAmount: 0,
            rangeTicks: SEED_RANGE_TICKS,
            gasReserveWei: 0.005 ether,
            mover: mover
        });
    }

    function test_baseSepolia_isPoolRevision10() public view {
        assertEq(pool.POOL_REVISION(), 10, "Base Sepolia Pool revision");
    }

    function test_seed_putsThePoolAtTheOraclePrice() public view {
        // Execution gas of every transaction in the first run, together, without the 21,000 each.
        console2.log("first seeding run, execution gas", seedGas);
        assertEq(seeded.pool, ut.deepPool, "seeded the existing 0.30% pool");
        assertGt(seeded.mover.code.length, 0, "the pool was off price, so the mover was deployed");
        assertTrue(sqrtPriceBeforeSeed != seeded.sqrtPriceX96, "the pool started somewhere else");

        uint256 expected = TestnetPoolMath.oracleSqrtPriceX96(
            oracle.getAssetPrice(address(weth)), 1e18, oracle.getAssetPrice(address(usdc)), USDC_UNIT
        );
        (uint160 sqrtPriceX96,,,,,,) = uniPool.slot0();
        assertEq(sqrtPriceX96, expected, "pool sits at the oracle price");

        // The deployer started with ETH only: the faucet minted the USDC and the script wrapped the WETH.
        assertEq(
            IERC721Owner(Deployments.BASE_SEPOLIA_POSITION_MANAGER).ownerOf(seeded.tokenId),
            deployer,
            "deployer owns the position"
        );
        assertGt(seeded.liquidity, 0, "liquidity added");
        assertGt(seeded.wethAdded, SEED_WETH * 9 / 10, "most of the WETH went in");
        assertEq(IERC20(address(weth)).allowance(deployer, Deployments.BASE_SEPOLIA_POSITION_MANAGER), 0);
        assertEq(IERC20(address(usdc)).allowance(deployer, Deployments.BASE_SEPOLIA_POSITION_MANAGER), 0);
        assertEq(IERC20(address(usdc)).allowance(deployer, seeded.mover), 0, "mover allowance left");
        assertGe(deployer.balance, 0.005 ether, "gas reserve kept");
        assertEq(
            IAaveFaucet(Deployments.BASE_SEPOLIA_AAVE_FAUCET).getUserLastUpdated(address(usdc), deployer),
            block.timestamp,
            "the test USDC came from the faucet"
        );
    }

    /// The faucet lets an address mint once an hour. A second run inside that hour, with
    /// the deployer's USDC already in the pool, stops with a reason instead of a bare revert.
    function test_seed_rerunInsideFaucetTimelock_saysWhy() public {
        vm.deal(deployer, SEED_WETH + 1 ether);
        vm.expectRevert(bytes("faucet timelock: wait an hour or lower SEED_USDC_UNITS"));
        seeder.seedFrom(deployer, seedParams(seeded.mover));
    }

    /// The oracle follows the real ETH price and nobody arbitrages this pool, so it drifts.
    /// Running the script again moves it back, through its own liquidity, reusing the mover.
    function test_seed_rerun_followsTheOracle() public {
        uint256 moved = oracle.getAssetPrice(address(weth)) * 104 / 100;
        vm.mockCall(address(oracle), abi.encodeCall(IAavePriceOracle.getAssetPrice, (address(weth))), abi.encode(moved));
        vm.deal(deployer, SEED_WETH + 1 ether);
        vm.warp(block.timestamp + 1 hours);
        SeedTestnetPool.Result memory again = seeder.seedFrom(deployer, seedParams(seeded.mover));
        assertEq(again.mover, seeded.mover, "mover reused");

        uint256 expected =
            TestnetPoolMath.oracleSqrtPriceX96(moved, 1e18, oracle.getAssetPrice(address(usdc)), USDC_UNIT);
        (uint160 sqrtPriceX96,,,,,,) = uniPool.slot0();
        assertEq(sqrtPriceX96, expected, "pool follows the oracle");

        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, SEED_FEE);
        Outcome memory o = unwindAndCheck(borrower, amount, SEED_FEE);
        assertGe(o.afterwards.healthFactor, TARGET_HF, "reaches the target at the new price");
    }

    /// The other tiers for this pair exist on Base Sepolia, at prices others left. Picking
    /// one by mistake fails safely.
    function test_wrongFeeTier_stalePools_revert() public {
        openPosition(borrower, COLLATERAL, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, SEED_FEE);

        // 1%: no liquidity and no USDC at all, so nothing comes out.
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, COLLATERAL, 10000);
        vm.prank(rescuer);
        vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.PartialFill.selector, 0, amount));
        helper.unwind(borrower, address(weth), amount, 10000, type(uint256).max);

        // 0.05%: already at the lowest price, so Uniswap refuses the price limit.
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, COLLATERAL, 500);
        vm.prank(rescuer);
        vm.expectRevert(bytes("SPL"));
        helper.unwind(borrower, address(weth), amount, 500, type(uint256).max);
        assertHelperClean();
    }
}
