/**
 * Serves the built Inspector and the timing service with plain Node (22.18+ or 24+, which run
 * TypeScript by stripping types) and no npm packages at run time:
 *
 *   node apps/inspector/server/timing-server.ts --session PATH [--port 4177] [--static DIR]
 *
 * Build the page first with `pnpm --filter @ensomi/beatmap-lens-inspector build`, or copy an
 * `apps/inspector/dist` built elsewhere: the bundle is platform independent.
 */
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseSession } from "../src/timing/format.ts";
import { fullPath } from "./local-service.ts";
import { createTimingMiddleware } from "./timing.ts";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".json": "application/json",
};

export async function startTimingServer(options: {
  session?: string;
  port?: number;
  staticRoot?: string;
}) {
  const staticRoot = resolve(
    options.staticRoot ?? fileURLToPath(new URL("../dist", import.meta.url)),
  );
  const index = await readFile(resolve(staticRoot, "index.html")).catch(() => {
    throw new Error(
      `No Inspector build at ${staticRoot}. Run pnpm --filter @ensomi/beatmap-lens-inspector build.`,
    );
  });
  const summary = options.session ? await checkSession(fullPath(options.session)) : undefined;
  const timing = createTimingMiddleware();
  const page = options.session
    ? `/timing?session=${encodeURIComponent(fullPath(options.session))}`
    : "/timing";
  // No request may end the process: the page holds unsaved marks that only this service can save.
  const server = createServer((request, response) => {
    const fail = (status: number, error: unknown) => {
      if (status === 500) process.stderr.write(`Timing server: ${String(error)}\n`);
      if (!response.headersSent) response.writeHead(status);
      response.end();
    };
    try {
      timing(request, response, () => {
        serveStatic(request.url ?? "/", request.method ?? "GET").then(
          ({ status, headers, body }) => {
            response.writeHead(status, { "Cache-Control": "no-cache", ...headers });
            response.end(request.method === "HEAD" ? undefined : body);
          },
          (error) => fail(500, error),
        );
      });
    } catch (error) {
      fail(400, error);
    }
  });

  async function serveStatic(rawUrl: string, method: string) {
    if (method !== "GET" && method !== "HEAD")
      return { status: 405, headers: {}, body: "Read-only static content." };
    let path: string;
    try {
      path = decodeURIComponent(new URL(rawUrl, "http://127.0.0.1").pathname);
    } catch {
      return { status: 400, headers: {}, body: "Malformed address." };
    }
    if (path === "/") return { status: 302, headers: { Location: page }, body: "" };
    if (path === "/timing" || path === "/compare")
      return { status: 200, headers: { "Content-Type": mime[".html"] }, body: index };
    const filename = resolve(staticRoot, path.replace(/^\/+/, ""));
    if (!filename.startsWith(`${staticRoot}${sep}`))
      return { status: 404, headers: {}, body: "Unknown static file." };
    try {
      const body = await readFile(filename);
      return {
        status: 200,
        headers: { "Content-Type": mime[extname(filename)] ?? "application/octet-stream" },
        body,
      };
    } catch {
      return { status: 404, headers: {}, body: "Unknown static file." };
    }
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4177, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}${page}`,
    summary,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/**
 * Reads the session and checks that the identity key file exists and every PCM file exists with
 * its stated size, so a wrong path fails here rather than in the browser or at the first reveal.
 * The key file is only stat'ed, never read. Hashes are checked when the page loads each recording.
 */
async function checkSession(sessionPath: string): Promise<string> {
  const folder = dirname(sessionPath);
  const session = parseSession(await readFile(sessionPath, "utf8"), (path) =>
    isAbsolute(path) ? path : resolve(folder, path),
  );
  const keyFile = await stat(session.revealKeyPath).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!keyFile) throw new Error(`Missing identity key file: ${session.revealKeyPath}`);
  const recordings = new Map(
    session.passages.map((passage) => [passage.audio.path, passage.audio]),
  );
  for (const audio of recordings.values()) {
    const size = await stat(audio.path).then(
      (info) => info.size,
      () => undefined,
    );
    if (size === undefined) throw new Error(`Missing PCM file: ${audio.path}`);
    if (size !== audio.frames * audio.channels * 4)
      throw new Error(`PCM file size does not match its frames and channels: ${audio.path}`);
  }
  const rates = [...new Set(session.passages.map((passage) => passage.audio.sample_rate))];
  return `${session.id}: ${session.passages.length} passages, ${recordings.size} recordings at ${rates.join(" and ")} Hz`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      session: { type: "string" },
      port: { type: "string" },
      static: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "Inspector timing mode\n  node apps/inspector/server/timing-server.ts --session PATH [--port 4177] [--static DIR]\n\nOpen the printed address. Marks append to <session>.timing.marks.jsonl and the session note to <session>.timing.notes.jsonl, beside the session.\n",
    );
    process.exit(0);
  }
  const service = await startTimingServer({
    ...(values.session ? { session: values.session } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.static ? { staticRoot: values.static } : {}),
  }).catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`Timing server: ${String(reason)}\n`);
  });
  if (service.summary) process.stdout.write(`${service.summary}\n`);
  process.stdout.write(`Timing mode: ${service.url}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => service.close().then(() => process.exit(0)));
}
