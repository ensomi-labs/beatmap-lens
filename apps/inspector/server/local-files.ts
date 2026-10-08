import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { Connect, Plugin } from "vite";

const prefix = "/api/inspector/local-files";
interface Mount {
  path: string;
  writable: boolean;
}

export function localFilesPlugin(): Plugin {
  const install = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use(createLocalFilesMiddleware());
  };
  return {
    name: "inspector-local-files",
    configureServer: install,
    configurePreviewServer: install,
  };
}

export function createLocalFilesMiddleware(): Connect.NextHandleFunction {
  const mounts = new Map<string, Mount>();
  const catalogSources = new Map<string, Buffer>();
  const mount = (path: string, writable: boolean) => {
    const id = randomUUID();
    mounts.set(id, { path, writable });
    return { id, name: basename(path) };
  };

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const source =
      request.method === "GET" && url.pathname.startsWith(`${prefix}/catalog/`)
        ? catalogSources.get(url.pathname.slice(`${prefix}/catalog/`.length))
        : undefined;
    const address = request.socket.remoteAddress;
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "") ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      (request.headers.origin && request.headers.origin !== url.origin) ||
      (!source && request.headers["x-beatmap-lens-local"] !== "1")
    )
      throw new DOMException(
        "Local paths require a same-origin localhost request.",
        "NotAllowedError",
      );

    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (source) {
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.end(source);
      return;
    }
    if (request.method === "GET" && url.pathname === prefix) {
      json(response, { available: true });
      return;
    }
    if (request.method !== "POST") throw new Error("Use POST for local file operations.");
    const body = JSON.parse((await bytes(request)).toString("utf8"));
    if (url.pathname === `${prefix}/open`) {
      const dataset = await directoryPath(body.datasetPath);
      const corpus = await directoryPath(body.corpusPath);
      const catalog = JSON.parse(await readFile(fullPath(body.catalogPath), "utf8"));
      if (
        typeof catalog.catalog?.source === "string" &&
        !/^https?:\/\//.test(catalog.catalog.source)
      ) {
        const sourcePath = await realpath(resolve(corpus, catalog.catalog.source));
        if (!sourcePath.startsWith(`${corpus}${sep}`)) {
          throw new DOMException(
            "The catalog source must be inside the corpus folder.",
            "NotAllowedError",
          );
        }
        const data = await readFile(sourcePath);
        const hash = createHash("sha256").update(data).digest("hex");
        if (hash !== catalog.catalog.sha256)
          throw new Error("Catalog source checksum differs from its manifest.");
        catalogSources.set(hash, data);
        catalog.catalog.source = `${url.origin}${prefix}/catalog/${hash}`;
      }
      json(response, {
        dataset: mount(dataset, true),
        corpus: mount(corpus, false),
        catalog: JSON.stringify(catalog),
      });
      return;
    }
    if (url.pathname !== `${prefix}/handle`) throw new Error("Unknown local file operation.");
    const root = mounts.get(body.root);
    if (!root) throw new Error("Reopen the workspace to reconnect its local paths.");
    const segments: string[] = body.path;
    if (
      !Array.isArray(segments) ||
      segments.some(
        (part) =>
          typeof part !== "string" || !part || part === "." || part === ".." || /[/\\]/.test(part),
      )
    )
      throw new DOMException("Path must stay inside the selected folder.", "NotAllowedError");
    const target = join(root.path, ...segments);
    const check = async (path: string) => {
      const canonical = await realpath(path);
      if (canonical !== root.path && !canonical.startsWith(`${root.path}${sep}`)) {
        throw new DOMException("Path leaves the selected folder.", "NotAllowedError");
      }
      return canonical;
    };
    if (body.create || body.operation === "write") {
      if (!root.writable) throw new DOMException("The corpus is read-only.", "NotAllowedError");
      await check(dirname(target));
    }
    if (body.operation === "directory" && body.create) await mkdir(target, { recursive: true });
    if (body.operation === "file" && body.create) {
      await writeFile(target, "", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    const path = await check(target);
    if (body.operation === "file" || body.operation === "directory") {
      const info = await stat(path);
      if (body.operation === "file" ? !info.isFile() : !info.isDirectory()) {
        throw new DOMException(`Expected a ${body.operation}: ${target}`, "TypeMismatchError");
      }
      json(response, {});
    } else if (body.operation === "entries") {
      const entries = await readdir(path, { withFileTypes: true });
      json(
        response,
        entries
          .filter((entry) => entry.isFile() || entry.isDirectory())
          .map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory() ? "directory" : "file",
          })),
      );
    } else if (body.operation === "read") {
      const data = await readFile(path);
      response.setHeader(
        "Content-Type",
        audioMime[extname(path).toLowerCase()] ?? "application/octet-stream",
      );
      response.end(data);
    } else if (body.operation === "write") {
      const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
      try {
        await writeFile(
          temporary,
          typeof body.data === "string" ? body.data : Buffer.from(body.data),
          { flag: "wx" },
        );
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      json(response, {});
    } else throw new Error("Unknown local file operation.");
  }

  return (request, response, next) => {
    if (request.url?.split("?")[0] !== prefix && !request.url?.startsWith(`${prefix}/`)) {
      next();
      return;
    }
    void handle(request, response).catch((error: Error & { code?: string }) => {
      const name =
        error.code === "ENOENT"
          ? "NotFoundError"
          : error.code === "ENOTDIR"
            ? "TypeMismatchError"
            : error.name;
      response.statusCode = name === "NotAllowedError" ? 403 : name === "NotFoundError" ? 404 : 400;
      json(response, { name, error: error.message });
    });
  };
}

function fullPath(input: string): string {
  const path = input.trim();
  const expanded =
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(expanded)) throw new Error("Enter a full path, or a path starting with ~/.");
  return resolve(expanded);
}

async function directoryPath(input: string): Promise<string> {
  const path = await realpath(fullPath(input));
  if (!(await stat(path)).isDirectory()) throw new Error(`Expected a folder: ${path}`);
  return path;
}

async function bytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, value: unknown) {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

const audioMime: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};
