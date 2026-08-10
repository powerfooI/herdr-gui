import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the web app talks to the bridge through Vite's proxy so the
// frontend can use a relative /ws URL (same origin, no hardcoded port).
export default defineConfig({
  plugins: [react()],
  build: {
    // Build straight into the server's static dir so the backend can serve it.
    outDir: "../server/public",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "http://127.0.0.1:8787", ws: true },
      "/api": { target: "http://127.0.0.1:8787" },
      // Let an unauthenticated dev client reach the bridge login page instead
      // of repeatedly loading the Vite SPA at /login and redirecting again.
      "/login": { target: "http://127.0.0.1:8787" },
    },
  },
});
