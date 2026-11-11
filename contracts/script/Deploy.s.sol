// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PrimusZKTLS} from "@primuslabs/zktls-contracts/src/PrimusZKTLS.sol";
import {IPrimusZKTLS, Attestor} from "@primuslabs/zktls-contracts/src/IPrimusZKTLS.sol";
import {XWalletRegistry} from "../src/XWalletRegistry.sol";

/// @notice Deploys XWalletRegistry and writes deployments/<chainId>.json for the web app.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  key that pays for the deployment
///   PRIMUS_VERIFIER       optional, an official Primus verifier to use
///                         (BNB Chain mainnet: 0xf3c20a5216d669c521ffe3724c1439ae0897ac33)
///   MAX_PROOF_AGE         optional, seconds a proof stays valid (default 3600)
///
/// Without PRIMUS_VERIFIER, a copy of the Primus verifier is deployed that trusts only the
/// attestor used by the Primus zkTLS JS SDK 0.3.15. The official testnet verifiers do not
/// list that attestor, so proofs from the SDK would be rejected there.
contract Deploy is Script {
    address constant SDK_ATTESTOR = 0x5Ed3176045F68617B0958a61ac1868875C98C14d;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        uint256 maxProofAge = vm.envOr("MAX_PROOF_AGE", uint256(1 hours));
        address verifier = vm.envOr("PRIMUS_VERIFIER", address(0));
        bool officialVerifier = verifier != address(0);

        vm.startBroadcast(deployerKey);

        if (!officialVerifier) {
            // Deploy and initialize in one transaction so nobody can initialize it first.
            PrimusZKTLS implementation = new PrimusZKTLS();
            PrimusZKTLS proxy = PrimusZKTLS(
                address(new ERC1967Proxy(address(implementation), abi.encodeCall(PrimusZKTLS.initialize, (deployer))))
            );
            // initialize() trusts the owner as an attestor; trust the SDK attestor instead.
            proxy.setAttestor(Attestor({attestorAddr: SDK_ATTESTOR, url: "https://primuslabs.xyz/"}));
            proxy.removeAttestor(deployer);
            verifier = address(proxy);
        }

        XWalletRegistry registry = new XWalletRegistry(IPrimusZKTLS(verifier), maxProofAge);

        vm.stopBroadcast();

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "verifier", verifier);
        vm.serializeBool(obj, "officialVerifier", officialVerifier);
        vm.serializeUint(obj, "maxProofAge", maxProofAge);
        vm.serializeUint(obj, "deployBlock", block.number);
        string memory json = vm.serializeAddress(obj, "registry", address(registry));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console.log("XWalletRegistry:", address(registry));
        console.log("Primus verifier:", verifier, officialVerifier ? "(official)" : "(own copy)");
        console.log("Saved to", path);
    }
}
