import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import glsl from "vite-plugin-glsl";

const SCHEMA = fileURLToPath(
  new URL("./src/context/schema.json", import.meta.url),
);

/** The context schema, validated against in the app, also served at contexts/schema.json. */
function contextSchema(): Plugin {
  return {
    name: "strata-context-schema",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0].endsWith("/contexts/schema.json")) {
          res.setHeader("content-type", "application/json");
          res.end(readFileSync(SCHEMA));
          return;
        }
        next();
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "contexts/schema.json",
        source: readFileSync(SCHEMA, "utf8"),
      });
    },
  };
}

// Served at https://fxi.io/strata/ (GitHub Pages of fxi/strata).
export default defineConfig({
  plugins: [glsl(), contextSchema()],
  base: "/strata/",
  root: "src",
  // Context files (contexts/*.json) are served as they are.
  publicDir: "public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
});
