import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { comparisonsPlugin } from "./server/comparisons.ts";
import { draftPlugin } from "./server/draft.ts";
import { localFilesPlugin } from "./server/local-files.ts";
import { timingPlugin } from "./server/timing.ts";

export default defineConfig({
  plugins: [vue(), localFilesPlugin(), comparisonsPlugin(), timingPlugin(), draftPlugin()],
  resolve: {
    alias: {
      "beatmap-lens": fileURLToPath(
        new URL("../../packages/beatmap-lens/src/index.ts", import.meta.url),
      ),
    },
  },
});
