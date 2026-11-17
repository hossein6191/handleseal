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
import {GitHubRegistry} from "../src/GitHubRegistry.sol";

contract GitHubRegistryTest is Test {
    uint256 constant ATTESTOR_KEY = 0xA77E57;
    uint256 constant MAX_AGE = 1 hours;
    string constant URL = "https://github.com/_filter/repositories?limit=3&q=&filter_value=";
    string constant OWNER_PATH = "$.repositories[1].owner";
    string constant TYPE_PATH = "$.repositories[1].ownerType";

    PrimusZKTLS verifier;
    GitHubRegistry registry;
    address attestor;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_790_000_000);
        attestor = vm.addr(ATTESTOR_KEY);
        verifier = new PrimusZKTLS();
        verifier.initialize(attestor);
        registry = new GitHubRegistry(IPrimusZKTLS(address(verifier)), MAX_AGE);
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
        a.request = AttNetworkRequest({url: URL, header: "", method: "GET", body: ""});
        a.reponseResolve = new AttNetworkResponseResolve[](2);
        a.reponseResolve[0] = AttNetworkResponseResolve({keyName: "owner", parseType: "", parsePath: OWNER_PATH});
        a.reponseResolve[1] = AttNetworkResponseResolve({keyName: "ownerType", parseType: "", parsePath: TYPE_PATH});
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

    function _data(string memory login) internal pure returns (string memory) {
        return string.concat('{"owner":"', login, '","ownerType":"User"}');
    }

    function _proof(address recipient, string memory login, uint64 ts) internal view returns (Attestation memory) {
        return _sign(_attestation(recipient, _data(login), ts), ATTESTOR_KEY);
    }

    function _nowMs() internal view returns (uint64) {
        return uint64(block.timestamp * 1000);
    }

    function _register(address who, string memory login) internal {
        Attestation memory a = _proof(who, login, _nowMs());
        vm.prank(who);
        registry.register(a);
    }

    function _expectRevert(address who, Attestation memory a, bytes4 err) internal {
        vm.prank(who);
        vm.expectRevert(err);
        registry.register(a);
    }

    // ------------------------------------------------------------------
    // Happy path
    // ------------------------------------------------------------------

    function test_RegisterLinksLoginAndWallet() public {
        _register(alice, "Octo-Cat");
        assertEq(registry.handleOf(alice), "Octo-Cat");
        assertEq(registry.walletOf("Octo-Cat"), alice);
        assertEq(registry.walletOf("octo-cat"), alice, "lookup is case insensitive");
        assertEq(registry.walletOf("@OCTO-CAT"), alice, "leading @ is accepted");
        assertEq(registry.lastProofAt(keccak256("octo-cat")), _nowMs());
        assertEq(registry.linkedCount(), 1);
    }

    function test_RegisterEmitsLinked() public {
        Attestation memory a = _proof(alice, "octocat", _nowMs());
        vm.expectEmit(true, false, false, true);
        emit GitHubRegistry.Linked(alice, "octocat", _nowMs());
        vm.prank(alice);
        registry.register(a);
    }

    function test_AcceptsRealisticVariants() public {
        // Fields in the other order, explicit REVEAL_STRING conditions, spaces and extra keys in the data.
        Attestation memory a = _attestation(alice, '{ "ownerType" : "User", "owner" : "octocat", "owner.count":"1" }', _nowMs());
        (a.reponseResolve[0], a.reponseResolve[1]) = (a.reponseResolve[1], a.reponseResolve[0]);
        a.attConditions =
            '[{"op":"REVEAL_STRING","field":"$.repositories[1].owner"},{ "op" : "REVEAL_STRING","field":"$.repositories[1].ownerType"}]';
        a.request.url = string.concat(URL, "&page=1");
        a = _sign(a, ATTESTOR_KEY);
        vm.prank(alice);
        registry.register(a);
        assertEq(registry.handleOf(alice), "octocat");
    }

    function test_AcceptsMaxLengthLoginAndSmallClockDrift() public {
        string memory login = "a23456789012345678901234567890123456789"; // 39 characters
        Attestation memory a = _proof(alice, login, _nowMs() + 60_000);
        vm.prank(alice);
        registry.register(a);
        assertEq(registry.handleOf(alice), login);
    }

    // ------------------------------------------------------------------
    // Who and when
    // ------------------------------------------------------------------

    function test_RevertWhen_SubmittedByAnotherWallet() public {
        _expectRevert(bob, _proof(alice, "octocat", _nowMs()), GitHubRegistry.WrongRecipient.selector);
    }

    function test_RevertWhen_NotSignedByTrustedAttestor() public {
        Attestation memory a = _sign(_attestation(alice, _data("octocat"), _nowMs()), 0xBAD);
        vm.prank(alice);
        vm.expectRevert("Invalid signature");
        registry.register(a);
    }

    function test_RevertWhen_DataChangedAfterSigning() public {
        Attestation memory a = _proof(alice, "octocat", _nowMs());
        a.data = _data("torvalds");
        vm.prank(alice);
        vm.expectRevert("Invalid signature");
        registry.register(a);
    }

    function test_RevertWhen_ProofExpired() public {
        Attestation memory a = _proof(alice, "octocat", _nowMs());
        vm.warp(block.timestamp + MAX_AGE + 1);
        _expectRevert(alice, a, GitHubRegistry.ProofExpired.selector);
    }

    function test_RevertWhen_ProofFromFuture() public {
        _expectRevert(alice, _proof(alice, "octocat", _nowMs() + 600_000), GitHubRegistry.ProofFromFuture.selector);
    }

    // ------------------------------------------------------------------
    // What was proven
    // ------------------------------------------------------------------

    function test_RevertWhen_OtherDataSource() public {
        string[4] memory urls = [
            "https://github.com/_filter/repositories?limit=3&q=evil&filter_value=",
            "https://github.com/_filter/repositories?limit=3&q=&filter_value=x",
            "https://api.x.com/1.1/account/settings.json",
            "https://evil.com/_filter/repositories?limit=3&q=&filter_value="
        ];
        for (uint256 i; i < urls.length; ++i) {
            Attestation memory a = _attestation(alice, _data("octocat"), _nowMs());
            a.request.url = urls[i];
            _expectRevert(alice, _sign(a, ATTESTOR_KEY), GitHubRegistry.WrongDataSource.selector);
        }
    }

    function test_RevertWhen_FieldsDoNotMatchTemplate() public {
        Attestation memory a = _attestation(alice, _data("octocat"), _nowMs());
        a.reponseResolve[0].parsePath = "$.repositories[0].owner";
        _expectRevert(alice, _sign(a, ATTESTOR_KEY), GitHubRegistry.WrongDataField.selector);

        a = _attestation(alice, _data("octocat"), _nowMs());
        a.reponseResolve[1] = a.reponseResolve[0]; // owner twice
        _expectRevert(alice, _sign(a, ATTESTOR_KEY), GitHubRegistry.WrongDataField.selector);

        a = _attestation(alice, _data("octocat"), _nowMs());
        AttNetworkResponseResolve[] memory one = new AttNetworkResponseResolve[](1);
        one[0] = a.reponseResolve[0];
        a.reponseResolve = one;
        _expectRevert(alice, _sign(a, ATTESTOR_KEY), GitHubRegistry.WrongDataField.selector);
    }

    function test_RevertWhen_ConditionsAreNotPlainReveals() public {
        string[3] memory bad = [
            '[{"op":"SHA256","field":"$.repositories[1].owner"},{"op":"REVEAL_STRING","field":"$.repositories[1].ownerType"}]',
            '[{"op":"REVEAL_STRING","field":"$.repositories[1].owner"},{"op":">","field":"$.repositories[1].ownerType","value":"A"}]',
            '[{"op":"REVEAL_STRINGX","field":"$.repositories[1].owner"}]'
        ];
        for (uint256 i; i < bad.length; ++i) {
            Attestation memory a = _attestation(alice, _data("octocat"), _nowMs());
            a.attConditions = bad[i];
            _expectRevert(alice, _sign(a, ATTESTOR_KEY), GitHubRegistry.WrongConditions.selector);
        }
    }

    function test_RevertWhen_OwnerIsNotAUser() public {
        string[3] memory bad =
            ['{"owner":"github","ownerType":"Organization"}', '{"owner":"octocat","ownerType":"user"}', '{"owner":"octocat"}'];
        for (uint256 i; i < bad.length; ++i) {
            _expectRevert(alice, _sign(_attestation(alice, bad[i], _nowMs()), ATTESTOR_KEY), GitHubRegistry.NotAUserAccount.selector);
        }
    }

    function test_RevertWhen_LoginInvalid() public {
        string[6] memory bad = [
            "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b", // a hash, too long
            "a234567890123456789012345678901234567890", // 40 characters
            "bad_login",
            "-octocat",
            "",
            "octo cat"
        ];
        for (uint256 i; i < bad.length; ++i) {
            _expectRevert(alice, _sign(_attestation(alice, _data(bad[i]), _nowMs()), ATTESTOR_KEY), GitHubRegistry.InvalidHandle.selector);
        }
        _expectRevert(
            alice, _sign(_attestation(alice, '{"ownerType":"User"}', _nowMs()), ATTESTOR_KEY), GitHubRegistry.InvalidHandle.selector
        );
    }

    // ------------------------------------------------------------------
    // Relinking
    // ------------------------------------------------------------------

    function test_NewerProofMovesLoginToNewWallet() public {
        _register(alice, "octocat");
        vm.warp(block.timestamp + 10);
        _register(bob, "OctoCat");
        assertEq(registry.walletOf("octocat"), bob);
        assertEq(registry.handleOf(alice), "");
        assertEq(registry.linkedCount(), 1);
    }

    function test_RevertWhen_OlderProofTriesToUndoNewerOne() public {
        Attestation memory aliceOld = _proof(alice, "octocat", _nowMs());
        vm.warp(block.timestamp + 10);
        _register(bob, "octocat");
        _expectRevert(alice, aliceOld, GitHubRegistry.StaleProof.selector);
    }

    function test_WalletSwitchingLoginFreesOldLogin() public {
        _register(alice, "old-login");
        vm.warp(block.timestamp + 10);
        _register(alice, "new-login");
        assertEq(registry.walletOf("old-login"), address(0));
        assertEq(registry.walletOf("new-login"), alice);
        assertEq(registry.linkedCount(), 1);
    }

    function test_Unlink() public {
        _register(alice, "octocat");
        vm.prank(alice);
        registry.unlink();
        assertEq(registry.handleOf(alice), "");
        assertEq(registry.walletOf("octocat"), address(0));
        assertEq(registry.linkedCount(), 0);
        vm.prank(alice);
        vm.expectRevert(GitHubRegistry.NotLinked.selector);
        registry.unlink();
    }

    function test_RecentLinks() public {
        _register(alice, "alice-gh");
        vm.warp(block.timestamp + 1);
        _register(bob, "bob-gh");
        GitHubRegistry.LinkRecord[] memory r = registry.recentLinks(10);
        assertEq(r.length, 2);
        assertEq(r[0].handle, "bob-gh");
        assertEq(r[1].wallet, alice);
        assertEq(registry.historyLength(), 2);
    }
}
