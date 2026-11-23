/**
 * Serves the built Inspector opened on the Draft workspace, with the Draft and Timing services,
 * using plain Node (22.18+ or 24+) and no npm packages at run time:
 *
 *   node apps/inspector/server/draft-server.ts [--port 4178] [--static DIR]
 *
 * Build the page first with `pnpm --filter @ensomi/beatmap-lens-inspector build`. Set
 * `ENSOMI_PYTHON` (or `ENSOMI_MODEL_DIR`) to choose the Python that runs BeatThis.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pythonCommand } from "./draft.ts";
import { startTimingServer } from "./timing-server.ts";

export function startDraftServer(options: { port?: number; staticRoot?: string }) {
  return startTimingServer({ ...options, home: "/draft" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      static: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "Inspector draft mode\n  node apps/inspector/server/draft-server.ts [--port 4178] [--static DIR]\n\nOpen the printed address. Traces append to .local/draft-traces/, clips go to .local/draft-clips/.\n",
    );
    process.exit(0);
  }
  const service = await startDraftServer({
    port: values.port ? Number(values.port) : 4178,
    ...(values.static ? { staticRoot: values.static } : {}),
  }).catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`Draft server: ${String(reason)}\n`);
  });
  process.stdout.write(`Draft analysis Python: ${pythonCommand().label}\n`);
  process.stdout.write(`Draft mode: ${service.url}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => service.close().then(() => process.exit(0)));
}
