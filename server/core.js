// Shared by the local Express server (server/index.js) and the Vercel functions (api/).
import { readFileSync, existsSync } from "node:fs";
import { ethers } from "ethers";
import { CHAINS } from "../web/chains.js";

// "X Account Ownership" template from the Primus Developer Hub Templates Market.
export const X_TEMPLATE_ID = "2e3160ae-8b1e-45e3-8c59-426366278b9d";
// First funded account of a default Anvil node. Public test key, local chain only.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readEnv() {
  const env = {
    appId: process.env.PRIMUS_APP_ID?.trim(),
    appSecret: process.env.PRIMUS_APP_SECRET?.trim(),
    templateId: process.env.PRIMUS_TEMPLATE_ID?.trim() || X_TEMPLATE_ID,
    // Local runs default to Anvil, Vercel deployments to BNB Smart Chain Testnet.
    chainId: Number(process.env.CHAIN_ID || (process.env.VERCEL ? 97 : 31337)),
  };
  const missing = [];
  if (!env.appId) missing.push("PRIMUS_APP_ID");
  if (!env.appSecret) missing.push("PRIMUS_APP_SECRET");
  if (missing.length) throw new HttpError(500, `Missing ${missing.join(" and ")} on the server.`);
  if (!CHAINS[env.chainId]) throw new HttpError(500, `CHAIN_ID ${env.chainId} is not supported.`);
  return env;
}

export function readDeployment(chainId) {
  // DEPLOYMENTS_DIR lets a second local instance use other contracts (handy for UI work with sample data).
  const dir = process.env.DEPLOYMENTS_DIR;
  const file = dir ? `${dir.replace(/\/$/, "")}/${chainId}.json` : new URL(`../contracts/deployments/${chainId}.json`, import.meta.url);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function getConfig() {
  const env = readEnv();
  const deployment = readDeployment(env.chainId);
  return {
    appId: env.appId, // public, the browser SDK needs it
    templateId: env.templateId,
    chain: CHAINS[env.chainId],
    registry: deployment?.registry ?? null,
    verifier: deployment?.verifier ?? null,
    officialVerifier: deployment?.officialVerifier ?? false,
    maxProofAge: deployment?.maxProofAge ?? null,
    sourceUrl: process.env.SOURCE_URL?.trim() || null,
  };
}

// The SDK is loaded on first use, so /api/config keeps working even if it fails to load,
// and the failure reaches the caller as a readable error.
let primusPromise;
function signer(env) {
  primusPromise ??= (async () => {
    let PrimusZKTLS;
    try {
      ({ PrimusZKTLS } = await import("@primuslabs/zktls-js-sdk"));
    } catch (err) {
      primusPromise = undefined;
      console.error("Loading @primuslabs/zktls-js-sdk failed:", err);
      throw new HttpError(500, `Could not load the Primus SDK on the server: ${err.message}`);
    }
    const primus = new PrimusZKTLS();
    await primus.init(env.appId, env.appSecret); // app server mode, no extension needed
    return primus;
  })();
  return primusPromise;
}

/// Signs a zkTLS request, but only for this app, this template and a real wallet,
/// so the secret cannot be used to sign anything else.
export async function signRequest(signParams) {
  if (typeof signParams !== "string" || signParams.length > 8000) throw new HttpError(400, "signParams must be a string");
  let request;
  try {
    request = JSON.parse(signParams);
  } catch {
    throw new HttpError(400, "signParams is not valid JSON");
  }
  const env = readEnv();
  if (request.appId !== env.appId) throw new HttpError(400, "Wrong appId");
  if (request.attTemplateID !== env.templateId) throw new HttpError(400, "Wrong template");
  if (!ethers.isAddress(request.userAddress) || request.userAddress === ethers.ZeroAddress) {
    throw new HttpError(400, "A wallet address is required");
  }
  const signResult = await (await signer(env)).sign(signParams);
  return { signResult };
}

/// Local chain only: sends 1 test ETH from an Anvil account.
export async function fundLocal(address) {
  const env = readEnv();
  if (env.chainId !== 31337) throw new HttpError(404, "Not available on this network");
  if (!ethers.isAddress(address)) throw new HttpError(400, "Invalid address");
  const wallet = new ethers.Wallet(ANVIL_KEY, new ethers.JsonRpcProvider(CHAINS[31337].rpcUrl));
  const tx = await wallet.sendTransaction({ to: address, value: ethers.parseEther("1") });
  await tx.wait();
  return { txHash: tx.hash };
}

export function errorResponse(err) {
  if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
  console.error(err);
  return { status: 500, body: { error: "Server error" } };
}
