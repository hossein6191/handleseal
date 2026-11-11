import { PrimusZKTLS } from "@primuslabs/zktls-js-sdk";
import { BrowserProvider, Contract, JsonRpcProvider, ZeroAddress, getAddress, isAddress, keccak256, toUtf8Bytes } from "ethers";
import { REGISTRY_ABI, toAttestationStruct } from "./registry-abi.js";
import { initEffects, renderBeams } from "./effects.js";

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
  recent: [], // live seals, newest first
  primus: new PrimusZKTLS(),
  primusReady: false,
  busy: false,
  disconnected: false,
  rpc: null, // read-only provider for the configured chain
  balance: null, // native balance of the connected wallet, as a bigint
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const short = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
const handleKey = (handle) => keccak256(toUtf8Bytes(handle.toLowerCase()));
const formatDate = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const formatCount = (n) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);

function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  for (const [name, size] of [
    ["day", 86400],
    ["hour", 3600],
    ["min", 60],
  ]) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n > 1 && name !== "min" ? "s" : ""} ago`;
    }
  }
  return "just now";
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
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

// ---------------------------------------------------------------------------
// X profiles (display only, loaded through the app server and cached)
// ---------------------------------------------------------------------------

const profiles = new Map();
function getProfile(handle) {
  if (!handle) return Promise.resolve(null);
  const key = handle.toLowerCase();
  if (!profiles.has(key)) {
    profiles.set(
      key,
      fetch(`/api/x-profile?handle=${encodeURIComponent(handle)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => (p?.available ? p : null))
        .catch(() => null),
    );
  }
  return profiles.get(key);
}

/// Fills an .avatar element with the X picture when there is one, otherwise the first letter.
function paintAvatar(node, handle) {
  node.replaceChildren(handle ? handle[0] : "?");
  node.classList.toggle("empty", !handle);
  if (!handle) return;
  getProfile(handle).then((p) => {
    if (node.dataset.for !== handle.toLowerCase()) return;
    // Picture from the profile service, or from unavatar.io when the service had no answer.
    const src = p?.avatar || `https://unavatar.io/x/${encodeURIComponent(handle)}?fallback=false`;
    const img = el("img", { src, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    img.onerror = () => img.remove();
    node.append(img);
  });
  node.dataset.for = handle.toLowerCase();
}

function avatar(handle) {
  const node = el("div", { class: "avatar" });
  paintAvatar(node, handle);
  return node;
}

// ---------------------------------------------------------------------------
// Status lines, banner, toast
// ---------------------------------------------------------------------------

const noDot = (text) => (typeof text === "string" ? text.replace(/(?<!\.)\.$/, "") : text);

function setStatus(id, content, kind = "") {
  const node = $(id);
  content = Array.isArray(content) ? content.map(noDot) : noDot(content);
  node.className = `status ${kind}`;
  node.replaceChildren(...(Array.isArray(content) ? content : [content]).filter((c) => c != null && c !== false));
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
  NotLinked: "This wallet is not sealed to any handle",
};

function explain(err) {
  console.error(err);
  if (!err) return "Something went wrong";
  // Primus SDK errors carry a numeric code and a readable message.
  if (typeof err.code === "string" && /^-?\d/.test(err.code) && err.message) {
    return `${noDot(err.message)} (code ${err.code}${err.subCode ? `:${err.subCode}` : ""})`;
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
    const [count, proofs] = await Promise.all([state.reader.linkedCount(), state.reader.historyLength()]);
    $("stat-count").textContent = count.toString();
    $("stat-proofs").textContent = proofs.toString();
  } catch (err) {
    console.warn("stats failed", err);
  }
}

async function refreshRecent() {
  if (!state.reader) return;
  const button = $("recent-refresh");
  button.classList.add("spin");
  try {
    const records = await state.reader.recentLinks(30);
    // Keep the newest record per wallet, and only seals that are still current.
    const seen = new Set();
    const newest = records.filter((r) => !seen.has(r.wallet) && seen.add(r.wallet));
    const current = await Promise.all(newest.map((r) => state.reader.handleOf(r.wallet)));
    state.recent = newest
      .filter((r, i) => current[i].toLowerCase() === r.handle.toLowerCase())
      .map((r) => ({ handle: r.handle, wallet: r.wallet, provedAtMs: Number(r.provedAtMs) }));
    renderRecent();
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

function renderRecent() {
  const live = state.recent.slice(0, 8);

  $("recent-list").replaceChildren(
    ...live.map((r) =>
      el(
        "li",
        {},
        avatar(r.handle),
        el(
          "p",
          { class: "tl-text" },
          el("a", { href: `/?handle=${r.handle}` }, `@${r.handle}`),
          " sealed to ",
          el("span", { class: "mono" }, short(r.wallet)),
          el("small", {}, timeAgo(r.provedAtMs)),
        ),
        el("a", { class: "tl-go", href: `/?handle=${r.handle}`, "aria-label": `Open @${r.handle}` }, "→"),
      ),
    ),
  );
  $("recent-empty").hidden = live.length > 0;

  // Floating cards around the hero card
  $("hero-floats").replaceChildren(
    ...live
      .slice(0, 2)
      .map((r) => el("div", { class: "float-card" }, avatar(r.handle), el("div", {}, el("b", {}, `@${r.handle}`), el("small", {}, `sealed ${timeAgo(r.provedAtMs)}`)))),
  );

  // Marquee: live seals first, then a few words so the strip is never empty
  const words = ["zkTLS proofs", "Primus attestors", "No passwords", "No OAuth", "Checked onchain", "Open source"];
  const items = [
    ...state.recent.slice(0, 12).map((r) => el("a", { class: "mq-item", href: `/?handle=${r.handle}` }, avatar(r.handle), `@${r.handle}`, el("span", {}, "sealed"))),
    ...words.map((w) => el("span", { class: "mq-word" }, w)),
  ];
  const track = $("marquee-track");
  track.replaceChildren(...items, ...items.map((n) => n.cloneNode(true)));
  track.querySelectorAll(".avatar").forEach((node, i) => {
    if (i >= Math.min(12, state.recent.length)) paintAvatar(node, node.dataset.for); // clones need their picture too
  });
}

async function renderCard() {
  // Profile page shows that handle; otherwise the connected wallet's seal, otherwise an example.
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
  card.classList.toggle("example", mode !== "verified");

  const status = $("pc-status");
  status.className = `pc-status ${mode === "verified" ? "ok" : mode === "missing" ? "none" : ""}`;
  status.textContent = { verified: "Verified onchain", missing: "No seal yet", loading: "Checking…", example: "Example" }[mode];

  const handle = link?.handle ?? null;
  if ($("pc-avatar").dataset.for !== handle?.toLowerCase()) paintAvatar($("pc-avatar"), handle);
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

  // X profile details when the profile service has them
  const p = handle ? await getProfile(handle) : null;
  if ((link?.handle ?? null) !== handle) return; // state changed while loading
  $("pc-sub").textContent = p?.name || "X account";
  $("pc-bio").hidden = !p?.bio;
  $("pc-bio").textContent = p?.bio || "";
  $("pc-third-label").textContent = p ? "Followers" : "Source";
  $("pc-third").textContent = p ? formatCount(p.followers) : "api.x.com";
}

function renderHero() {
  if (!PROFILE_HANDLE) return;
  const verified = Boolean(state.profile?.wallet);
  const checking = !state.profile;
  const name = state.profile?.handle || PROFILE_HANDLE;
  document.title = `@${name} on HandleSeal`;
  $("hero-eyebrow").textContent = verified ? "Verified profile" : "Profile";
  $("hero-title").replaceChildren(`@${name} `, el("span", { class: "accent" }, checking ? "…" : verified ? "is verified" : "is not sealed yet"));
  $("hero-lede").textContent = checking
    ? "Checking the registry…"
    : verified
      ? `This wallet was sealed to @${name} with a Primus zkTLS proof. The handle came straight from x.com, and the contract checked the proof before saving it`
      : `Nobody has proven @${name} yet. If this is your account, you can seal it to your wallet in three steps`;
  $("hero-cta").replaceChildren(el("a", { class: "btn", href: "/#link" }, "Seal your own X handle"), el("a", { class: "btn btn-ghost", href: "/" }, "Home"));
}

function renderStepper(connected, savedAndIdle) {
  const { account, attestation, provenHandle, linked } = state;
  const handle = provenHandle || linked?.handle || null;
  if ($("st-avatar").dataset.for !== handle?.toLowerCase()) paintAvatar($("st-avatar"), handle);
  $("st-handle").textContent = handle ? `@${handle}` : "@your_handle";
  $("st-wallet").textContent = account ? short(account) : "No wallet connected";

  const chip = $("st-chip");
  chip.className = `chip ${attestation ? "ready" : savedAndIdle ? "sealed" : ""}`;
  chip.textContent = attestation ? "Proof ready" : savedAndIdle ? "Sealed" : "Not sealed";

  $("step-1").className = `st-step ${connected ? "done" : "active"}`;
  // After saving, step 2 stays open so a new proof can refresh the seal.
  $("step-2").className = `st-step ${attestation ? "done" : savedAndIdle ? "done active" : connected ? "active" : ""}`;
  $("step-3").className = `st-step ${savedAndIdle ? "done" : attestation ? "active" : ""}`;
  $("prove").textContent = savedAndIdle ? "Make a new proof" : "Prove my X account";
}

function render() {
  const { config, account, onRightChain, attestation, linked, busy } = state;
  const connected = Boolean(account && onRightChain);
  const savedAndIdle = connected && Boolean(linked) && !attestation;

  $("connect").textContent = account ? `${short(account)} ▾` : "Connect wallet";
  if (!account) closeMenu();
  $("connect-step").textContent = account && !onRightChain ? `Switch to ${config?.chain.name}` : "Connect wallet";
  $("connect-step").hidden = connected;
  $("fund").hidden = !(connected && config?.chain.id === 31337);

  $("network").hidden = !config;
  $("network").classList.toggle("wrong", Boolean(account && !onRightChain));
  $("network-name").textContent = config?.chain.name ?? "";

  $("prove").disabled = !connected || busy || !config?.registry;
  $("save").disabled = !connected || busy || !attestation;
  if (connected && config && !config.registry) {
    setStatus("status-2", `Proofs open once the HandleSeal contract is deployed on ${config.chain.name}`);
  }

  renderStepper(connected, savedAndIdle);

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

// Wallets keep the site authorized after "Disconnect", so remember the choice and ignore the
// authorized account until the user connects again.
const DISCONNECTED_KEY = "handleseal:disconnected";
function isDisconnected() {
  try {
    return localStorage.getItem(DISCONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}
function setDisconnected(value) {
  try {
    if (value) localStorage.setItem(DISCONNECTED_KEY, "1");
    else localStorage.removeItem(DISCONNECTED_KEY);
  } catch {
    // storage blocked, the choice only lasts for this page
  }
  state.disconnected = value;
}

/// "Get free tBNB" link for chains that have a faucet.
function faucetLink() {
  const { faucet, currency } = state.config?.chain ?? {};
  return faucet ? el("a", { href: faucet, target: "_blank", rel: "noreferrer" }, `Get free ${currency.symbol}`) : null;
}

const needsGas = () => state.balance === 0n;

async function refreshBalance() {
  state.balance = null;
  if (!state.account || !state.onRightChain || !state.rpc) return;
  try {
    state.balance = await state.rpc.getBalance(state.account);
  } catch (err) {
    console.warn("balance check failed", err);
  }
}

function showWalletStatus() {
  const { account, onRightChain, config } = state;
  if (account && !onRightChain) return setStatus("status-1", `Your wallet is on another network. Switch to ${config.chain.name}`, "err");
  if (!account) return setStatus("status-1", "");
  if (needsGas() && config.chain.faucet) {
    return setStatus(
      "status-1",
      [`Connected as ${short(account)}. It has no ${config.chain.currency.symbol} to pay the small gas fee yet. `, faucetLink(), ", then come back"],
      "warn",
    );
  }
  setStatus("status-1", `Connected as ${short(account)}`, "ok");
}

async function syncWallet() {
  if (!window.ethereum) return;
  const provider = new BrowserProvider(window.ethereum);
  const accounts = state.disconnected ? [] : await provider.send("eth_accounts", []);
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

  await Promise.all([refreshLinked(), refreshBalance()]);
  showWalletStatus();
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
    setDisconnected(false);
    await ensureChain();
    await syncWallet();
  } catch (err) {
    setStatus("status-1", explain(err), "err");
  }
}

async function disconnect() {
  closeMenu();
  setDisconnected(true);
  try {
    // Supported by MetaMask and some other wallets; others simply keep the permission.
    await window.ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
  } catch {
    // not supported, the local flag above is enough
  }
  Object.assign(state, { account: null, signer: null, onRightChain: false, attestation: null, provenHandle: null, linked: null });
  for (const id of ["status-1", "status-2", "status-3"]) setStatus(id, "");
  setStatus("status-2", primusHint());
  render();
  toast("Wallet disconnected");
}

function closeMenu() {
  $("wallet-dropdown").hidden = true;
  $("connect").setAttribute("aria-expanded", "false");
}

function onWalletButton(event) {
  if (!state.account) return connect();
  event.stopPropagation();
  const menu = $("wallet-dropdown");
  const open = menu.hidden;
  menu.hidden = !open;
  $("connect").setAttribute("aria-expanded", String(open));
  if (open) {
    $("menu-address").textContent = state.account;
    const explorer = explorerUrl("address", state.account);
    $("menu-explorer").hidden = !explorer;
    if (explorer) $("menu-explorer").href = explorer;
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
    setStatus("status-3", "Ready. Send one transaction to save the seal");
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

    await refreshBalance();
    if (needsGas() && state.config.chain.faucet) {
      showWalletStatus();
      setStatus("status-3", [`You need a little ${state.config.chain.currency.symbol} for gas. `, faucetLink(), ", then press Save again"], "warn");
      return;
    }

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
    setStatus("status-3", "Seal removed", "ok");
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
    const handle = link.handle || (isAddress(query) ? null : query);
    const p = handle ? await getProfile(handle) : null;
    const sealed = Boolean(link.wallet && link.handle);

    if (!handle) return lookupResult(el("div", { class: "lk-card" }, avatar(null), el("div", { class: "lk-name" }, short(getAddress(query))), el("div", { class: "lk-line" }, "Not sealed to any handle")));

    lookupResult(
      el(
        "div",
        { class: `lk-card ${sealed ? "hit" : ""}` },
        avatar(handle),
        el("div", { class: "lk-name" }, el("a", { href: `/?handle=${handle}` }, `@${handle}`), p?.name && el("small", {}, p.name)),
        el("div", { class: "lk-line" }, sealed ? `Sealed to ${short(link.wallet)} · ${formatDate(link.provedAtMs)}` : "Not sealed to any wallet yet"),
        p?.bio && el("p", { class: "lk-bio" }, p.bio),
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
  state.disconnected = isDisconnected();
  $("connect").addEventListener("click", onWalletButton);
  $("connect-step").addEventListener("click", connect);
  $("menu-disconnect").addEventListener("click", disconnect);
  $("menu-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(state.account);
    closeMenu();
    toast("Address copied");
  });
  $("menu-explorer").addEventListener("click", closeMenu);
  document.addEventListener("click", (e) => {
    if (!$("wallet-dropdown").hidden && !e.target.closest(".wallet-menu")) closeMenu();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
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

  initEffects();
  renderRecent();
  render();

  try {
    state.config = await api("/api/config");
  } catch (err) {
    showBanner(`Could not reach the app server (${err.message})`);
    return;
  }

  $("stat-network").textContent = state.config.chain.name;
  if (state.config.sourceUrl) {
    $("source-link").href = state.config.sourceUrl;
    $("source-link").hidden = false;
  }
  renderContracts();

  state.rpc = new JsonRpcProvider(state.config.chain.rpcUrl, state.config.chain.id, { staticNetwork: true });
  if (state.config.chain.faucet) {
    const faq = $("faq-cost");
    faq.replaceChildren(`One transaction. On ${state.config.chain.name} the gas is paid with free test ${state.config.chain.currency.symbol} from the `, el("a", { href: state.config.chain.faucet, target: "_blank", rel: "noreferrer" }, "BNB Chain faucet"));
  }
  // Coming back from the faucet tab: check the balance again
  addEventListener("focus", async () => {
    if (!state.account || state.busy) return;
    await refreshBalance();
    showWalletStatus();
  });
  if (state.config.registry) {
    state.reader = new Contract(state.config.registry, REGISTRY_ABI, state.rpc);
  } else {
    showBanner(`No contract is deployed on ${state.config.chain.name} yet`);
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
  renderBeams();
}

start();
