// ABI of contracts/src/XWalletRegistry.sol (only what the web app uses).
const ATTESTATION =
  "tuple(address recipient, tuple(string url, string header, string method, string body) request, " +
  "tuple(string keyName, string parseType, string parsePath)[] reponseResolve, string data, string attConditions, " +
  "uint64 timestamp, string additionParams, tuple(address attestorAddr, string url)[] attestors, bytes[] signatures)";

export const REGISTRY_ABI = [
  `function register(${ATTESTATION} attestation)`,
  "function unlink()",
  "function handleOf(address wallet) view returns (string)",
  "function walletOf(string handle) view returns (address)",
  "function maxProofAge() view returns (uint256)",
  "function linkedCount() view returns (uint256)",
  "function historyLength() view returns (uint256)",
  "function lastProofAt(bytes32 handleKey) view returns (uint64)",
  "function recentLinks(uint256 count) view returns (tuple(address wallet, uint64 provedAtMs, string handle)[])",
  "event Linked(address indexed wallet, string handle, uint64 proofTimestampMs)",
  "event Unlinked(address indexed wallet, string handle)",
  "error WrongRecipient()",
  "error ProofExpired()",
  "error ProofFromFuture()",
  "error WrongDataSource()",
  "error WrongDataField()",
  "error InvalidHandle()",
  "error StaleProof()",
  "error NotLinked()",
];

// Copy only the fields the contract expects, in the shape ethers needs.
export function toAttestationStruct(a) {
  return {
    recipient: a.recipient,
    request: { url: a.request.url, header: a.request.header, method: a.request.method, body: a.request.body },
    reponseResolve: a.reponseResolve.map((r) => ({ keyName: r.keyName, parseType: r.parseType, parsePath: r.parsePath })),
    data: a.data,
    attConditions: a.attConditions,
    timestamp: a.timestamp,
    additionParams: a.additionParams,
    attestors: a.attestors.map((x) => ({ attestorAddr: x.attestorAddr, url: x.url })),
    signatures: a.signatures,
  };
}
