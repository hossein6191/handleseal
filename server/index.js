// Local app server for X Wallet Registry (on Vercel the same logic runs from api/).
//  - GET  /api/config    which template, chain and contracts the web app should use
//  - POST /api/sign      signs zkTLS requests with the Primus appSecret (it never reaches the browser)
//  - POST /api/dev/fund  local chain only: sends test ETH from an Anvil account
// With NODE_ENV=production it also serves the built web app from dist/.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { readEnv, readDeployment, getConfig, signRequest, fundLocal, errorResponse } from "./core.js";

let env;
try {
  env = readEnv();
} catch (err) {
  console.error(`${err.message} Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8787);
const app = express();
app.use(express.json({ limit: "16kb" }));

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    const { status, body } = errorResponse(err);
    res.status(status).json(body);
  }
};

app.get("/api/config", handle(() => getConfig()));
app.post("/api/sign", handle((req) => signRequest(req.body?.signParams)));
app.post("/api/dev/fund", handle((req) => fundLocal(req.body?.address)));

if (process.env.NODE_ENV === "production") {
  const dist = path.join(root, "dist");
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(port, () => {
  const { chain } = getConfig();
  console.log(`API on http://localhost:${port}  (chain: ${chain.name})`);
  if (!readDeployment(env.chainId)) console.log(`No contract deployed on chain ${env.chainId} yet. Run the deploy script first.`);
});
