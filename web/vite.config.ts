import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 4567,
    proxy: {
      "/api": "http://localhost:14567",
      "/ws": {
        target: "ws://localhost:14567",
        ws: true,
      },
    },
  },
});
