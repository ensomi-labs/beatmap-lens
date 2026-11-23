import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { comparisonsPlugin } from "./server/comparisons.ts";
import { localFilesPlugin } from "./server/local-files.ts";
import { tempoPlugin } from "./server/tempo/index.ts";
import { timingPlugin } from "./server/timing.ts";

const ensomiPackageDir = process.env.ENSOMI_PACKAGE_DIR;

export default defineConfig({
  plugins: [vue(), localFilesPlugin(), comparisonsPlugin(), timingPlugin(), tempoPlugin()],
  resolve: {
    alias: {
      "beatmap-lens": fileURLToPath(
        new URL("../../packages/beatmap-lens/src/index.ts", import.meta.url),
      ),
      ...(ensomiPackageDir ? { ensomi: resolve(ensomiPackageDir) } : {}),
    },
  },
});
