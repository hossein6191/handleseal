import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  // The Primus SDK bundles ethers v5 and Solana helpers, so the bundle is large.
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  server: {
    port: 5173,
    proxy: { "/api": process.env.API_URL || "http://localhost:8787" },
  },
});
