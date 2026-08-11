import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The demo is reached through a reverse proxy at maestro.cyrn.fr, so the
    // dev server has to accept a Host header it did not generate itself.
    allowedHosts: ["maestro.cyrn.fr", "localhost"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
