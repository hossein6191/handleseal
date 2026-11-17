// End to end check on a local Anvil chain, without the browser extension:
//  1. deploys the Primus verifier (trusting a test attestor) and XWalletRegistry
//  2. builds an attestation shaped like the SDK output and hashes it with the SDK's own encoder
//  3. checks the JS hash equals the onchain hash, then registers it with the web app's ABI
// Run: anvil (in another terminal), then npm run test:e2e

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { ethers } from "ethers";
// Not exported by the package, so it is imported by path. This is the encoder the SDK uses in verifyAttestation.
import { encodeAttestation } from "../node_modules/@primuslabs/zktls-js-sdk/dist/utils.js";
import { REGISTRY_ABI, toAttestationStruct } from "../web/registry-abi.js";

// Default Anvil accounts (public test keys)
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  attestor: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  user: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  other: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
};

const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const wallet = (k) => new ethers.NonceManager(new ethers.Wallet(KEYS[k], provider));
const artifact = (file, name) => JSON.parse(readFileSync(new URL(`../contracts/out/${file}/${name}.json`, import.meta.url)));

async function deploy(file, name, signer, args = []) {
  const a = artifact(file, name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode.object, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

let failed = false;
async function step(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed = true;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const deployer = wallet("deployer");
const attestorAddr = new ethers.Wallet(KEYS.attestor).address;
const user = wallet("user");
const userAddr = new ethers.Wallet(KEYS.user).address;

console.log("Deploying to local Anvil…");
const impl = await deploy("PrimusZKTLS.sol", "PrimusZKTLS", deployer);
const initData = impl.interface.encodeFunctionData("initialize", [attestorAddr]);
const proxy = await deploy("ERC1967Proxy.sol", "ERC1967Proxy", deployer, [await impl.getAddress(), initData]);
const verifier = new ethers.Contract(await proxy.getAddress(), impl.interface, provider);
const registryDeployed = await deploy("XWalletRegistry.sol", "XWalletRegistry", deployer, [await verifier.getAddress(), 3600]);
const registryAddr = await registryDeployed.getAddress();

// Same shape as the object PrimusZKTLS.startAttestation() resolves with.
const latest = await provider.getBlock("latest");
const attestation = {
  recipient: userAddr,
  request: {
    url: "https://api.x.com/1.1/account/settings.json?include_ext_sharing_audiospace=true",
    header: "",
    method: "GET",
    body: "",
  },
  reponseResolve: [{ keyName: "screen_name", parseType: "json", parsePath: "$.screen_name" }],
  data: '{"screen_name":"sample_user"}',
  attConditions: "",
  timestamp: latest.timestamp * 1000,
  additionParams: "",
  attestors: [{ attestorAddr, url: "https://primuslabs.xyz" }],
  signatures: [],
};
const jsHash = encodeAttestation(attestation);
attestation.signatures = [new ethers.SigningKey(KEYS.attestor).sign(jsHash).serialized];
const struct = toAttestationStruct(attestation);

console.log("Checks:");
await step("SDK hash equals onchain encodeAttestation hash", async () => {
  assert.equal(await verifier.encodeAttestation(struct), jsHash);
});

await step("Primus verifier accepts the attestor signature", async () => {
  await verifier.verifyAttestation(struct);
});

await step("register() with the web app ABI links the handle", async () => {
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, user);
  await (await registry.register(struct)).wait();
  assert.equal(await registry.handleOf(userAddr), "sample_user");
  assert.equal(await registry.walletOf("@sample_user"), userAddr);
});

await step("another wallet cannot reuse the proof (WrongRecipient)", async () => {
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, wallet("other"));
  await assert.rejects(registry.register.staticCall(struct), (err) => err.revert?.name === "WrongRecipient");
});

await step("a changed handle breaks the signature", async () => {
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, user);
  const forged = { ...struct, data: '{"screen_name":"elonmusk"}' };
  await assert.rejects(registry.register.staticCall(forged), (err) => err.reason === "Invalid signature");
});

if (failed) {
  console.log("Some checks failed.");
  process.exit(1);
}
console.log("All checks passed.");
