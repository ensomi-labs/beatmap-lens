import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { localFilesPlugin } from "./server/local-files.ts";

export default defineConfig({
  plugins: [vue(), localFilesPlugin()],
  resolve: {
    alias: {
      "beatmap-lens": fileURLToPath(
        new URL("../../packages/beatmap-lens/src/index.ts", import.meta.url),
      ),
    },
  },
});
