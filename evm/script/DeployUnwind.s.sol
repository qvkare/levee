// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {LeveeUnwind} from "../src/LeveeUnwind.sol";
import {Deployments, UnwindArgs} from "./lib/Deployments.sol";

/// Deploys LeveeUnwind with the verified constructor arguments for the chain the RPC
/// serves: Base, Arbitrum One or Base Sepolia. Any other chain reverts.
///
/// The signer comes from DEPLOYER_PRIVATE_KEY if it is set, otherwise from Foundry's own
/// wallet flags, such as `--account` with a keystore or `--ledger`. Use those on mainnet.
contract DeployUnwind is Script {
    function run() external returns (LeveeUnwind helper) {
        UnwindArgs memory args = Deployments.unwindArgs(block.chainid);

        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
        helper = deploy(args);
        vm.stopBroadcast();

        console2.log("chain", args.name, block.chainid);
        console2.log("LeveeUnwind", address(helper));
        console2.log("addresses provider", args.addressesProvider);
        console2.log("USDC", args.usdc);
        console2.log("Uniswap v3 factory", args.uniswapV3Factory);
    }

    function deploy(UnwindArgs memory args) internal returns (LeveeUnwind) {
        return new LeveeUnwind(args.addressesProvider, args.usdc, args.uniswapV3Factory);
    }
}
