/**
 * Serves the built Inspector opened on the `/tempo` multi-song workspace with plain Node
 * (22.18+ or 24+, which strip TypeScript types natively):
 *
 *   node apps/inspector/server/tempo/tempo-server.ts [--dir FOLDER] [--state-dir DIR] [--port 4179] [--host 127.0.0.1] [--static DIR]
 *
 * Build the frontend bundle first with `pnpm --filter @ensomi/beatmap-lens-inspector build`.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fullPath } from "../local-service.ts";
import { createTempoMiddleware, resolvePythonCommand, type TempoServiceOptions } from "./index.ts";

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

const SPA_ROUTES = new Set(["/tempo", "/timing", "/compare", "/review"]);

export interface StartTempoServerOptions extends TempoServiceOptions {
  dir?: string;
  port?: number;
  host?: string;
  staticRoot?: string;
}

export async function startTempoServer(options: StartTempoServerOptions = {}) {
  const staticRoot = resolve(
    options.staticRoot ?? fileURLToPath(new URL("../../dist", import.meta.url)),
  );
  const indexHtml = await readFile(resolve(staticRoot, "index.html")).catch(() => {
    throw new Error(
      `No Inspector build at ${staticRoot}. Run pnpm --filter @ensomi/beatmap-lens-inspector build.`,
    );
  });

  const host = options.host ?? "127.0.0.1";
  const initialDirInput = options.dir ?? options.workspaceDir ?? process.env.TEMPO_WORKSPACE_DIR;
  const resolvedDir = initialDirInput ? fullPath(initialDirInput) : undefined;

  const tempo = createTempoMiddleware({
    ...options,
    allowedHost: host,
    ...(resolvedDir ? { workspaceDir: resolvedDir } : {}),
  });

  let summary: string | undefined;
  let homePath = "/tempo";
  try {
    if (resolvedDir) {
      const opened = await tempo.service.openWorkspace(resolvedDir, options.stateDir);
      summary = `${opened.workspaceDir}: ${opened.songs.length} song${opened.songs.length === 1 ? "" : "s"}`;
      homePath = `/tempo?dir=${encodeURIComponent(opened.workspaceDir)}`;
    }
  } catch (error) {
    await tempo.service.close();
    throw error;
  }

  const server = createServer((request, response) => {
    const fail = (status: number, error: unknown) => {
      if (status === 500) process.stderr.write(`Tempo server: ${String(error)}\n`);
      if (!response.headersSent) response.writeHead(status);
      response.end();
    };
    const serve = () => {
      serveStatic(request.url ?? "/", request.method ?? "GET").then(
        ({ status, headers, body }) => {
          response.writeHead(status, { "Cache-Control": "no-cache", ...headers });
          response.end(request.method === "HEAD" ? undefined : body);
        },
        (error) => fail(500, error),
      );
    };
    try {
      tempo(request, response, serve);
    } catch (error) {
      fail(400, error);
    }
  });

  async function serveStatic(rawUrl: string, method: string) {
    if (method !== "GET" && method !== "HEAD") {
      return { status: 405, headers: {}, body: "Read-only static content." };
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(rawUrl, "http://127.0.0.1").pathname);
    } catch {
      return { status: 400, headers: {}, body: "Malformed address." };
    }
    if (pathname === "/") {
      return { status: 302, headers: { Location: homePath }, body: "" };
    }
    if (SPA_ROUTES.has(pathname)) {
      return { status: 200, headers: { "Content-Type": mime[".html"] }, body: indexHtml };
    }
    const filename = resolve(staticRoot, pathname.replace(/^\/+/, ""));
    if (!filename.startsWith(`${staticRoot}${sep}`)) {
      return { status: 404, headers: {}, body: "Unknown static file." };
    }
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

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 4179, host, resolveListen);
    });
  } catch (error) {
    await tempo.service.close();
    throw error;
  }

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 4179);
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

  return {
    url: `http://${displayHost}:${port}${homePath}`,
    port,
    host,
    summary,
    service: tempo.service,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
      await tempo.service.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      "state-dir": { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "allow-remote": { type: "boolean" },
      static: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "Inspector tempo workspace\n  node apps/inspector/server/tempo/tempo-server.ts [--dir FOLDER] [--state-dir DIR] [--port 4179] [--host 127.0.0.1] [--allow-remote] [--static DIR]\n\nOpen the printed address. Workspace state and traces persist under <folder>/.ensomi-tempo/.\n",
    );
    process.exit(0);
  }
  const started = await startTempoServer({
    ...(values.dir ? { dir: values.dir } : {}),
    ...(values["state-dir"] ? { stateDir: values["state-dir"] } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.host ? { host: values.host } : {}),
    ...(values["allow-remote"] ? { allowRemote: true } : {}),
    ...(values.static ? { staticRoot: values.static } : {}),
  }).catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`Tempo server: ${String(reason)}\n`);
  });
  process.stdout.write(`Tempo daemon Python: ${resolvePythonCommand().label}\n`);
  if (started.summary) process.stdout.write(`${started.summary}\n`);
  process.stdout.write(`Tempo workspace: ${started.url}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void started.close().then(() => process.exit(0));
    });
  }
}
