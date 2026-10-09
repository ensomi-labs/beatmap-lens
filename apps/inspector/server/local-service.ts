import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Connect, Plugin } from "vite";

type Handler = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>;

/** Mounts a local file service on the Inspector dev and preview servers. */
export function localServicePlugin(name: string, prefix: string, handle: () => Handler): Plugin {
  const install = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use(localService(prefix, handle()));
  };
  return { name, configureServer: install, configurePreviewServer: install };
}

/** Routes `prefix` and `prefix/…` to `handle`, answering failures as `{ name, error }` JSON. */
export function localService(prefix: string, handle: Handler): Connect.NextHandleFunction {
  return (request, response, next) => {
    const path = request.url?.split("?")[0];
    if (path !== prefix && !path?.startsWith(`${prefix}/`)) return next();
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    void handle(request, response, url).catch((error: Error & { code?: string }) => {
      const name =
        error.code === "ENOENT"
          ? "NotFoundError"
          : error.code === "ENOTDIR"
            ? "TypeMismatchError"
            : error.name;
      response.statusCode = name === "NotAllowedError" ? 403 : name === "NotFoundError" ? 404 : 400;
      sendJson(response, { name, error: error.message });
    });
  };
}

/**
 * These services read and write the user's files, so they answer only same-origin requests from
 * this machine. The custom header keeps a cross-site form post from qualifying.
 */
export function assertLocalRequest(request: IncomingMessage, url: URL, requireHeader = true) {
  if (
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    (request.headers.origin && request.headers.origin !== url.origin) ||
    (requireHeader && request.headers["x-beatmap-lens-local"] !== "1")
  )
    throw new DOMException(
      "Inspector's local service accepts only same-origin localhost requests.",
      "NotAllowedError",
    );
}

/** Resolves an absolute or `~/` path typed by the user; the service has no meaningful cwd. */
export function fullPath(input: string): string {
  const path = input.trim();
  const expanded =
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(expanded)) throw new Error("Enter a full path, or a path starting with ~/.");
  return resolve(expanded);
}

export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function sendJson(response: ServerResponse, value: unknown) {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}
