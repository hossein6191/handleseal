// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PrimusZKTLS} from "@primuslabs/zktls-contracts/src/PrimusZKTLS.sol";
import {
    IPrimusZKTLS,
    Attestation,
    AttNetworkRequest,
    AttNetworkResponseResolve,
    Attestor
} from "@primuslabs/zktls-contracts/src/IPrimusZKTLS.sol";
import {XWalletRegistry} from "../src/XWalletRegistry.sol";

contract XWalletRegistryTest is Test {
    uint256 constant ATTESTOR_KEY = 0xA77E57;
    uint256 constant MAX_AGE = 1 hours;
    string constant X_URL = "https://api.x.com/1.1/account/settings.json?include_ext_sharing_audiospace=true";

    PrimusZKTLS verifier;
    XWalletRegistry registry;
    address attestor;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_790_000_000); // a realistic "now"
        attestor = vm.addr(ATTESTOR_KEY);

        // The real Primus verifier, trusting our test attestor only.
        verifier = new PrimusZKTLS();
        verifier.initialize(attestor);

        registry = new XWalletRegistry(IPrimusZKTLS(address(verifier)), MAX_AGE);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _attestation(address recipient, string memory data, uint64 timestampMs)
        internal
        view
        returns (Attestation memory a)
    {
        a.recipient = recipient;
        a.request = AttNetworkRequest({url: X_URL, header: "", method: "GET", body: ""});
        a.reponseResolve = new AttNetworkResponseResolve[](1);
        a.reponseResolve[0] = AttNetworkResponseResolve({keyName: "screen_name", parseType: "", parsePath: "$.screen_name"});
        a.data = data;
        a.attConditions = "";
        a.timestamp = timestampMs;
        a.additionParams = "";
        a.attestors = new Attestor[](1);
        a.attestors[0] = Attestor({attestorAddr: attestor, url: "https://primuslabs.xyz"});
    }

    function _sign(Attestation memory a, uint256 key) internal view returns (Attestation memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, verifier.encodeAttestation(a));
        a.signatures = new bytes[](1);
        a.signatures[0] = abi.encodePacked(r, s, v);
        return a;
    }

    function _proof(address recipient, string memory handle, uint64 timestampMs)
        internal
        view
        returns (Attestation memory)
    {
        string memory data = string.concat('{"screen_name":"', handle, '"}');
        return _sign(_attestation(recipient, data, timestampMs), ATTESTOR_KEY);
    }

    function _nowMs() internal view returns (uint64) {
        return uint64(block.timestamp * 1000);
    }

    // ------------------------------------------------------------------
    // Happy path
    // ------------------------------------------------------------------

    function test_RegisterLinksHandleAndWallet() public {
        Attestation memory proof_ = _proof(alice, "Primus_Labs", _nowMs());
        vm.prank(alice);
        registry.register(proof_);

        assertEq(registry.handleOf(alice), "Primus_Labs");
        assertEq(registry.walletOf("Primus_Labs"), alice);
        assertEq(registry.walletOf("primus_labs"), alice, "lookup is case insensitive");
        assertEq(registry.walletOf("@PRIMUS_LABS"), alice, "leading @ is accepted");
        assertEq(registry.lastProofAt(keccak256("primus_labs")), _nowMs());
    }

    function test_RegisterEmitsLinked() public {
        vm.expectEmit(true, false, false, true);
        emit XWalletRegistry.Linked(alice, "primus_labs", _nowMs());
        Attestation memory proof_ = _proof(alice, "primus_labs", _nowMs());
        vm.prank(alice);
        registry.register(proof_);
    }

    function test_AcceptsSpacesInJson() public {
        Attestation memory a = _sign(_attestation(alice, '{ "screen_name" : "primus_labs" }', _nowMs()), ATTESTOR_KEY);
        vm.prank(alice);
        registry.register(a);
        assertEq(registry.handleOf(alice), "primus_labs");
    }

    function test_AcceptsSmallClockDrift() public {
        Attestation memory proof_ = _proof(alice, "primus_labs", _nowMs() + 60_000);
        vm.prank(alice);
        registry.register(proof_);
        assertEq(registry.handleOf(alice), "primus_labs");
    }

    // ------------------------------------------------------------------
    // Who and when
    // ------------------------------------------------------------------

    function test_RevertWhen_SubmittedByAnotherWallet() public {
        Attestation memory a = _proof(alice, "primus_labs", _nowMs());
        vm.prank(bob);
        vm.expectRevert(XWalletRegistry.WrongRecipient.selector);
        registry.register(a);
    }

    function test_RevertWhen_NotSignedByTrustedAttestor() public {
        Attestation memory a = _sign(_attestation(alice, '{"screen_name":"primus_labs"}', _nowMs()), 0xBAD);
        vm.prank(alice);
        vm.expectRevert("Invalid signature");
        registry.register(a);
    }

    function test_RevertWhen_DataChangedAfterSigning() public {
        Attestation memory a = _proof(alice, "primus_labs", _nowMs());
        a.data = '{"screen_name":"elonmusk"}';
        vm.prank(alice);
        vm.expectRevert("Invalid signature");
        registry.register(a);
    }

    function test_RevertWhen_ProofExpired() public {
        Attestation memory a = _proof(alice, "primus_labs", _nowMs());
        vm.warp(block.timestamp + MAX_AGE + 1);
        vm.prank(alice);
        vm.expectRevert(XWalletRegistry.ProofExpired.selector);
        registry.register(a);
    }

    function test_RevertWhen_ProofFromFuture() public {
        Attestation memory a = _proof(alice, "primus_labs", _nowMs() + 10 minutes * 1000);
        vm.prank(alice);
        vm.expectRevert(XWalletRegistry.ProofFromFuture.selector);
        registry.register(a);
    }

    // ------------------------------------------------------------------
    // What was proven
    // ------------------------------------------------------------------

    function test_RevertWhen_OtherDataSource() public {
        Attestation memory a = _attestation(alice, '{"screen_name":"primus_labs"}', _nowMs());
        a.request.url = "https://api.example.com/profile";
        a = _sign(a, ATTESTOR_KEY);
        vm.prank(alice);
        vm.expectRevert(XWalletRegistry.WrongDataSource.selector);
        registry.register(a);
    }

    function test_RevertWhen_UrlOnlySharesPrefix() public {
        Attestation memory a = _attestation(alice, '{"screen_name":"primus_labs"}', _nowMs());
        a.request.url = "https://api.x.com/1.1/account/settings.json.evil";
        a = _sign(a, ATTESTOR_KEY);
        vm.prank(alice);
        vm.expectRevert(XWalletRegistry.WrongDataSource.selector);
        registry.register(a);
    }

    function test_RevertWhen_OtherDataField() public {
        Attestation memory a = _attestation(alice, '{"screen_name":"primus_labs"}', _nowMs());
        a.reponseResolve[0].parsePath = "$.language";
        a = _sign(a, ATTESTOR_KEY);
        vm.prank(alice);
        vm.expectRevert(XWalletRegistry.WrongDataField.selector);
        registry.register(a);
    }

    function test_RevertWhen_HandleIsHashedOrInvalid() public {
        string[4] memory bad = [
            '{"screen_name":"3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea"}',
            '{"screen_name":"bad-handle"}',
            '{"screen_name":""}',
            '{"other":"primus_labs"}'
        ];
        for (uint256 i; i < bad.length; ++i) {
            Attestation memory a = _sign(_attestation(alice, bad[i], _nowMs()), ATTESTOR_KEY);
            vm.prank(alice);
            vm.expectRevert(XWalletRegistry.InvalidHandle.selector);
            registry.register(a);
        }
    }

    // ------------------------------------------------------------------
    // Relinking
    // ------------------------------------------------------------------

    function test_NewerProofMovesHandleToNewWallet() public {
        Attestation memory proof_ = _proof(alice, "primus_labs", _nowMs());
        vm.prank(alice);
        registry.register(proof_);

        vm.warp(block.timestamp + 10);
        proof_ = _proof(bob, "Primus_Labs", _nowMs());
        vm.prank(bob);
        registry.register(proof_);

        assertEq(registry.walletOf("primus_labs"), bob);
        assertEq(registry.handleOf(bob), "Primus_Labs");
        assertEq(registry.handleOf(alice), "", "old wallet loses the handle");
    }

    function test_RevertWhen_OlderProofTriesToUndoNewerOne() public {
        Attestation memory aliceOld = _proof(alice, "primus_labs", _nowMs());

        vm.warp(block.timestamp + 10);
        Attestation memory proof_ = _proof(bob, "primus_labs", _nowMs());
        vm.prank(bob);
        registry.register(proof_);

        vm.prank(alice);
        vm.expectRevert(XWalletRegistry.StaleProof.selector);
        registry.register(aliceOld);
    }

    function test_WalletSwitchingHandleFreesOldHandle() public {
        Attestation memory proof_ = _proof(alice, "old_handle", _nowMs());
        vm.prank(alice);
        registry.register(proof_);

        vm.warp(block.timestamp + 10);
        proof_ = _proof(alice, "new_handle", _nowMs());
        vm.prank(alice);
        registry.register(proof_);

        assertEq(registry.handleOf(alice), "new_handle");
        assertEq(registry.walletOf("old_handle"), address(0));
        assertEq(registry.walletOf("new_handle"), alice);
    }

    function test_Unlink() public {
        Attestation memory proof_ = _proof(alice, "primus_labs", _nowMs());
        vm.prank(alice);
        registry.register(proof_);

        vm.prank(alice);
        registry.unlink();

        assertEq(registry.handleOf(alice), "");
        assertEq(registry.walletOf("primus_labs"), address(0));

        vm.prank(alice);
        vm.expectRevert(XWalletRegistry.NotLinked.selector);
        registry.unlink();
    }

    // ------------------------------------------------------------------
    // Count and recent links
    // ------------------------------------------------------------------

    function _register(address who, string memory handle) internal {
        Attestation memory proof_ = _proof(who, handle, _nowMs());
        vm.prank(who);
        registry.register(proof_);
        vm.warp(block.timestamp + 1);
    }

    function test_LinkedCountFollowsActiveLinks() public {
        _register(alice, "alice_x");
        _register(bob, "bob_x");
        assertEq(registry.linkedCount(), 2);

        _register(alice, "alice_x"); // refresh, same handle
        _register(alice, "alice_new"); // switch handle
        assertEq(registry.linkedCount(), 2);

        _register(bob, "alice_new"); // bob takes alice's handle, alice is left with nothing
        assertEq(registry.linkedCount(), 1);
        assertEq(registry.handleOf(alice), "");

        vm.prank(bob);
        registry.unlink();
        assertEq(registry.linkedCount(), 0);
    }

    function test_RecentLinksNewestFirst() public {
        _register(alice, "first");
        _register(bob, "second");
        _register(alice, "third");

        assertEq(registry.historyLength(), 3);
        XWalletRegistry.LinkRecord[] memory recent = registry.recentLinks(2);
        assertEq(recent.length, 2);
        assertEq(recent[0].handle, "third");
        assertEq(recent[0].wallet, alice);
        assertEq(recent[1].handle, "second");
        assertEq(recent[1].wallet, bob);

        assertEq(registry.recentLinks(10).length, 3, "capped at history length");
    }

    function test_RecentLinksCappedAtMax() public {
        for (uint256 i; i < 55; ++i) {
            _register(alice, string.concat("h", vm.toString(i)));
        }
        assertEq(registry.recentLinks(1000).length, registry.MAX_RECENT());
    }
}
