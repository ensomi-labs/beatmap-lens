/**
 * Writes a self-contained timing-mode runtime to a directory: the built page plus every server
 * file the timing server imports, so another machine needs only Node (22.18+ or 24+):
 *
 *   pnpm --filter @ensomi/beatmap-lens-inspector timing:bundle -- --out DIR
 *   node DIR/server/timing-server.ts --session SESSION.timing.json [--port 4177]
 *
 * The bundle is platform independent: no node_modules, no native code.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const app = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: { out: { type: "string" } },
});
if (!values.out) {
  process.stderr.write("Usage: timing-bundle.mjs --out DIR\n");
  process.exit(1);
}
const out = resolve(values.out);

const { build } = await import("vite");
await build({ root: app, configFile: join(app, "vite.config.ts"), logLevel: "warn" });

/** Relative imports of a module, followed recursively from the server entry. */
async function serverFiles(entry) {
  const found = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (found.has(file)) continue;
    found.add(file);
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/(?:from|import)\s+"(\.{1,2}\/[^"]+)"/g))
      pending.push(resolve(dirname(file), match[1]));
  }
  return [...found];
}

const files = await serverFiles(join(app, "server", "timing-server.ts"));
for (const name of ["dist", "server", "src"])
  await rm(join(out, name), { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(app, "dist"), join(out, "dist"), { recursive: true });
for (const file of files) {
  const target = join(out, relative(app, file));
  await mkdir(dirname(target), { recursive: true });
  await cp(file, target);
}
await writeFile(
  join(out, "package.json"),
  `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
);
await writeFile(
  join(out, "README.txt"),
  "Beatmap Lens Inspector, timing mode. Needs Node 22.18+ or 24+, nothing else.\n\n" +
    "  node server/timing-server.ts --session /path/to/session.timing.json --port 4177\n\n" +
    "Open the printed address. Marks append to <session>.timing.marks.jsonl beside the session.\n",
);
process.stdout.write(
  `Timing bundle written to ${out}\n${files.map((file) => `  ${relative(app, file)}`).join("\n")}\n  dist/\n`,
);
