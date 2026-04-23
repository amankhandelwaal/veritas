// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Veritas} from "../src/Veritas.sol";

contract Deploy is Script {
    function run() external returns (Veritas deployed) {
        vm.startBroadcast();
        deployed = new Veritas();
        vm.stopBroadcast();

        console2.log("Veritas deployed at:", address(deployed));
    }
}
