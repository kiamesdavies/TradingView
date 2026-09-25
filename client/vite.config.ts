import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// EODVIEW_API_PORT points the dev proxy at a server on another port (default 3001).
const api = `localhost:${process.env.EODVIEW_API_PORT ?? 3001}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": `http://${api}`,
      "/ws": { target: `ws://${api}`, ws: true },
    },
  },
  build: { outDir: "dist" },
});
