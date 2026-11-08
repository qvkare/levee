// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAaveOracle, IERC20Like, IPool, IPoolAddressesProvider, IScaledBalance} from "./AaveInterfaces.sol";

/// One chain's fork target. Values match docs/SPEC.md section 3.
struct ForkTarget {
    string name;
    string rpcEnv;
    string rpcDefault;
    uint256 forkBlock;
    uint256 forkTimestamp;
    uint256 chainId;
    address pool;
    address usdc;
    address weth;
}

library Targets {
    /// mainnet.base.org serves state at least 5,000,000 blocks back.
    function base() internal pure returns (ForkTarget memory) {
        return ForkTarget({
            name: "Base",
            rpcEnv: "BASE_FORK_RPC_URL",
            rpcDefault: "https://mainnet.base.org",
            forkBlock: 54_260_000,
            forkTimestamp: 1_794_042_375,
            chainId: 8453,
            pool: 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5,
            usdc: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
            weth: 0x4200000000000000000000000000000000000006
        });
    }

    /// The Arbitrum foundation endpoint (arb1.arbitrum.io/rpc) prunes state, so a
    /// pinned block needs an archive endpoint. See evm/README.md.
    function arbitrum() internal pure returns (ForkTarget memory) {
        return ForkTarget({
            name: "Arbitrum One",
            rpcEnv: "ARBITRUM_FORK_RPC_URL",
            rpcDefault: "https://arbitrum-one.public.blastapi.io",
            forkBlock: 522_040_000,
            forkTimestamp: 1_794_041_907,
            chainId: 42161,
            pool: 0x794a61358D6845594F94dc1DB02A252b5b4814aD,
            usdc: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831,
            weth: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
        });
    }

    /// Aave's Base Sepolia market, Pool revision 10. USDC is Aave's test token, minted by
    /// its faucet. WETH is the chain's real WETH9, wrapped from Base Sepolia ETH.
    function baseSepolia() internal pure returns (ForkTarget memory) {
        return ForkTarget({
            name: "Base Sepolia",
            rpcEnv: "BASE_SEPOLIA_FORK_RPC_URL",
            rpcDefault: "https://sepolia.base.org",
            forkBlock: 56_000_000,
            forkTimestamp: 1_794_121_868,
            chainId: 84532,
            pool: 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27,
            usdc: 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f,
            weth: 0x4200000000000000000000000000000000000006
        });
    }
}

/// Fork set-up and position helpers shared by every suite.
abstract contract AaveFork is Test {
    uint256 internal constant VARIABLE_RATE = 2;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 1e4;
    uint256 internal constant USDC_UNIT = 1e6;

    /// Aave burns scaled debt rounding down and reads the balance rounding up, so a
    /// repay of R can remove up to this many USDC base units less than R. Also the
    /// allowance for comparing a debt balance with the amount borrowed.
    uint256 internal constant DEBT_ROUNDING = 2;

    ForkTarget internal target;
    IPool internal pool;
    IAaveOracle internal oracle;
    IERC20Like internal usdc;
    IERC20Like internal weth;
    IERC20Like internal aWeth;
    IERC20Like internal vDebtUsdc;

    address internal borrower = makeAddr("borrower");
    address internal rescuer = makeAddr("rescuer");
    address internal liquidator = makeAddr("liquidator");

    function forkTarget() internal pure virtual returns (ForkTarget memory);

    function setUp() public virtual {
        target = forkTarget();
        string memory url = vm.envOr(target.rpcEnv, target.rpcDefault);
        vm.createSelectFork(url, target.forkBlock);

        // A fork of the wrong chain or block must not pass quietly. The pin is checked
        // by timestamp because block.number on Arbitrum is the L1 block number.
        assertEq(block.chainid, target.chainId, "RPC serves a different chain");
        assertEq(block.timestamp, target.forkTimestamp, "fork is not at the pinned block");

        pool = IPool(target.pool);
        oracle = IAaveOracle(IPoolAddressesProvider(pool.ADDRESSES_PROVIDER()).getPriceOracle());
        usdc = IERC20Like(target.usdc);
        weth = IERC20Like(target.weth);
        aWeth = IERC20Like(pool.getReserveAToken(target.weth));
        vDebtUsdc = IERC20Like(pool.getReserveVariableDebtToken(target.usdc));
    }

    /// Supplies WETH and borrows USDC at a variable rate, sized to a health factor.
    function openPosition(address user, uint256 wethAmount, uint256 healthFactor) internal returns (uint256 debt) {
        deal(address(weth), user, wethAmount);
        vm.startPrank(user);
        weth.approve(address(pool), wethAmount);
        pool.supply(address(weth), wethAmount, user, 0);
        (uint256 collateralBase,,, uint256 threshold,,) = pool.getUserAccountData(user);
        uint256 debtBase = collateralBase * threshold * WAD / BPS / healthFactor;
        debt = debtBase * USDC_UNIT / oracle.getAssetPrice(address(usdc));
        pool.borrow(address(usdc), debt, VARIABLE_RATE, 0, user);
        vm.stopPrank();
    }

    /// Funds and approves a third party the way the rescuer is funded on chain.
    function fundRescuer(address who, uint256 balance, uint256 allowance) internal {
        deal(address(usdc), who, balance);
        vm.prank(who);
        usdc.approve(address(pool), allowance);
    }

    /// docs/SPEC.md section 5, R = D - (C * L) / T, in USDC base units. Rounds up and
    /// adds DEBT_ROUNDING, because the bare formula lands just under the target.
    function repayToTarget(address user, uint256 targetHealthFactor) internal view returns (uint256) {
        (uint256 collateralBase, uint256 debtBase,, uint256 threshold,,) = pool.getUserAccountData(user);
        uint256 supportedDebtBase = collateralBase * threshold * WAD / BPS / targetHealthFactor;
        assertGt(debtBase, supportedDebtBase, "already at or above target");
        uint256 repayBase = debtBase - supportedDebtBase;
        uint256 price = oracle.getAssetPrice(address(usdc));
        return (repayBase * USDC_UNIT + price - 1) / price + DEBT_ROUNDING;
    }

    function healthFactorOf(address user) internal view returns (uint256 healthFactor) {
        (,,,,, healthFactor) = pool.getUserAccountData(user);
    }

    function collateralBaseOf(address user) internal view returns (uint256 collateralBase) {
        (collateralBase,,,,,) = pool.getUserAccountData(user);
    }

    function debtBaseOf(address user) internal view returns (uint256 debtBase) {
        (, debtBase,,,,) = pool.getUserAccountData(user);
    }

    function scaledCollateralOf(address user) internal view returns (uint256) {
        return IScaledBalance(address(aWeth)).scaledBalanceOf(user);
    }

    /// Fixed point rendering for the printed tables, rounded to nearest.
    function fixedPoint(uint256 value, uint256 unit, uint256 decimals) internal pure returns (string memory) {
        uint256 scale = 10 ** decimals;
        uint256 rounded = value + unit / (2 * scale);
        uint256 whole = rounded / unit;
        uint256 frac = (rounded % unit) * scale / unit;
        bytes memory padded = bytes(vm.toString(frac));
        bytes memory out = new bytes(decimals);
        for (uint256 i = 0; i < decimals; i++) {
            out[i] = "0";
        }
        for (uint256 i = 0; i < padded.length; i++) {
            out[decimals - padded.length + i] = padded[i];
        }
        return string.concat(vm.toString(whole), ".", string(out));
    }
}
