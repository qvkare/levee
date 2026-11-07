// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ForkTarget, Targets} from "./lib/AaveFork.sol";
import {RepayPath} from "./lib/RepayPath.sol";

contract BaseRepayTest is RepayPath {
    function forkTarget() internal pure override returns (ForkTarget memory) {
        return Targets.base();
    }
}
