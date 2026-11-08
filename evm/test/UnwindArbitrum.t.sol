// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ForkTarget, Targets} from "./lib/AaveFork.sol";
import {UnwindTarget, UnwindTargets} from "./lib/UnwindFork.sol";
import {UnwindPath} from "./lib/UnwindPath.sol";

contract UnwindArbitrumTest is UnwindPath {
    function forkTarget() internal pure override returns (ForkTarget memory) {
        return Targets.arbitrum();
    }

    function unwindTarget() internal pure override returns (UnwindTarget memory) {
        return UnwindTargets.arbitrum();
    }
}
