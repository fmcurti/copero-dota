import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  // El Copero's home port. Without a preference the port drifts with launch
  // order (other long-running apps live on 5173/5174), and a stale tab on
  // the wrong port silently talks to the wrong server.
  server: { port: 5175 },
});
