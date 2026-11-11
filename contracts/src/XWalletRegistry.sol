// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPrimusZKTLS, Attestation} from "@primuslabs/zktls-contracts/src/IPrimusZKTLS.sol";

/// @title XWalletRegistry
/// @notice Links an X handle to a wallet. A link is written only after a Primus zkTLS
///         attestation proves that the caller was logged in to that X account.
/// @dev The Primus verifier only checks the attestor signature. Everything else
///      (who the proof is for, how old it is, which API it came from, what it says)
///      is checked here.
contract XWalletRegistry {
    /// @dev Request URL of the "X Account Ownership" template in the Primus Developer Hub.
    string public constant X_SETTINGS_URL = "https://api.x.com/1.1/account/settings.json";
    string public constant HANDLE_KEY = "screen_name";
    string public constant HANDLE_PATH = "$.screen_name";

    /// @dev X handles are 1 to 15 characters of A-Z, a-z, 0-9 and underscore.
    uint256 private constant MAX_HANDLE_LENGTH = 15;
    /// @dev Allowed clock drift between the attestor and the chain.
    uint256 private constant MAX_FUTURE_DRIFT = 5 minutes;

    IPrimusZKTLS public immutable primus;
    /// @notice How old (in seconds) a proof may be when it is submitted.
    uint256 public immutable maxProofAge;

    /// @dev Most links `recentLinks` returns in one call.
    uint256 public constant MAX_RECENT = 50;

    struct LinkRecord {
        address wallet;
        uint64 provedAtMs;
        string handle;
    }

    mapping(address wallet => string handle) private _handleOf;
    mapping(bytes32 handleKey => address wallet) private _walletOf;
    /// @notice Timestamp (ms) of the newest proof accepted for each handle.
    mapping(bytes32 handleKey => uint64 timestampMs) public lastProofAt;
    /// @notice Number of wallets that currently have a linked handle.
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
    error InvalidHandle();
    error StaleProof();
    error NotLinked();

    constructor(IPrimusZKTLS primus_, uint256 maxProofAge_) {
        primus = primus_;
        maxProofAge = maxProofAge_;
    }

    /// @notice Link the X handle proven in `attestation` to the caller's wallet.
    /// @dev Replaces any earlier link of this wallet or of this handle.
    function register(Attestation calldata attestation) external {
        if (attestation.recipient != msg.sender) revert WrongRecipient();

        // Reverts unless the attestation is signed by an attestor the verifier trusts.
        primus.verifyAttestation(attestation);

        _checkFreshness(attestation.timestamp);
        _checkSource(attestation);

        (string memory handle, bytes32 key) = _extractHandle(attestation.data);

        // An older proof must never undo a newer one (for example after an account changed hands).
        if (attestation.timestamp <= lastProofAt[key]) revert StaleProof();
        lastProofAt[key] = attestation.timestamp;

        address previousWallet = _walletOf[key];
        if (previousWallet != address(0) && previousWallet != msg.sender) {
            emit Unlinked(previousWallet, _handleOf[previousWallet]);
            delete _handleOf[previousWallet];
            --linkedCount;
        }

        string memory previousHandle = _handleOf[msg.sender];
        if (bytes(previousHandle).length == 0) {
            ++linkedCount;
        } else {
            bytes32 previousKey = _handleKey(bytes(previousHandle));
            if (previousKey != key) {
                delete _walletOf[previousKey];
                emit Unlinked(msg.sender, previousHandle);
            }
        }

        _handleOf[msg.sender] = handle;
        _walletOf[key] = msg.sender;
        _history.push(LinkRecord({wallet: msg.sender, provedAtMs: attestation.timestamp, handle: handle}));
        emit Linked(msg.sender, handle, attestation.timestamp);
    }

    /// @notice Remove the caller's link.
    function unlink() external {
        string memory handle = _handleOf[msg.sender];
        if (bytes(handle).length == 0) revert NotLinked();
        delete _walletOf[_handleKey(bytes(handle))];
        delete _handleOf[msg.sender];
        --linkedCount;
        emit Unlinked(msg.sender, handle);
    }

    /// @notice Number of proofs accepted so far.
    function historyLength() external view returns (uint256) {
        return _history.length;
    }

    /// @notice The newest accepted proofs, newest first, at most `MAX_RECENT`.
    /// @dev A record can be outdated if the wallet unlinked or the handle moved; compare with `handleOf`.
    function recentLinks(uint256 count) external view returns (LinkRecord[] memory records) {
        uint256 total = _history.length;
        if (count > total) count = total;
        if (count > MAX_RECENT) count = MAX_RECENT;
        records = new LinkRecord[](count);
        for (uint256 i; i < count; ++i) {
            records[i] = _history[total - 1 - i];
        }
    }

    /// @notice The X handle linked to `wallet`, or an empty string.
    function handleOf(address wallet) external view returns (string memory) {
        return _handleOf[wallet];
    }

    /// @notice The wallet linked to an X handle. Case insensitive, a leading "@" is allowed.
    function walletOf(string calldata handle) external view returns (address) {
        bytes calldata raw = bytes(handle);
        if (raw.length != 0 && raw[0] == "@") raw = raw[1:];
        return _walletOf[_handleKey(raw)];
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

    function _checkSource(Attestation calldata attestation) private pure {
        if (!_isUrlOrQuery(bytes(attestation.request.url), bytes(X_SETTINGS_URL))) revert WrongDataSource();
        if (
            attestation.reponseResolve.length != 1
                || !_equals(attestation.reponseResolve[0].keyName, HANDLE_KEY)
                || !_equals(attestation.reponseResolve[0].parsePath, HANDLE_PATH)
        ) revert WrongDataField();
    }

    /// @dev Reads the value of "screen_name" from the attested JSON, e.g. {"screen_name":"primus_labs"}.
    function _extractHandle(string calldata data) private pure returns (string memory handle, bytes32 key) {
        bytes calldata d = bytes(data);
        bytes memory field = bytes(string.concat('"', HANDLE_KEY, '"'));

        uint256 i = _indexOf(d, field);
        if (i == type(uint256).max) revert InvalidHandle();
        i += field.length;

        i = _skipSpaces(d, i);
        if (i >= d.length || d[i] != ":") revert InvalidHandle();
        i = _skipSpaces(d, i + 1);
        if (i >= d.length || d[i] != '"') revert InvalidHandle();
        uint256 start = ++i;

        while (i < d.length && d[i] != '"') {
            if (!_isHandleChar(d[i])) revert InvalidHandle();
            ++i;
        }
        uint256 length = i - start;
        if (i >= d.length || length == 0 || length > MAX_HANDLE_LENGTH) revert InvalidHandle();

        handle = string(d[start:i]);
        key = _handleKey(d[start:i]);
    }

    // ---------------------------------------------------------------------
    // Byte helpers
    // ---------------------------------------------------------------------

    /// @dev Lowercased hash, so "Primus_Labs" and "primus_labs" are the same handle.
    function _handleKey(bytes memory handle) private pure returns (bytes32) {
        bytes memory lower = new bytes(handle.length);
        for (uint256 i; i < handle.length; ++i) {
            bytes1 c = handle[i];
            lower[i] = (c >= "A" && c <= "Z") ? bytes1(uint8(c) + 32) : c;
        }
        return keccak256(lower);
    }

    function _isHandleChar(bytes1 c) private pure returns (bool) {
        return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "_";
    }

    function _skipSpaces(bytes calldata d, uint256 i) private pure returns (uint256) {
        while (i < d.length && (d[i] == " " || d[i] == "\n" || d[i] == "\r" || d[i] == "\t")) ++i;
        return i;
    }

    function _indexOf(bytes calldata haystack, bytes memory needle) private pure returns (uint256) {
        if (needle.length > haystack.length) return type(uint256).max;
        for (uint256 i; i <= haystack.length - needle.length; ++i) {
            uint256 j;
            while (j < needle.length && haystack[i + j] == needle[j]) ++j;
            if (j == needle.length) return i;
        }
        return type(uint256).max;
    }

    /// @dev True if `value` is exactly `url`, or `url` followed by a query string.
    function _isUrlOrQuery(bytes calldata value, bytes memory url) private pure returns (bool) {
        if (value.length < url.length || keccak256(value[:url.length]) != keccak256(url)) return false;
        return value.length == url.length || value[url.length] == "?";
    }

    function _equals(string calldata a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
