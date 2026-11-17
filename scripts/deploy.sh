#!/bin/sh
# Deploys XWalletRegistry. Usage: sh scripts/deploy.sh <local|bsc_testnet|bsc>
set -e
NETWORK=${1:-local}
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi

case "$NETWORK" in
  local)
    # First funded account of a default Anvil node (public test key, local only)
    DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
    PRIMUS_VERIFIER= ;;
  bsc_testnet)
    # The official testnet verifier does not trust the SDK attestor, so a copy is deployed
    PRIMUS_VERIFIER= ;;
  bsc)
    PRIMUS_VERIFIER=${PRIMUS_VERIFIER:-0xf3c20a5216d669c521ffe3724c1439ae0897ac33} ;;
  *) echo "Unknown network: $NETWORK (use local, bsc_testnet or bsc)"; exit 1 ;;
esac

if [ -z "$DEPLOYER_PRIVATE_KEY" ]; then
  echo "DEPLOYER_PRIVATE_KEY is empty. Add it to .env first."
  exit 1
fi

export DEPLOYER_PRIVATE_KEY PRIMUS_VERIFIER
exec sh scripts/forge.sh script script/Deploy.s.sol --rpc-url "$NETWORK" --broadcast
