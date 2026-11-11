<p align="center"><img src="web/public/logo.svg" width="96" height="96" alt="HandleSeal logo"></p>

# HandleSeal

Seal your X handle to your wallet. You prove you own the account with a [Primus](https://primuslabs.xyz)
zkTLS proof made in your own browser, and a smart contract records the link only after checking that proof.
No password and no OAuth app are involved, and the only data revealed onchain is `screen_name`.

HandleSeal is a community project built on Primus zkTLS. Not an official Primus product.

| | |
| --- | --- |
| Live app | [handleseal.vercel.app](https://handleseal.vercel.app) |
| Registry, BNB Smart Chain Testnet | [`0x60D230207363dbE9F008a7460eDeD2984Fb4e320`](https://testnet.bscscan.com/address/0x60D230207363dbE9F008a7460eDeD2984Fb4e320) |
| Primus verifier copy, same network | [`0x980201a11a460bE5213d75b708200C9A79BEf35B`](https://testnet.bscscan.com/address/0x980201a11a460bE5213d75b708200C9A79BEf35B) |

## How it works

1. The web app builds a proof request for the public "X Account Ownership" template with
   `@primuslabs/zktls-js-sdk`, and the app server signs it with the `appSecret`.
2. The Primus extension runs a zkTLS session with `api.x.com/1.1/account/settings.json` and a Primus
   attestor, which signs that the `screen_name` really came from X.
3. The wallet sends the attestation to `XWalletRegistry`, which asks the Primus verifier to check the
   attestor signature and then applies its own checks.
4. Any app can read the result with `walletOf(handle)` and `handleOf(wallet)`.

## What the contract checks

| Check | Stops |
| --- | --- |
| Signed by a trusted Primus attestor | forged or edited proofs |
| `recipient` equals the sending wallet | someone reusing another wallet's proof |
| Proof is at most 1 hour old | old proofs replayed later |
| Data came from the X settings API, field `$.screen_name` only | proofs from other templates or sites |
| Handle is 1 to 15 characters of `A-Z a-z 0-9 _` | hashed or malformed values |
| Newer than the last proof for that handle | a previous owner taking a handle back |

## Run it locally

Needs Node 22.9+, [Foundry](https://book.getfoundry.sh/getting-started/installation), Chrome with the
[Primus extension](https://chromewebstore.google.com/detail/pado/oeiomhmbaapihbilkfkhmlajkeegnjhe) and a
browser wallet.

```bash
npm install
cp .env.example .env   # add PRIMUS_APP_ID and PRIMUS_APP_SECRET from a DApp project in the Primus Developer Hub
npm run dev            # local chain, contracts, API and web app on http://localhost:5173
```

## Tests

```bash
npm run test:contracts   # 20 Foundry tests against the real Primus verifier code
npm run test:sign        # server signing matches PrimusZKTLS.sign()
npm run test:e2e         # SDK encoding matches onchain encoding; needs Anvil running (npm run chain)
```

## Note on Primus testnet verifiers

`@primuslabs/zktls-js-sdk` 0.3.15 switched its attestor from `0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6`
(used up to 0.3.14) to `0x5Ed3176045F68617B0958a61ac1868875C98C14d`. The BNB Chain mainnet verifier
`0xF3C20A5216d669C521ffe3724C1439aE0897aC33` trusts the new attestor, but the testnet verifiers listed on the
[Onchain Interaction](https://docs.primuslabs.xyz/enterprise/onchain-interaction/overview) page still trust only
the old one, so attestations from the current SDK fail with `Invalid signature` there (checked Nov 11, 2026):

| Testnet | Verifier |
| --- | --- |
| BNB Chain Testnet | `0xBc074EbE6D39A97Fb35726832300a950e2D94324` |
| Sepolia, opBNB Testnet | `0x3760aB354507a29a9F5c65A66C74353fd86393FA` |
| Base Sepolia, Unichain Sepolia, X Layer Testnet | `0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE` |

That is why, on testnets, `Deploy.s.sol` deploys a copy of the Primus verifier code from
`@primuslabs/zktls-contracts` that trusts only the SDK attestor. On BNB Chain mainnet it uses the official
verifier.

## License

MIT
