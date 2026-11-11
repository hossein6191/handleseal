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

/// Same output as PrimusZKTLS.sign() in @primuslabs/zktls-js-sdk 0.3.15 (checked by test/sign-compat.js):
/// an EIP-191 signature, made with the appSecret, over keccak256 of the request string.
/// Doing it here avoids loading the whole browser SDK (with its Solana and ethers v5 code) on the
/// server, which crashed the Vercel functions.
export async function primusSign(appSecret, signParams) {
  const wallet = new ethers.Wallet(appSecret);
  const appSignature = await wallet.signMessage(ethers.keccak256(ethers.toUtf8Bytes(signParams)));
  return JSON.stringify({ attRequest: JSON.parse(signParams), appSignature });
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
  return { signResult: await primusSign(env.appSecret, signParams) };
}

// ---------------------------------------------------------------------------
// X profiles (name, picture, bio), for display only: FxTwitter (free), then twitterapi.io if a key is set.
// The seal itself never depends on this data.
// ---------------------------------------------------------------------------

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;
const profileCache = new Map(); // lowercase handle -> { until, data }

function profileFrom({ handle, name, picture, bio, followers, blueVerified }) {
  // Only accept pictures from X's own image host.
  const avatar = typeof picture === "string" && picture.startsWith("https://pbs.twimg.com/") ? picture.replace("_normal.", "_400x400.") : null;
  return {
    available: true,
    handle,
    name: String(name ?? "").slice(0, 60),
    avatar,
    bio: String(bio ?? "").slice(0, 200),
    followers: Number(followers) || 0,
    blueVerified: Boolean(blueVerified),
  };
}

/// Free, no key: the public FxTwitter API (https://github.com/FxEmbed/FxEmbed).
/// It often answers "User not found" for accounts that exist, so a 404 is retried a few times.
async function fromFxTwitter(handle) {
  const deadline = Date.now() + 8000; // stay well inside the serverless time limit
  let res;
  let json;
  for (let attempt = 1; attempt <= 4 && deadline - Date.now() > 600; attempt++) {
    try {
      res = await fetch(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`, {
        headers: { "User-Agent": "HandleSeal profile lookup" },
        signal: AbortSignal.timeout(Math.min(3500, deadline - Date.now())),
      });
      json = await res.json().catch(() => ({}));
      if (json?.user?.screen_name || (res.status !== 404 && json?.code !== 404)) break;
    } catch {
      res = undefined; // timed out, try again while time is left
    }
    if (attempt < 4) await new Promise((r) => setTimeout(r, 150 * attempt));
  }
  const u = json?.user;
  if (!res) throw new Error("FxTwitter did not answer in time");
  if (json?.code === 404 || res.status === 404) return { available: false, reason: "not found" };
  if (!res.ok || !u?.screen_name) throw new Error(`FxTwitter answered ${res.status}`);
  return profileFrom({
    handle: u.screen_name,
    name: u.name,
    picture: u.avatar_url,
    bio: u.description,
    followers: u.followers,
    blueVerified: u.verification?.verified,
  });
}

/// Optional paid fallback: twitterapi.io with TWITTER_API_KEY.
async function fromTwitterApiIo(handle, apiKey) {
  const res = await fetch(`https://api.twitterapi.io/twitter/user/info?userName=${encodeURIComponent(handle)}`, {
    headers: { "X-API-Key": apiKey },
    signal: AbortSignal.timeout(6000),
  });
  const json = await res.json().catch(() => ({}));
  const u = json?.data;
  if (!res.ok || !u?.userName) throw new Error(`twitterapi.io answered ${res.status}: ${json?.message ?? ""}`);
  return profileFrom({
    handle: u.userName,
    name: u.name,
    picture: u.profilePicture,
    bio: u.description,
    followers: u.followers,
    blueVerified: u.isBlueVerified,
  });
}

export async function getXProfile(handle) {
  handle = String(handle ?? "").replace(/^@/, "");
  if (!HANDLE_RE.test(handle)) throw new HttpError(400, "Invalid handle");

  const cacheKey = handle.toLowerCase();
  const hit = profileCache.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.data;

  const sources = [() => fromFxTwitter(handle)];
  const apiKey = process.env.TWITTER_API_KEY?.trim();
  if (apiKey) sources.push(() => fromTwitterApiIo(handle, apiKey));

  let data = { available: false, reason: "lookup failed" };
  for (const source of sources) {
    try {
      data = await source();
      break;
    } catch (err) {
      console.warn("X profile lookup failed:", err.message);
    }
  }
  profileCache.set(cacheKey, { until: Date.now() + (data.available ? PROFILE_TTL_MS : MISS_TTL_MS), data });
  return data;
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
