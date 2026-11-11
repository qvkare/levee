// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LeveeUnwind} from "../src/LeveeUnwind.sol";
import {IAavePriceOracle} from "../src/interfaces/IAaveV3.sol";
import {IUniswapV3Pool} from "../src/interfaces/IUniswapV3.sol";
import {Deployments} from "../script/lib/Deployments.sol";
import {INonfungiblePositionManager, IWETH9, TestnetPoolMath} from "../script/lib/TestnetPool.sol";
import {SeedTestnetPool} from "../script/SeedTestnetPool.s.sol";
import {ForkTarget, Targets} from "./lib/AaveFork.sol";
import {UnwindTarget, UnwindTargets} from "./lib/UnwindFork.sol";
import {UnwindPath} from "./lib/UnwindPath.sol";

interface IERC721Owner {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// The second live testnet, rehearsed. Aave's Arbitrum Sepolia market is on Pool revision 3
/// and lists Circle's testnet USDC, which no script can mint, so setUp gives the deployer
/// USDC with `deal` and runs SeedTestnetPool. `test_seed_liveFunding_borrowsUsdcOnAave`
/// rehearses how the live deployer gets it instead: by borrowing it on Aave against WETH.
contract UnwindArbitrumSepoliaTest is UnwindPath {
    uint24 internal constant SEED_FEE = 3000;
    uint256 internal constant SEED_WETH = 300 ether;
    int24 internal constant SEED_RANGE_TICKS = 600;

    address internal deployer = makeAddr("testnet deployer");
    SeedTestnetPool internal seeder;
    SeedTestnetPool.Result internal seeded;
    uint160 internal sqrtPriceBeforeSeed;
    uint256 internal seedGas;

    function forkTarget() internal pure override returns (ForkTarget memory) {
        return Targets.arbitrumSepolia();
    }

    function unwindTarget() internal pure override returns (UnwindTarget memory) {
        return UnwindTargets.arbitrumSepolia();
    }

    function preparePool() internal override {
        (sqrtPriceBeforeSeed,,,,,,) = IUniswapV3Pool(UnwindTargets.arbitrumSepolia().deepPool).slot0();
        seeder = new SeedTestnetPool();
        vm.deal(deployer, SEED_WETH + 1 ether);
        deal(address(usdc), deployer, oracleValueInUsdc(SEED_WETH) + 1_000e6);
        uint256 gasBefore = gasleft();
        seeded = seeder.seedFrom(deployer, seedParams(address(0), SEED_WETH, 0));
        seedGas = gasBefore - gasleft();
    }

    function seedParams(address mover, uint256 wethAmount, uint256 usdcAmount)
        internal
        pure
        returns (SeedTestnetPool.Params memory)
    {
        return SeedTestnetPool.Params({
            fee: SEED_FEE,
            wethAmount: wethAmount,
            usdcAmount: usdcAmount,
            rangeTicks: SEED_RANGE_TICKS,
            gasReserveWei: 0.005 ether,
            mover: mover
        });
    }

    function oracleValueInUsdc(uint256 wethAmount) internal view returns (uint256) {
        return
            wethAmount * oracle.getAssetPrice(address(weth)) * USDC_UNIT / (oracle.getAssetPrice(address(usdc)) * 1e18);
    }

    function test_arbitrumSepolia_isPoolRevision3() public view {
        assertEq(pool.POOL_REVISION(), 3, "Arbitrum Sepolia Pool revision");
    }

    function test_seed_putsThePoolAtTheOraclePrice() public view {
        console2.log("first seeding run, execution gas", seedGas);
        assertEq(seeded.pool, ut.deepPool, "seeded the existing 0.30% pool");
        assertGt(seeded.mover.code.length, 0, "the pool was off price, so the mover was deployed");
        assertTrue(sqrtPriceBeforeSeed != seeded.sqrtPriceX96, "the pool started somewhere else");

        uint256 expected = TestnetPoolMath.oracleSqrtPriceX96(
            oracle.getAssetPrice(address(weth)), 1e18, oracle.getAssetPrice(address(usdc)), USDC_UNIT
        );
        (uint160 sqrtPriceX96,,,,,,) = uniPool.slot0();
        assertEq(sqrtPriceX96, expected, "pool sits at the oracle price");

        assertEq(
            IERC721Owner(Deployments.ARBITRUM_SEPOLIA_POSITION_MANAGER).ownerOf(seeded.tokenId),
            deployer,
            "deployer owns the position"
        );
        assertGt(seeded.liquidity, 0, "liquidity added");
        assertGt(seeded.wethAdded, SEED_WETH * 9 / 10, "most of the WETH went in");
        assertEq(IERC20(address(weth)).allowance(deployer, Deployments.ARBITRUM_SEPOLIA_POSITION_MANAGER), 0);
        assertEq(IERC20(address(usdc)).allowance(deployer, Deployments.ARBITRUM_SEPOLIA_POSITION_MANAGER), 0);
        assertEq(IERC20(address(usdc)).allowance(deployer, seeded.mover), 0, "mover allowance left");
        assertGe(deployer.balance, 0.005 ether, "gas reserve kept");
    }

    /// With no faucet, a deployer holding only ETH is told where the USDC has to come from.
    function test_seed_withoutUsdc_saysWhy() public {
        address fresh = makeAddr("deployer with only ETH");
        vm.deal(fresh, 1 ether);
        vm.expectRevert(
            bytes("no USDC faucet on this chain: hold SEED_USDC_UNITS of USDC first, e.g. borrowed on Aave")
        );
        seeder.seedFrom(fresh, seedParams(seeded.mover, 0.02 ether, 40e6));
    }

    /// The live run's funding, at its size: a deployer with only ETH wraps it, supplies WETH
    /// to Aave, borrows USDC against it and seeds the pool with that USDC. A borrower is then
    /// unwound by tens of USDC, as on the testnet.
    function test_seed_liveFunding_borrowsUsdcOnAave() public {
        address live = makeAddr("live deployer");
        vm.deal(live, 0.2 ether);
        vm.startPrank(live);
        IWETH9(address(weth)).deposit{value: 0.15 ether}();
        weth.approve(address(pool), 0.1 ether);
        pool.supply(address(weth), 0.1 ether, live, 0);
        pool.borrow(address(usdc), 60e6, VARIABLE_RATE, 0, live);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 minutes);
        SeedTestnetPool.Result memory r = seeder.seedFrom(live, seedParams(seeded.mover, 0.02 ether, 40e6));
        assertEq(r.pool, ut.deepPool, "seeded the same pool");
        (uint160 sqrtPriceX96,,,,,,) = uniPool.slot0();
        assertEq(
            sqrtPriceX96,
            TestnetPoolMath.oracleSqrtPriceX96(
                oracle.getAssetPrice(address(weth)), 1e18, oracle.getAssetPrice(address(usdc)), USDC_UNIT
            ),
            "pool at the oracle price"
        );
        assertGt(r.usdcAdded, 0, "borrowed USDC went in");
        assertGt(r.wethAdded, 0, "wrapped WETH went in");

        // A borrower the size of the live one, 0.05 WETH, at a health factor of 1.15.
        uint256 debt = openPosition(borrower, 0.05 ether, 1.15e18);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, 0.05 ether);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, SEED_FEE);
        assertLt(amount, debt, "a partial repay");
        assertLt(amount, 100e6, "tens of USDC, as on the testnet");
        Outcome memory o = unwindAndCheck(borrower, amount, SEED_FEE);
        logOutcome("live-size unwind", o);
        assertGe(o.afterwards.healthFactor, TARGET_HF, "reaches the target");
    }

    /// Running the script again moves the pool back to a moved oracle, through its own
    /// liquidity, reusing the mover.
    function test_seed_rerun_followsTheOracle() public {
        uint256 moved = oracle.getAssetPrice(address(weth)) * 104 / 100;
        vm.mockCall(address(oracle), abi.encodeCall(IAavePriceOracle.getAssetPrice, (address(weth))), abi.encode(moved));
        vm.deal(deployer, SEED_WETH + 1 ether);
        deal(address(usdc), deployer, oracleValueInUsdc(SEED_WETH) * 2);
        SeedTestnetPool.Result memory again = seeder.seedFrom(deployer, seedParams(seeded.mover, SEED_WETH, 0));
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

    /// As on Base Sepolia, the mint must outlive `forge script`'s later broadcast blocks.
    function test_seed_mintDeadline_leavesTimeToBroadcast() public {
        vm.deal(deployer, SEED_WETH + 1 ether);
        deal(address(usdc), deployer, oracleValueInUsdc(SEED_WETH));
        vm.startStateDiffRecording();
        seeder.seedFrom(deployer, seedParams(seeded.mover, SEED_WETH, 0));
        VmSafe.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();

        uint256 mints;
        for (uint256 i; i < accesses.length; ++i) {
            VmSafe.AccountAccess memory access = accesses[i];
            if (
                access.account != Deployments.ARBITRUM_SEPOLIA_POSITION_MANAGER
                    || access.kind != VmSafe.AccountAccessKind.Call || access.data.length < 4
                    || bytes4(access.data) != INonfungiblePositionManager.mint.selector
            ) continue;
            INonfungiblePositionManager.MintParams memory params =
                abi.decode(withoutSelector(access.data), (INonfungiblePositionManager.MintParams));
            assertGe(params.deadline, block.timestamp + 10 minutes, "the mint outlives the broadcast");
            ++mints;
        }
        assertEq(mints, 1, "one mint");
    }

    function withoutSelector(bytes memory data) internal pure returns (bytes memory args) {
        args = new bytes(data.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = data[i + 4];
        }
    }

    /// The other tiers for this pair exist on Arbitrum Sepolia, nearly empty and at prices
    /// others left. Picking one by mistake fails safely: none can pay out the repay.
    function test_wrongFeeTier_stalePools_revert() public {
        openPosition(borrower, COLLATERAL, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, SEED_FEE);

        uint24[3] memory fees = [uint24(100), 500, 10000];
        for (uint256 i; i < fees.length; ++i) {
            authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, COLLATERAL, fees[i]);
            vm.prank(rescuer);
            vm.expectPartialRevert(LeveeUnwind.PartialFill.selector);
            helper.unwind(borrower, address(weth), amount, fees[i], type(uint256).max);
        }
        assertHelperClean();
    }
}
