import { PrimusZKTLS } from "@primuslabs/zktls-js-sdk";
import { BrowserProvider, Contract, JsonRpcProvider, ZeroAddress, getAddress, isAddress, keccak256, toUtf8Bytes } from "ethers";
import { REGISTRY_ABI, toAttestationStruct } from "./registry-abi.js";

const $ = (id) => document.getElementById(id);
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const INSTALL_URL = "https://chromewebstore.google.com/detail/pado/oeiomhmbaapihbilkfkhmlajkeegnjhe";
const IS_MOBILE = /android|iphone|ipad|mobile/i.test(navigator.userAgent);

// /?handle=name shows the public profile of that handle.
const PROFILE_HANDLE = (() => {
  const raw = new URLSearchParams(location.search).get("handle")?.replace(/^@/, "");
  return raw && HANDLE_RE.test(raw) ? raw : null;
})();

const state = {
  config: null,
  reader: null, // read-only registry over the public RPC
  signer: null,
  account: null,
  onRightChain: false,
  attestation: null,
  provenHandle: null,
  linked: null, // { handle, wallet, provedAtMs } for the connected wallet
  profile: null, // same shape, for PROFILE_HANDLE
  primus: new PrimusZKTLS(),
  primusReady: false,
  busy: false,
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const short = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
const handleKey = (handle) => keccak256(toUtf8Bytes(handle.toLowerCase()));
const formatDate = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["min", 60],
  ];
  for (const [name, size] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n > 1 && name !== "min" ? "s" : ""} ago`;
    }
  }
  return "just now";
}

function formatAge(seconds) {
  if (!seconds) return "1 hour";
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  return `${Math.round(seconds / 60)} min`;
}

function explorerUrl(kind, value) {
  const base = state.config?.chain.explorer;
  return base ? `${base}/${kind}/${value}` : null;
}

const profileUrl = (handle) => `${location.origin}/?handle=${encodeURIComponent(handle)}`;

function shareUrl(handle) {
  const text = `I sealed my X handle @${handle} to my wallet with a zkTLS proof from @primus_labs. Check it onchain on HandleSeal:`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(profileUrl(handle))}`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

const avatar = (handle) => el("div", { class: "avatar" }, handle ? handle[0] : "?");

// ---------------------------------------------------------------------------
// Status lines, banner, toast
// ---------------------------------------------------------------------------

const noDot = (text) => (typeof text === "string" ? text.replace(/(?<!\.)\.$/, "") : text);

function setStatus(id, content, kind = "") {
  const node = $(id);
  content = Array.isArray(content) ? content.map(noDot) : noDot(content);
  node.className = `status ${kind}`;
  node.replaceChildren(...(Array.isArray(content) ? content : [content]));
}

function showBanner(text) {
  $("banner").hidden = !text;
  $("banner").textContent = text || "";
}

let toastTimer;
function toast(text) {
  const node = $("toast");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 2200);
}

const REVERT_MESSAGES = {
  WrongRecipient: "This proof was made for another wallet. Make a new proof with the connected wallet",
  ProofExpired: "This proof is too old. Make a new one",
  ProofFromFuture: "Your computer clock looks wrong. Fix it, then make a new proof",
  WrongDataSource: "This proof did not come from the X account settings API",
  WrongDataField: "This proof does not contain the X handle field",
  InvalidHandle: "The proof does not contain a valid X handle",
  StaleProof: "A newer proof for this handle is already saved",
  NotLinked: "This wallet is not linked to any handle",
};

function explain(err) {
  console.error(err);
  if (!err) return "Something went wrong";
  // Primus SDK errors carry a numeric code and a readable message.
  if (typeof err.code === "string" && /^-?\d/.test(err.code) && err.message) {
    return `${err.message} (code ${err.code}${err.subCode ? `:${err.subCode}` : ""})`;
  }
  if (err.code === "ACTION_REJECTED" || err.code === 4001) return "You cancelled the request in your wallet";
  if (err.code === "INSUFFICIENT_FUNDS") return `Not enough ${state.config.chain.currency.symbol} in this wallet to pay for gas`;
  const revertName = err.revert?.name;
  if (revertName && REVERT_MESSAGES[revertName]) return REVERT_MESSAGES[revertName];
  if (err.reason === "Invalid signature") return "The Primus verifier did not accept the proof signature";
  return err.shortMessage || err.reason || err.message || String(err);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request to ${path} failed (${res.status})`);
  return json;
}

// ---------------------------------------------------------------------------
// Reading the registry
// ---------------------------------------------------------------------------

async function readLink(handleOrWallet) {
  const reader = state.reader;
  if (isAddress(handleOrWallet)) {
    const wallet = getAddress(handleOrWallet);
    const handle = await reader.handleOf(wallet);
    if (!handle) return { wallet, handle: null };
    return { wallet, handle, provedAtMs: Number(await reader.lastProofAt(handleKey(handle))) };
  }
  const wallet = await reader.walletOf(handleOrWallet);
  if (wallet === ZeroAddress) return { wallet: null, handle: handleOrWallet };
  const [handle, provedAtMs] = await Promise.all([reader.handleOf(wallet), reader.lastProofAt(handleKey(handleOrWallet))]);
  return { wallet, handle, provedAtMs: Number(provedAtMs) };
}

async function refreshStats() {
  if (!state.reader) return;
  try {
    $("stat-count").textContent = (await state.reader.linkedCount()).toString();
  } catch (err) {
    console.warn("linkedCount failed", err);
  }
}

async function refreshRecent() {
  if (!state.reader) return;
  const button = $("recent-refresh");
  button.classList.add("spin");
  try {
    const records = await state.reader.recentLinks(30);
    // Keep the newest record per wallet, and only links that are still current.
    const seen = new Set();
    const newest = records.filter((r) => !seen.has(r.wallet) && seen.add(r.wallet));
    const current = await Promise.all(newest.map((r) => state.reader.handleOf(r.wallet)));
    const live = newest.filter((r, i) => current[i].toLowerCase() === r.handle.toLowerCase()).slice(0, 8);

    $("recent-list").replaceChildren(
      ...live.map((r) =>
        el(
          "li",
          {},
          avatar(r.handle),
          el("div", { class: "recent-who" }, el("a", { href: `/?handle=${r.handle}` }, `@${r.handle}`), el("span", {}, short(r.wallet))),
          el("span", { class: "recent-time" }, timeAgo(Number(r.provedAtMs))),
        ),
      ),
    );
    $("recent-empty").hidden = live.length > 0;
  } catch (err) {
    console.warn("recentLinks failed", err);
  } finally {
    button.classList.remove("spin");
  }
}

async function refreshLinked() {
  state.linked = null;
  if (!state.account || !state.reader) return;
  try {
    const link = await readLink(state.account);
    state.linked = link.handle ? link : null;
  } catch (err) {
    console.warn("handleOf failed", err);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderCard() {
  // Profile page shows that handle; otherwise the connected wallet's link, otherwise an example.
  let link = null;
  let mode = "example";
  if (PROFILE_HANDLE) {
    link = state.profile ?? { handle: PROFILE_HANDLE };
    mode = state.profile?.wallet ? "verified" : state.profile ? "missing" : "loading";
  } else if (state.linked) {
    link = state.linked;
    mode = "verified";
  }

  const card = $("proof-card");
  card.classList.toggle("example", mode === "example" || mode === "loading" || mode === "missing");

  const status = $("pc-status");
  status.className = `pc-status ${mode === "verified" ? "ok" : mode === "missing" ? "none" : ""}`;
  status.textContent = { verified: "Verified onchain", missing: "No seal yet", loading: "Checking…", example: "Example" }[mode];

  const handle = link?.handle ?? null;
  $("pc-avatar").textContent = handle ? handle[0] : "?";
  $("pc-handle").textContent = handle ? `@${handle}` : "@your_handle";
  $("pc-wallet").textContent = link?.wallet ? link.wallet : mode === "missing" ? "No wallet yet" : "0x0000…0000";
  $("pc-date").textContent = link?.provedAtMs ? formatDate(link.provedAtMs) : "Not yet";
  $("pc-network").textContent = state.config?.chain.name ?? "…";

  $("pc-actions").hidden = mode !== "verified";
  if (mode === "verified") {
    $("pc-share").href = shareUrl(link.handle);
    const explorer = explorerUrl("address", link.wallet);
    $("pc-explorer").hidden = !explorer;
    if (explorer) $("pc-explorer").href = explorer;
  }
}

function renderHero() {
  if (!PROFILE_HANDLE) return;
  const verified = Boolean(state.profile?.wallet);
  const checking = !state.profile;
  const name = state.profile?.handle || PROFILE_HANDLE;
  document.title = `@${name} on HandleSeal`;
  $("hero-eyebrow").textContent = verified ? "Verified profile" : "Profile";
  $("hero-title").replaceChildren(
    `@${name} `,
    el("span", { class: "accent" }, checking ? "…" : verified ? "is verified" : "is not sealed yet"),
  );
  $("hero-lede").textContent = checking
    ? "Checking the registry…"
    : verified
      ? `This wallet was sealed to @${name} with a Primus zkTLS proof. The handle came straight from x.com, and the contract checked the proof before saving it`
      : `Nobody has proven @${name} yet. If this is your account, you can seal it to your wallet in three steps`;
  $("hero-cta").replaceChildren(el("a", { class: "btn", href: "/#link" }, "Seal your own X handle"), el("a", { class: "btn btn-ghost", href: "/" }, "Home"));
}

function render() {
  const { config, account, onRightChain, attestation, linked, busy } = state;
  const connected = Boolean(account && onRightChain);

  $("connect").textContent = account ? short(account) : "Connect wallet";
  $("connect-step").textContent = account && !onRightChain ? `Switch to ${config?.chain.name}` : "Connect wallet";
  $("connect-step").hidden = connected;
  $("fund").hidden = !(connected && config?.chain.id === 31337);

  $("network").hidden = !config;
  $("network").classList.toggle("wrong", Boolean(account && !onRightChain));
  $("network-name").textContent = config?.chain.name ?? "";

  $("prove").disabled = !connected || busy || !config?.registry;
  $("save").disabled = !connected || busy || !attestation;

  const savedAndIdle = connected && Boolean(linked) && !attestation;
  $("step-1").className = `step ${connected ? "done" : "active"}`;
  $("step-2").className = `step ${attestation || savedAndIdle ? "done" : connected ? "active" : ""}`;
  $("step-3").className = `step ${savedAndIdle ? "done" : attestation ? "active" : ""}`;

  $("linked").hidden = !(connected && linked);
  $("linked-handle").textContent = linked ? `@${linked.handle}` : "";
  $("unlink").disabled = busy;

  renderCard();
  renderHero();
}

function renderContracts() {
  const { config } = state;
  const rows = [
    ["Network", config.chain.name],
    ["Registry", config.registry],
    ["Primus verifier", config.verifier && `${config.verifier}${config.officialVerifier ? " (official)" : " (demo copy)"}`],
    ["Template", config.templateId],
  ];
  $("contracts").replaceChildren(
    ...rows
      .filter(([, value]) => value)
      .flatMap(([label, value]) => {
        const addr = value.split(" ")[0];
        const href = isAddress(addr) ? explorerUrl("address", addr) : null;
        return [el("dt", {}, label), el("dd", {}, href ? el("a", { href, target: "_blank", rel: "noreferrer" }, value) : value)];
      }),
  );
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

function isUserRejection(err) {
  const codes = [err?.code, err?.data?.originalError?.code, err?.error?.code];
  return codes.includes(4001) || codes.includes("ACTION_REJECTED");
}

async function ensureChain() {
  const { chain } = state.config;
  const chainId = `0x${chain.id.toString(16)}`;
  const switchChain = () => window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  try {
    await switchChain();
  } catch (err) {
    // Wallets report an unknown chain with different codes (4902, -32603, ...), so add it on any error
    // except the user saying no.
    if (isUserRejection(err)) throw err;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: chain.name,
          rpcUrls: [chain.rpcUrl],
          nativeCurrency: chain.currency,
          blockExplorerUrls: chain.explorer ? [chain.explorer] : undefined,
        },
      ],
    });
    // Some wallets add the network without switching to it.
    await switchChain();
  }
}

async function syncWallet() {
  if (!window.ethereum) return;
  const provider = new BrowserProvider(window.ethereum);
  const accounts = await provider.send("eth_accounts", []);
  const network = await provider.getNetwork();
  const account = accounts[0] ? getAddress(accounts[0]) : null;

  if (account !== state.account) {
    state.attestation = null;
    state.provenHandle = null;
    setStatus("status-2", primusHint());
    setStatus("status-3", "");
  }
  state.account = account;
  state.onRightChain = Number(network.chainId) === state.config.chain.id;
  state.signer = account && state.onRightChain ? await provider.getSigner(account) : null;

  if (account && !state.onRightChain) setStatus("status-1", `Your wallet is on another network. Switch to ${state.config.chain.name}`, "err");
  else if (account) setStatus("status-1", `Connected as ${short(account)}`, "ok");
  else setStatus("status-1", "");

  await refreshLinked();
  render();
}

async function connect() {
  if (!window.ethereum) {
    setStatus("status-1", "No browser wallet found. Install MetaMask or another EVM wallet, then reload", "err");
    return;
  }
  try {
    setStatus("status-1", "Waiting for your wallet…", "busy");
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await ensureChain();
    await syncWallet();
  } catch (err) {
    setStatus("status-1", explain(err), "err");
  }
}

async function fundLocal() {
  try {
    setStatus("status-1", "Sending 1 test ETH…", "busy");
    await api("/api/dev/fund", { address: state.account });
    setStatus("status-1", `Sent 1 test ETH to ${short(state.account)}`, "ok");
  } catch (err) {
    setStatus("status-1", explain(err), "err");
  }
}

// ---------------------------------------------------------------------------
// Proof and transactions
// ---------------------------------------------------------------------------

function primusHint() {
  if (window.primus) return "";
  if (IS_MOBILE) return "Proofs need desktop Chrome or Edge with the Primus extension";
  return ["Primus extension not found. ", el("a", { href: INSTALL_URL, target: "_blank", rel: "noreferrer" }, "Install it"), ", then reload this page"];
}

async function prove() {
  state.busy = true;
  state.attestation = null;
  render();
  setStatus("status-3", "");
  try {
    if (!state.primusReady) {
      setStatus("status-2", "Connecting to the Primus extension…", "busy");
      await state.primus.init(state.config.appId);
      state.primusReady = true;
    }

    setStatus("status-2", "Preparing the proof request…", "busy");
    const request = state.primus.generateRequestParams(state.config.templateId, state.account);
    request.setAttMode({ algorithmType: "proxytls" });
    request.setCloseDataSourceOnProofComplete(true);
    const { signResult } = await api("/api/sign", { signParams: request.toJsonString() });

    setStatus("status-2", "Building the proof. Finish any steps in the X tab the extension opens…", "busy");
    const attestation = await state.primus.startAttestation(signResult);

    if (!state.primus.verifyAttestation(attestation)) throw new Error("The proof signature did not check out");
    if (getAddress(attestation.recipient) !== state.account) throw new Error("The proof was made for a different wallet");

    const handle = JSON.parse(attestation.data).screen_name;
    state.attestation = attestation;
    state.provenHandle = handle;
    setStatus("status-2", `Proved you own @${handle}`, "ok");
    setStatus("status-3", "Ready. Send one transaction to save the link");
  } catch (err) {
    setStatus("status-2", explain(err), "err");
  } finally {
    state.busy = false;
    render();
  }
}

async function save() {
  state.busy = true;
  render();
  try {
    const registry = new Contract(state.config.registry, REGISTRY_ABI, state.signer);
    const attestation = toAttestationStruct(state.attestation);

    setStatus("status-3", "Checking the proof against the contract…", "busy");
    await registry.register.staticCall(attestation); // surfaces contract errors before paying gas

    setStatus("status-3", "Confirm the transaction in your wallet…", "busy");
    const tx = await registry.register(attestation);
    setStatus("status-3", "Waiting for the transaction to be mined…", "busy");
    await tx.wait();

    const txUrl = explorerUrl("tx", tx.hash);
    setStatus(
      "status-3",
      [`Sealed: @${state.provenHandle} is linked to ${short(state.account)}`, txUrl && " · ", txUrl && el("a", { href: txUrl, target: "_blank", rel: "noreferrer" }, "View transaction")],
      "ok",
    );
    state.attestation = null;
    toast("Seal saved onchain");
    await Promise.all([refreshLinked(), refreshStats(), refreshRecent()]);
  } catch (err) {
    setStatus("status-3", explain(err), "err");
  } finally {
    state.busy = false;
    render();
  }
}

async function unlink() {
  state.busy = true;
  render();
  try {
    const registry = new Contract(state.config.registry, REGISTRY_ABI, state.signer);
    const tx = await registry.unlink();
    await tx.wait();
    setStatus("status-3", "Link removed", "ok");
    await Promise.all([refreshLinked(), refreshStats(), refreshRecent()]);
  } catch (err) {
    setStatus("status-3", explain(err), "err");
  } finally {
    state.busy = false;
    render();
  }
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function lookupResult(...children) {
  $("lookup-result").replaceChildren(...children.map(noDot));
}

async function lookup(event) {
  event.preventDefault();
  const query = $("lookup-input").value.trim().replace(/^@/, "");
  if (!query) return;
  if (!state.reader) return lookupResult(el("p", { class: "err" }, "No contract deployed on this network yet"));
  if (!isAddress(query) && !HANDLE_RE.test(query)) return lookupResult(el("p", { class: "err" }, "That is not a valid X handle or wallet address"));

  lookupResult(el("p", { class: "status busy" }, "Looking up…"));
  try {
    const link = await readLink(query);
    if (!link.wallet || !link.handle) {
      return lookupResult(
        el("p", { class: "miss" }, isAddress(query) ? `${short(getAddress(query))} is not linked to any handle` : `@${query} is not linked to any wallet`),
      );
    }
    lookupResult(
      el(
        "div",
        { class: "hit" },
        avatar(link.handle),
        el(
          "div",
          { class: "recent-who" },
          el("a", { href: `/?handle=${link.handle}` }, `@${link.handle}`),
          el("span", {}, `${short(link.wallet)} · proved ${formatDate(link.provedAtMs)}`),
        ),
      ),
    );
  } catch (err) {
    lookupResult(el("p", { class: "err" }, explain(err)));
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function loadProfile() {
  if (!PROFILE_HANDLE || !state.reader) return;
  try {
    state.profile = await readLink(PROFILE_HANDLE);
  } catch (err) {
    console.warn("profile lookup failed", err);
    state.profile = { handle: PROFILE_HANDLE, wallet: null };
  }
  render();
}

async function start() {
  $("connect").addEventListener("click", connect);
  $("connect-step").addEventListener("click", connect);
  $("fund").addEventListener("click", fundLocal);
  $("prove").addEventListener("click", prove);
  $("save").addEventListener("click", save);
  $("unlink").addEventListener("click", unlink);
  $("lookup-form").addEventListener("submit", lookup);
  $("recent-refresh").addEventListener("click", refreshRecent);
  $("pc-copy").addEventListener("click", async () => {
    const handle = PROFILE_HANDLE ? state.profile?.handle : state.linked?.handle;
    if (!handle) return;
    await navigator.clipboard.writeText(profileUrl(handle));
    toast("Profile link copied");
  });

  render();
  try {
    state.config = await api("/api/config");
  } catch (err) {
    showBanner(`Could not reach the app server. Start it with "npm run dev". (${err.message})`);
    return;
  }

  $("stat-network").textContent = state.config.chain.name;
  $("stat-age").textContent = formatAge(state.config.maxProofAge);
  if (state.config.sourceUrl) {
    $("source-link").href = state.config.sourceUrl;
    $("source-link").hidden = false;
  }
  renderContracts();

  if (state.config.registry) {
    const provider = new JsonRpcProvider(state.config.chain.rpcUrl, state.config.chain.id, { staticNetwork: true });
    state.reader = new Contract(state.config.registry, REGISTRY_ABI, provider);
  } else {
    showBanner(`No contract is deployed on ${state.config.chain.name} yet. Run the deploy script, then reload`);
  }

  // The extension injects window.primus shortly after load.
  setTimeout(() => {
    if (!state.busy && !state.attestation) setStatus("status-2", primusHint());
  }, 1200);

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", () => syncWallet().catch(console.error));
    window.ethereum.on?.("chainChanged", () => syncWallet().catch(console.error));
  }
  await Promise.all([syncWallet().catch(console.error), loadProfile(), refreshStats(), refreshRecent()]);
  render();
}

start();
