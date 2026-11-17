// Unit tests for the request signing rules in server/core.js (X and GitHub templates).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";

const X_SECRET = ethers.Wallet.createRandom().privateKey;
const GH_SECRET = ethers.Wallet.createRandom().privateKey;
Object.assign(process.env, {
  PRIMUS_APP_ID: "x-app",
  PRIMUS_APP_SECRET: X_SECRET,
  PRIMUS_TEMPLATE_ID: "x-template",
  PRIMUS_GITHUB_APP_ID: "gh-app",
  PRIMUS_GITHUB_APP_SECRET: GH_SECRET,
  PRIMUS_GITHUB_TEMPLATE_ID: "gh-template",
  CHAIN_ID: "97",
});
const { signRequest, primusSign, getConfig } = await import("../../server/core.js");

const user = ethers.Wallet.createRandom().address;
const params = (appId, attTemplateID, over = {}) => JSON.stringify({ appId, attTemplateID, userAddress: user, timestamp: 1, ...over });

test("signs X requests with the X app secret", async () => {
  const p = params("x-app", "x-template");
  assert.equal((await signRequest(p)).signResult, await primusSign(X_SECRET, p));
});

test("signs GitHub requests with the GitHub app secret", async () => {
  const p = params("gh-app", "gh-template");
  assert.equal((await signRequest(p)).signResult, await primusSign(GH_SECRET, p));
});

test("refuses mixed apps and templates, other templates and missing wallets", async () => {
  await assert.rejects(signRequest(params("x-app", "gh-template")), /Wrong appId/);
  await assert.rejects(signRequest(params("gh-app", "x-template")), /Wrong appId/);
  await assert.rejects(signRequest(params("x-app", "other")), /Wrong template/);
  await assert.rejects(signRequest(params("gh-app", "gh-template", { userAddress: ethers.ZeroAddress })), /wallet address/);
  await assert.rejects(signRequest("{"), /not valid JSON/);
});

test("config shows both apps but no secrets", () => {
  const c = getConfig();
  assert.equal(c.appId, "x-app");
  assert.equal(c.github.appId, "gh-app");
  assert.equal(c.github.templateId, "gh-template");
  assert.ok(!JSON.stringify(c).includes(X_SECRET.slice(2)) && !JSON.stringify(c).includes(GH_SECRET.slice(2)));
});
