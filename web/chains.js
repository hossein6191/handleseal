// Networks the app can run on. Shared by the server and the web app.
export const CHAINS = {
  31337: {
    id: 31337,
    name: "Local Anvil",
    rpcUrl: "http://127.0.0.1:8545",
    explorer: null,
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
  97: {
    id: 97,
    name: "BNB Smart Chain Testnet",
    rpcUrl: "https://bsc-testnet-rpc.publicnode.com",
    explorer: "https://testnet.bscscan.com",
    currency: { name: "Test BNB", symbol: "tBNB", decimals: 18 },
  },
  56: {
    id: 56,
    name: "BNB Smart Chain",
    rpcUrl: "https://bsc-rpc.publicnode.com",
    explorer: "https://bscscan.com",
    currency: { name: "BNB", symbol: "BNB", decimals: 18 },
  },
};
