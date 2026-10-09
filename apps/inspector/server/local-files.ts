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
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import {
  assertLocalRequest,
  fullPath,
  localService,
  localServicePlugin,
  readBody,
  sendJson,
} from "./local-service.ts";

const prefix = "/api/inspector/local-files";
interface Mount {
  path: string;
  writable: boolean;
}

export const localFilesPlugin = () =>
  localServicePlugin("inspector-local-files", prefix, localFilesHandler);

export const createLocalFilesMiddleware = () => localService(prefix, localFilesHandler());

function localFilesHandler() {
  const mounts = new Map<string, Mount>();
  const catalogSources = new Map<string, Buffer>();
  const mount = (path: string, writable: boolean) => {
    const id = randomUUID();
    mounts.set(id, { path, writable });
    return { id, name: basename(path) };
  };

  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    // The rewritten catalog source URL is fetched as a plain GET, without the local header.
    const source =
      request.method === "GET" && url.pathname.startsWith(`${prefix}/catalog/`)
        ? catalogSources.get(url.pathname.slice(`${prefix}/catalog/`.length))
        : undefined;
    assertLocalRequest(request, url, !source);
    if (source) {
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.end(source);
      return;
    }
    if (request.method === "GET" && url.pathname === prefix) {
      sendJson(response, { available: true });
      return;
    }
    if (request.method !== "POST") throw new Error("Use POST for local file operations.");
    const body = JSON.parse((await readBody(request)).toString("utf8"));
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
      sendJson(response, {
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
      sendJson(response, {});
    } else if (body.operation === "entries") {
      const entries = await readdir(path, { withFileTypes: true });
      sendJson(
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
      sendJson(response, {});
    } else throw new Error("Unknown local file operation.");
  };
}

async function directoryPath(input: string): Promise<string> {
  const path = await realpath(fullPath(input));
  if (!(await stat(path)).isDirectory()) throw new Error(`Expected a folder: ${path}`);
  return path;
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
