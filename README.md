<p align="center"><img src="web/public/logo.svg" width="96" height="96" alt="HandleSeal logo"></p>

# HandleSeal

Seal your X handle to your wallet. Prove you own the account with [Primus](https://primuslabs.xyz) zkTLS and
record the link onchain in the `XWalletRegistry` contract.

Anyone can type "my X is @someone" next to a wallet address. This app makes that claim checkable. The
Primus extension reads your handle from X inside your own browser and turns it into a proof signed by a
Primus attestor. A smart contract checks the proof and records which wallet owns which handle. Other apps
can read the registry, for example to stop fake accounts in a giveaway or to send funds to an X handle.

No password and no OAuth app are involved. The proof is bound to one wallet, so nobody else can reuse it.
In a real proof saved by this app, the request header and body are empty and the only data revealed is
`screen_name`, so no cookies or session data end up onchain.

HandleSeal is a community project built on Primus zkTLS. Not an official Primus product.

## How it works

```
 Browser (web/)                      App server (server/)            Chain (contracts/)
 ─────────────────────────────       ─────────────────────           ───────────────────────────
 1. generateRequestParams(          2. POST /api/sign
    X template, wallet)       ───▶     checks appId, template,
                                        wallet, then signs with
                              ◀───      PRIMUS_APP_SECRET
 3. startAttestation()
    Primus extension + attestor
    prove screen_name from
    api.x.com/1.1/account/settings.json
 4. register(attestation)  ─────────────────────────────────────▶   XWalletRegistry
                                                                      ├ Primus verifier: attestor signature
                                                                      ├ recipient == msg.sender
                                                                      ├ proof age <= 1 hour
                                                                      ├ URL and field are the X template's
                                                                      ├ handle is 1 to 15 of [A-Za-z0-9_]
                                                                      └ newer than the last proof for it
```

The Primus verifier contract only checks that a trusted attestor signed the attestation. It does not check
who the proof is for, how old it is or what it says, so `XWalletRegistry` does that itself:

| Check | Stops |
| --- | --- |
| `recipient == msg.sender` | someone submitting a proof made for another wallet |
| proof age at most `maxProofAge` (1 hour) | old proofs being replayed later |
| request URL is `api.x.com/1.1/account/settings.json` and the only field is `$.screen_name` | proofs from other templates or sites |
| handle matches X's rules (1 to 15 of `A-Z a-z 0-9 _`) | hashed or malformed values |
| proof is newer than the last accepted one for that handle | an old owner taking a handle back after it changed hands |

Handles are matched without case, so `@Primus_Labs` and `@primus_labs` are the same.

## Project layout

```
contracts/          Foundry project
  src/XWalletRegistry.sol
  test/XWalletRegistry.t.sol   20 tests against the real Primus verifier code
  script/Deploy.s.sol          writes contracts/deployments/<chainId>.json
server/core.js      request signing (same output as the SDK sign) and config, shared by both servers
server/index.js     local Express server
api/                the same endpoints as Vercel functions
web/                Vite web app (plain JS, ethers v6, @primuslabs/zktls-js-sdk)
test/e2e-local.js   SDK encoding vs onchain encoding, full register flow on Anvil
```

The site has a public profile for every handle at `/?handle=name`, a "Recently sealed" timeline read from
the contract (`recentLinks`), a lookup by handle or wallet, and a Share on X button after sealing. It also shows X
names, pictures and bios from the free [FxTwitter](https://github.com/FxEmbed/FxEmbed) API, with an optional
[twitterapi.io](https://twitterapi.io) key (`TWITTER_API_KEY`, server side only) as a fallback. That data is for
display only and is cached for 6 hours; the seal depends only on the proof.

## Run it locally

You need Node 22.9 or later, [Foundry](https://book.getfoundry.sh/getting-started/installation), Chrome with
the [Primus extension](https://chromewebstore.google.com/detail/pado/oeiomhmbaapihbilkfkhmlajkeegnjhe) and a
browser wallet such as MetaMask, and you must be logged in to x.com in that browser.

1. In the [Primus Developer Hub](https://dev.primuslabs.xyz), create a **DApp** project and copy its
   `appId` and `appSecret`. The template used is the public "X Account Ownership" template
   (`2e3160ae-8b1e-45e3-8c59-426366278b9d`).
2. Install and configure:

   ```bash
   npm install
   cp .env.example .env   # then fill in PRIMUS_APP_ID and PRIMUS_APP_SECRET
   ```

3. Start everything (local chain, contracts, API and web app):

   ```bash
   npm run dev
   ```

4. Open http://localhost:5173, connect your wallet (the app adds the "Local Anvil" network), press
   **Get 1 test ETH**, then **Prove my X account** and **Save link onchain**.

## Deploy to BNB Smart Chain Testnet

1. Put the private key of a fresh wallet made only for this demo in `DEPLOYER_PRIVATE_KEY` in `.env`, and
   fund it with test BNB from the [BNB Chain faucet](https://www.bnbchain.org/en/testnet-faucet).
2. Deploy, then point the app at the testnet:

   ```bash
   npm run deploy:bsc-testnet
   ```

   Set `CHAIN_ID=97` in `.env` and run `npm run dev` again. The deployed addresses are in
   `contracts/deployments/97.json`; commit that file so the hosted site can read it.

## Host on Vercel

1. Push the repo to GitHub and import it in Vercel. `vercel.json` already sets the build and the `api/`
   functions.
2. In the Vercel project settings add the environment variables `PRIMUS_APP_ID`, `PRIMUS_APP_SECRET` and,
   optionally, `SOURCE_URL` (your GitHub repo URL) and `TWITTER_API_KEY`. `CHAIN_ID` defaults to 97 on Vercel.
3. Deploy. If the Primus extension reports that the dApp is not registered (error `00009`), ask the Primus
   team to add your domain to the allowlist for your appId. Local development does not need this.

## Tests

```bash
npm run test:contracts   # Foundry unit tests
npm run test:sign        # server signing matches PrimusZKTLS.sign() from the SDK
npm run test:e2e         # needs Anvil running: npm run chain
```

## Note on Primus testnet verifiers

Found while building this, checked on Nov 11, 2026 with `_attestors(uint256)` and `verifyAttestation` through
`eth_call`:

- `@primuslabs/zktls-js-sdk` 0.3.15 verifies attestations against attestor
  `0x5Ed3176045F68617B0958a61ac1868875C98C14d` (`PADOADDRESSMAP.production` in `dist/config/constants.js`).
  A real attestation from the X template, made through this app, is signed by that attestor.
- The BNB Chain mainnet verifier `0xF3C20A5216d669C521ffe3724C1439aE0897aC33` trusts that attestor and accepts
  the attestation.
- Every testnet verifier listed on the [Onchain Interaction](https://docs.primuslabs.xyz/enterprise/onchain-interaction/overview)
  page that answered rejects it with `Invalid signature`, because they only trust
  `0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6`:

  | Testnet | Verifier |
  | --- | --- |
  | BNB Chain Testnet | `0xBc074EbE6D39A97Fb35726832300a950e2D94324` |
  | Sepolia, opBNB Testnet | `0x3760aB354507a29a9F5c65A66C74353fd86393FA` |
  | Base Sepolia, Unichain Sepolia, X Layer Testnet | `0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE` |

  The newer BNB testnet deployment from the contracts repo broadcast files,
  `0x4620362a803f82b7231b18e09abc5d400a7891fb`, rejects it too.
- The Monad Testnet address in the docs, `0x1Ad7fD53206fDc3979C672C0466A1c48AF47B431`, has no contract code.
- The [Supported Networks](https://docs.primuslabs.xyz/enterprise/zk-tls-sdk/solidity/support) page lists
  `0x0000` for every network, and the zktls-contracts README links to a docs URL that no longer exists.

So on testnets and on Anvil, `Deploy.s.sol` deploys its own copy of the Primus verifier (the code from
`@primuslabs/zktls-contracts`) that trusts only the SDK attestor. On BNB Chain mainnet it uses the official
verifier.

## License

MIT
