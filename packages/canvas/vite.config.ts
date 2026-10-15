import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// served by @sw/server in middleware mode (sw serve); /api is handled before Vite sees the request
export default defineConfig({ plugins: [react()] });
