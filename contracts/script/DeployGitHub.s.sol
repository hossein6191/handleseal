// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IPrimusZKTLS} from "@primuslabs/zktls-contracts/src/IPrimusZKTLS.sol";
import {GitHubRegistry} from "../src/GitHubRegistry.sol";

/// @notice Deploys GitHubRegistry next to an existing XWalletRegistry deployment, using the same Primus
///         verifier, and writes deployments/github-<chainId>.json for the web app.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  key that pays for the deployment
///   PRIMUS_VERIFIER       optional, the verifier to use (default: "verifier" in deployments/<chainId>.json)
///   MAX_PROOF_AGE         optional, seconds a proof stays valid (default 3600)
contract DeployGitHub is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 maxProofAge = vm.envOr("MAX_PROOF_AGE", uint256(1 hours));
        address verifier = vm.envOr("PRIMUS_VERIFIER", address(0));
        if (verifier == address(0)) {
            string memory existing = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
            verifier = vm.parseJsonAddress(existing, ".verifier");
        }
        require(verifier.code.length > 0, "No Primus verifier at that address");

        vm.startBroadcast(deployerKey);
        GitHubRegistry registry = new GitHubRegistry(IPrimusZKTLS(verifier), maxProofAge);
        vm.stopBroadcast();

        string memory obj = "github";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "verifier", verifier);
        vm.serializeUint(obj, "maxProofAge", maxProofAge);
        vm.serializeUint(obj, "deployBlock", block.number);
        string memory json = vm.serializeAddress(obj, "githubRegistry", address(registry));
        string memory path = string.concat("deployments/github-", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console.log("GitHubRegistry:", address(registry));
        console.log("Primus verifier:", verifier);
        console.log("Saved to", path);
    }
}
