// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri drives this dev server: the port is fixed so `devUrl` in
// src-tauri/tauri.conf.json stays valid, and the screen is never cleared so
// Rust compiler output stays visible next to Vite output.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
  build: {
    target: "safari15",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
