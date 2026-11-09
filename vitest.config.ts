import glsl from "vite-plugin-glsl";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [glsl()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
