import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies the API to a locally running exact-server.
const backend = process.env.EXACT_BACKEND ?? "http://127.0.0.1:8002";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": backend, "/health": backend } },
  build: { sourcemap: true, chunkSizeWarningLimit: 900 },
});
