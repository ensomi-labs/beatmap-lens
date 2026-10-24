/**
 * Serves the built Inspector and the timing service with plain Node (22.18+ or 24+, which run
 * TypeScript by stripping types) and no npm packages at run time:
 *
 *   node apps/inspector/server/timing-server.ts --session PATH [--port 4177] [--static DIR]
 *
 * Build the page first with `pnpm --filter @ensomi/beatmap-lens-inspector build`, or copy an
 * `apps/inspector/dist` built elsewhere: the bundle is platform independent.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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
  const timing = createTimingMiddleware();
  const page = options.session
    ? `/timing?session=${encodeURIComponent(fullPath(options.session))}`
    : "/timing";
  const server = createServer((request, response) => {
    timing(request, response, () => {
      void serveStatic(request.url ?? "/", request.method ?? "GET").then(
        ({ status, headers, body }) => {
          response.writeHead(status, { "Cache-Control": "no-cache", ...headers });
          response.end(request.method === "HEAD" ? undefined : body);
        },
      );
    });
  });

  async function serveStatic(rawUrl: string, method: string) {
    if (method !== "GET" && method !== "HEAD")
      return { status: 405, headers: {}, body: "Read-only static content." };
    const path = new URL(rawUrl, "http://127.0.0.1").pathname;
    if (path === "/") return { status: 302, headers: { Location: page }, body: "" };
    if (path === "/timing" || path === "/compare")
      return { status: 200, headers: { "Content-Type": mime[".html"] }, body: index };
    const filename = resolve(staticRoot, decodeURIComponent(path).replace(/^\/+/, ""));
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
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
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
      "Inspector timing mode\n  node apps/inspector/server/timing-server.ts --session PATH [--port 4177] [--static DIR]\n\nOpen the printed address. Marks append to <session>.timing.marks.jsonl beside the session.\n",
    );
    process.exit(0);
  }
  const service = await startTimingServer({
    ...(values.session ? { session: values.session } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.static ? { staticRoot: values.static } : {}),
  });
  process.stdout.write(`Timing mode: ${service.url}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => service.close().then(() => process.exit(0)));
}
