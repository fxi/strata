import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

// Served at https://fxi.io/strata/ (GitHub Pages of fxi/strata).
export default defineConfig({
  plugins: [glsl()],
  base: "/strata/",
  root: "src",
  publicDir: false,
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
});
