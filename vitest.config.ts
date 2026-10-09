import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "beatmap-lens": fileURLToPath(
        new URL("./packages/beatmap-lens/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    benchmark: {
      include: ["benchmarks/**/*.bench.ts"],
    },
    clearMocks: true,
    environment: "node",
    exclude: ["**/dist/**", "**/node_modules/**"],
    // Node 25 defines its own localStorage, which shadows the DOM environment's.
    execArgv: ["--no-experimental-webstorage"],
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 5_000,
  },
});
