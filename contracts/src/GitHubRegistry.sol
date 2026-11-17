// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPrimusZKTLS, Attestation} from "@primuslabs/zktls-contracts/src/IPrimusZKTLS.sol";

/// @title GitHubRegistry
/// @notice Links a GitHub login to a wallet. A link is written only after a Primus zkTLS attestation proves
///         that the caller was logged in to github.com as the owner of a repo in their own repo list.
/// @dev Second source of HandleSeal, next to XWalletRegistry and using the same Primus verifier. The verifier only
///      checks the attestor signature. Everything else (who the proof is for, how old it is, which request it
///      came from, what it says) is checked here.
///
///      The template (made in the Primus Developer Hub) proves the response of GitHub's repo picker request
///      for the logged-in user and reads the owner of the second repo in that list. That repo can belong to
///      someone who added the user as a collaborator; see the README.
contract GitHubRegistry {
    /// @dev Request of the GitHub template: the logged-in user's repo list on github.com.
    string public constant GITHUB_REPOS_URL = "https://github.com/_filter/repositories?limit=3&q=&filter_value=";
    string public constant OWNER_KEY = "owner";
    string public constant OWNER_PATH = "$.repositories[1].owner";
    string public constant OWNER_TYPE_KEY = "ownerType";
    string public constant OWNER_TYPE_PATH = "$.repositories[1].ownerType";
    string public constant OWNER_TYPE_USER = "User";

    /// @dev GitHub logins are 1 to 39 characters of A-Z, a-z, 0-9 and hyphen.
    uint256 private constant MAX_LOGIN_LENGTH = 39;
    uint256 private constant MAX_FUTURE_DRIFT = 5 minutes;
    uint256 public constant MAX_RECENT = 50;

    IPrimusZKTLS public immutable primus;
    /// @notice How old (in seconds) a proof may be when it is submitted.
    uint256 public immutable maxProofAge;

    struct LinkRecord {
        address wallet;
        uint64 provedAtMs;
        string handle;
    }

    mapping(address wallet => string login) private _loginOf;
    mapping(bytes32 loginKey => address wallet) private _walletOf;
    /// @notice Timestamp (ms) of the newest proof accepted for each login.
    mapping(bytes32 loginKey => uint64 timestampMs) public lastProofAt;
    /// @notice Number of wallets that currently have a linked login.
    uint256 public linkedCount;
    /// @dev Every accepted proof, oldest first. Entries can be outdated; check `handleOf` for the current state.
    LinkRecord[] private _history;

    event Linked(address indexed wallet, string handle, uint64 proofTimestampMs);
    event Unlinked(address indexed wallet, string handle);

    error WrongRecipient();
    error ProofExpired();
    error ProofFromFuture();
    error WrongDataSource();
    error WrongDataField();
    error WrongConditions();
    error NotAUserAccount();
    error InvalidHandle();
    error StaleProof();
    error NotLinked();

    constructor(IPrimusZKTLS primus_, uint256 maxProofAge_) {
        primus = primus_;
        maxProofAge = maxProofAge_;
    }

    /// @notice Link the GitHub login proven in `attestation` to the caller's wallet.
    /// @dev Replaces any earlier link of this wallet or of this login.
    function register(Attestation calldata attestation) external {
        if (attestation.recipient != msg.sender) revert WrongRecipient();

        // Reverts unless the attestation is signed by an attestor the verifier trusts.
        primus.verifyAttestation(attestation);

        _checkFreshness(attestation.timestamp);
        _checkSource(attestation);

        if (!_valueEquals(attestation.data, OWNER_TYPE_KEY, OWNER_TYPE_USER)) revert NotAUserAccount();
        (string memory login, bytes32 key) = _extractLogin(attestation.data);

        // An older proof must never undo a newer one (for example after a login changed hands).
        if (attestation.timestamp <= lastProofAt[key]) revert StaleProof();
        lastProofAt[key] = attestation.timestamp;

        address previousWallet = _walletOf[key];
        if (previousWallet != address(0) && previousWallet != msg.sender) {
            emit Unlinked(previousWallet, _loginOf[previousWallet]);
            delete _loginOf[previousWallet];
            --linkedCount;
        }

        string memory previousLogin = _loginOf[msg.sender];
        if (bytes(previousLogin).length == 0) {
            ++linkedCount;
        } else {
            bytes32 previousKey = _loginKey(bytes(previousLogin));
            if (previousKey != key) {
                delete _walletOf[previousKey];
                emit Unlinked(msg.sender, previousLogin);
            }
        }

        _loginOf[msg.sender] = login;
        _walletOf[key] = msg.sender;
        _history.push(LinkRecord({wallet: msg.sender, provedAtMs: attestation.timestamp, handle: login}));
        emit Linked(msg.sender, login, attestation.timestamp);
    }

    /// @notice Remove the caller's link.
    function unlink() external {
        string memory login = _loginOf[msg.sender];
        if (bytes(login).length == 0) revert NotLinked();
        delete _walletOf[_loginKey(bytes(login))];
        delete _loginOf[msg.sender];
        --linkedCount;
        emit Unlinked(msg.sender, login);
    }

    function historyLength() external view returns (uint256) {
        return _history.length;
    }

    /// @notice The newest accepted proofs, newest first, at most `MAX_RECENT`.
    function recentLinks(uint256 count) external view returns (LinkRecord[] memory records) {
        uint256 total = _history.length;
        if (count > total) count = total;
        if (count > MAX_RECENT) count = MAX_RECENT;
        records = new LinkRecord[](count);
        for (uint256 i; i < count; ++i) {
            records[i] = _history[total - 1 - i];
        }
    }

    /// @notice The GitHub login linked to `wallet`, or an empty string. Same name as in XWalletRegistry.
    function handleOf(address wallet) external view returns (string memory) {
        return _loginOf[wallet];
    }

    /// @notice The wallet linked to a GitHub login. Case insensitive, a leading "@" is allowed.
    function walletOf(string calldata login) external view returns (address) {
        bytes calldata raw = bytes(login);
        if (raw.length != 0 && raw[0] == "@") raw = raw[1:];
        return _walletOf[_loginKey(raw)];
    }

    // ---------------------------------------------------------------------
    // Checks
    // ---------------------------------------------------------------------

    function _checkFreshness(uint64 timestampMs) private view {
        uint256 provedAt = uint256(timestampMs) / 1000;
        if (provedAt > block.timestamp) {
            if (provedAt - block.timestamp > MAX_FUTURE_DRIFT) revert ProofFromFuture();
        } else if (block.timestamp - provedAt > maxProofAge) {
            revert ProofExpired();
        }
    }

    function _checkSource(Attestation calldata a) private pure {
        if (!_isSourceUrl(bytes(a.request.url), bytes(GITHUB_REPOS_URL))) revert WrongDataSource();

        // Exactly the two template fields, in any order.
        if (a.reponseResolve.length != 2) revert WrongDataField();
        bool owner;
        bool ownerType;
        for (uint256 i; i < 2; ++i) {
            string calldata key = a.reponseResolve[i].keyName;
            string calldata path = a.reponseResolve[i].parsePath;
            if (!owner && _equals(key, OWNER_KEY) && _equals(path, OWNER_PATH)) owner = true;
            else if (!ownerType && _equals(key, OWNER_TYPE_KEY) && _equals(path, OWNER_TYPE_PATH)) ownerType = true;
            else revert WrongDataField();
        }

        // Only plain reveals: a hash or a comparison would turn the login into something else.
        if (!_onlyRevealConditions(bytes(a.attConditions))) revert WrongConditions();
    }

    /// @dev True if every "op" in the conditions JSON is "REVEAL_STRING" (an empty string has none).
    function _onlyRevealConditions(bytes calldata c) private pure returns (bool) {
        bytes memory opKey = bytes('"op"');
        bytes memory reveal = bytes('"REVEAL_STRING"');
        uint256 from;
        while (true) {
            uint256 i = _indexOfFrom(c, opKey, from);
            if (i == type(uint256).max) return true;
            i = _skipSpaces(c, i + opKey.length);
            if (i >= c.length || c[i] != ":") return false;
            i = _skipSpaces(c, i + 1);
            if (i + reveal.length > c.length || keccak256(c[i:i + reveal.length]) != keccak256(reveal)) return false;
            from = i + reveal.length;
        }
        return true;
    }

    /// @dev Reads the value of "owner" from the attested JSON, e.g. {"owner":"octocat","ownerType":"User"}.
    function _extractLogin(string calldata data) private pure returns (string memory login, bytes32 key) {
        bytes calldata d = bytes(data);
        (uint256 start, uint256 end, bool found) = _stringValue(d, OWNER_KEY);
        if (!found) revert InvalidHandle();
        uint256 length = end - start;
        if (length == 0 || length > MAX_LOGIN_LENGTH || d[start] == "-") revert InvalidHandle();
        for (uint256 i = start; i < end; ++i) {
            if (!_isLoginChar(d[i])) revert InvalidHandle();
        }
        login = string(d[start:end]);
        key = _loginKey(d[start:end]);
    }

    function _valueEquals(string calldata data, string memory key, string memory expected) private pure returns (bool) {
        bytes calldata d = bytes(data);
        (uint256 start, uint256 end, bool found) = _stringValue(d, key);
        return found && keccak256(d[start:end]) == keccak256(bytes(expected));
    }

    /// @dev Start and end of the quoted string value of `"key"`.
    function _stringValue(bytes calldata d, string memory key)
        private
        pure
        returns (uint256 start, uint256 end, bool found)
    {
        bytes memory field = bytes(string.concat('"', key, '"'));
        uint256 i = _indexOfFrom(d, field, 0);
        if (i == type(uint256).max) return (0, 0, false);
        i = _skipSpaces(d, i + field.length);
        if (i >= d.length || d[i] != ":") return (0, 0, false);
        i = _skipSpaces(d, i + 1);
        if (i >= d.length || d[i] != '"') return (0, 0, false);
        start = ++i;
        while (i < d.length && d[i] != '"') ++i;
        if (i >= d.length) return (0, 0, false);
        return (start, i, true);
    }

    // ---------------------------------------------------------------------
    // Byte helpers
    // ---------------------------------------------------------------------

    /// @dev Lowercased hash, so "OctoCat" and "octocat" are the same login.
    function _loginKey(bytes memory login) private pure returns (bytes32) {
        bytes memory lower = new bytes(login.length);
        for (uint256 i; i < login.length; ++i) {
            bytes1 c = login[i];
            lower[i] = (c >= "A" && c <= "Z") ? bytes1(uint8(c) + 32) : c;
        }
        return keccak256(lower);
    }

    function _isLoginChar(bytes1 c) private pure returns (bool) {
        return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "-";
    }

    function _skipSpaces(bytes calldata d, uint256 i) private pure returns (uint256) {
        while (i < d.length && (d[i] == " " || d[i] == "\n" || d[i] == "\r" || d[i] == "\t")) ++i;
        return i;
    }

    function _indexOfFrom(bytes calldata haystack, bytes memory needle, uint256 from) private pure returns (uint256) {
        if (needle.length > haystack.length) return type(uint256).max;
        for (uint256 i = from; i + needle.length <= haystack.length; ++i) {
            uint256 j;
            while (j < needle.length && haystack[i + j] == needle[j]) ++j;
            if (j == needle.length) return i;
        }
        return type(uint256).max;
    }

    /// @dev True if `value` is exactly `url`, or `url` followed by more query parameters ("&...").
    function _isSourceUrl(bytes calldata value, bytes memory url) private pure returns (bool) {
        if (value.length < url.length || keccak256(value[:url.length]) != keccak256(url)) return false;
        return value.length == url.length || value[url.length] == "&";
    }

    function _equals(string calldata a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
