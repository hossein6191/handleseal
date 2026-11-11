// Checks that server/core.js signs requests exactly like PrimusZKTLS.sign() from the SDK.
// Run: npm run test:sign
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { PrimusZKTLS } from "@primuslabs/zktls-js-sdk";
import { primusSign } from "../server/core.js";

const appSecret = ethers.Wallet.createRandom().privateKey;
const sdk = new PrimusZKTLS();
await sdk.init("compat-test-app", appSecret);

for (const address of ["0x000000000000000000000000000000000000dEaD", ethers.Wallet.createRandom().address]) {
  const request = sdk.generateRequestParams("2e3160ae-8b1e-45e3-8c59-426366278b9d", address);
  request.setAttMode({ algorithmType: "proxytls" });
  request.setCloseDataSourceOnProofComplete(true);
  const signParams = request.toJsonString();

  assert.equal(await primusSign(appSecret, signParams), await sdk.sign(signParams));
}
console.log("ok  server signing matches PrimusZKTLS.sign()");
