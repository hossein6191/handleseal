// One command for local development:
//  - on the local chain (CHAIN_ID=31337, the default) it starts Anvil if needed and deploys the contracts
//  - then it starts the API server and the Vite dev server. Ctrl+C stops everything.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const chainId = Number(process.env.CHAIN_ID || 31337);
const procs = [];

const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function anvilIsUp() {
  try {
    const res = await fetch("http://127.0.0.1:8545", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

if (chainId === 31337) {
  if (!(await anvilIsUp())) {
    console.log("Starting Anvil on port 8545…");
    // Mine a block every 2 seconds like a real chain. Without it the latest block can be minutes old
    // and the registry rejects fresh proofs as coming from the future.
    procs.push(spawn("anvil", ["--silent", "--block-time", "2"], { stdio: "inherit" }));
    for (let i = 0; i < 50 && !(await anvilIsUp()); i++) await new Promise((r) => setTimeout(r, 200));
  }
  console.log("Deploying contracts to the local chain…");
  const deploy = spawnSync("sh", ["scripts/deploy.sh", "local"], { stdio: ["ignore", "ignore", "inherit"] });
  if (deploy.status !== 0) {
    console.error("Local deploy failed.");
    stop();
    process.exit(1);
  }
}

procs.push(spawn(process.execPath, ["--env-file-if-exists=.env", "server/index.js"], { stdio: "inherit" }));
procs.push(spawn("npx", ["vite"], { stdio: "inherit" }));
procs.forEach((p) =>
  p.on("exit", (code) => {
    if (code) {
      stop();
      process.exitCode = code;
    }
  }),
);
