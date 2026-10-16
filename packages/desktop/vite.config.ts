import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri loads this dev server in its window (tauri.conf.json devUrl); the API is a separate local process.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", outDir: "dist" },
});
