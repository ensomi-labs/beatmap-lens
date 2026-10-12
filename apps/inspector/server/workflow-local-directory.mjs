import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const storageFormat = "beatmap-lens-local-compact-v1";
const taskContract = "beatmap-lens-agent-task";
const blobContracts = new Set(["beatmap-lens-judgment-foundation", taskContract]);

/** Node adapter for the existing canonical command writer. Commits are atomic renames. */
export class LocalDirectoryHandle {
  kind = "directory";

  constructor(path, storageRoot = path) {
    this.path = resolve(path);
    this.name = basename(this.path);
    this.storageRoot = resolve(storageRoot);
  }

  async *entries() {
    const entries = await readdir(this.path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory())
        yield [entry.name, new LocalDirectoryHandle(join(this.path, entry.name), this.storageRoot)];
      if (entry.isFile())
        yield [entry.name, new LocalFileHandle(join(this.path, entry.name), this.storageRoot)];
    }
  }

  async getDirectoryHandle(name, options = {}) {
    const path = child(this.path, name);
    if (options.create) await mkdir(path, { recursive: true });
    await exists(path, "directory");
    return new LocalDirectoryHandle(path, this.storageRoot);
  }

  async getFileHandle(name, options = {}) {
    const path = child(this.path, name);
    if (options.create) {
      try {
        await writeFile(path, "", { flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    await exists(path, "file");
    return new LocalFileHandle(path, this.storageRoot);
  }
}

class LocalFileHandle {
  kind = "file";

  constructor(path, storageRoot) {
    this.path = path;
    this.name = basename(path);
    this.storageRoot = storageRoot;
  }

  async readCanonicalJson() {
    const stored = await readFile(this.path);
    const envelope = JSON.parse(stored.toString("utf8"));
    return envelope.storage === storageFormat
      ? {
          value: await expandPackedDocument(envelope, this.storageRoot),
          canonicalSha256: envelope.canonicalSha256,
        }
      : { value: envelope, canonicalSha256: digest(stored) };
  }

  async writeCanonicalJson(value, canonicalSha256) {
    await atomicWrite(this.path, await compactDocument(value, canonicalSha256, this.storageRoot));
  }

  async getFile() {
    const stored = await readFile(this.path);
    const content = isReviewFilename(this.name)
      ? await expandContent(stored, this.storageRoot)
      : stored;
    return {
      text: async () => (typeof content === "string" ? content : content.toString("utf8")),
      arrayBuffer: async () =>
        Uint8Array.from(typeof content === "string" ? Buffer.from(content) : content).buffer,
    };
  }

  async createWritable() {
    let content;
    return {
      write: async (data) => {
        content = data;
      },
      close: async () => {
        if (content === undefined) throw new Error("No canonical content was written.");
        const stored = isReviewFilename(this.name)
          ? await compactContent(content, this.storageRoot)
          : content;
        await atomicWrite(this.path, stored);
      },
    };
  }
}

/** Physical encoding only: callers still read and write the exact canonical document bytes. */
async function compactContent(content, storageRoot) {
  if (typeof content !== "string" || !content) return content;
  const document = JSON.parse(content);
  if (document.contract !== "beatmap-lens-agent-human-workflow") return content;
  // The canonical writer owns formatting. Never silently reformat other input.
  if (`${JSON.stringify(document, null, 2)}\n` !== content) return content;
  return compactDocument(document, digest(content), storageRoot);
}

async function compactDocument(document, canonicalSha256, storageRoot) {
  const objects = join(storageRoot, ".workflow-objects");
  await mkdir(objects, { recursive: true });
  const pending = new Map();
  const save = async (kind, bytes) => {
    const sha256 = digest(bytes);
    const key = `${sha256}.${kind === "bytes" ? "bin" : "json.gz"}`;
    if (!pending.has(key)) {
      pending.set(
        key,
        (async () => {
          const path = join(objects, key);
          try {
            await stat(path);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await immutableWrite(path, kind === "bytes" ? bytes : await compress(bytes));
          }
        })(),
      );
    }
    await pending.get(key);
    return { $localBlob: { kind, sha256 } };
  };
  const pack = async (value) => {
    if (Array.isArray(value)) return Promise.all(value.map(pack));
    if (value === null || typeof value !== "object") return value;
    const entries = [];
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) continue;
      entries.push([
        key,
        key === "sourceBytes" && Array.isArray(entry)
          ? await save("bytes", Buffer.from(entry))
          : await pack(entry),
      ]);
    }
    const packed = Object.fromEntries(entries);
    return blobContracts.has(value.contract)
      ? save("json", Buffer.from(JSON.stringify(packed)))
      : packed;
  };
  const packed = await pack(document);
  return `${JSON.stringify({ storage: storageFormat, canonicalSha256, document: packed })}\n`;
}

async function expandContent(stored, storageRoot) {
  if (!stored.length) return stored;
  const envelope = JSON.parse(stored.toString("utf8"));
  if (envelope.storage !== storageFormat) return stored;
  const content = `${JSON.stringify(await expandPackedDocument(envelope, storageRoot), null, 2)}\n`;
  if (digest(content) !== envelope.canonicalSha256)
    throw new Error("Expanded workflow document hash differs.");
  return content;
}

async function expandPackedDocument(envelope, storageRoot) {
  const pending = new Map();
  const expand = async (value) => {
    if (Array.isArray(value)) return Promise.all(value.map(expand));
    if (value === null || typeof value !== "object") return value;
    if (value.$localBlob) {
      const { kind, sha256 } = value.$localBlob;
      if (!/^[a-f\d]{64}$/.test(sha256) || !["bytes", "json"].includes(kind))
        throw new Error("Invalid local workflow object reference.");
      const key = `${sha256}.${kind === "bytes" ? "bin" : "json.gz"}`;
      if (!pending.has(key)) {
        pending.set(
          key,
          (async () => {
            const bytes = await readFile(join(storageRoot, ".workflow-objects", key));
            const expanded = kind === "bytes" ? bytes : await decompress(bytes);
            if (digest(expanded) !== sha256) throw new Error("Local workflow object hash differs.");
            return kind === "bytes"
              ? Array.from(expanded)
              : expand(JSON.parse(expanded.toString("utf8")));
          })(),
        );
      }
      return pending.get(key);
    }
    const entries = [];
    for (const [key, entry] of Object.entries(value)) entries.push([key, await expand(entry)]);
    return Object.fromEntries(entries);
  };
  return expand(envelope.document);
}

async function immutableWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.pending`;
  await writeFile(temporary, content);
  try {
    await link(temporary, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary);
  }
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isReviewFilename(name) {
  return /^[a-f\d]{64}\.v2\.json$/.test(name);
}

export async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.pending`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

/** Offline workflow readers use the same transparent expansion as the directory adapter. */
export async function readCanonicalWorkflowFile(path) {
  const bytes = await readFile(path);
  return (await expandContent(bytes, resolve(dirname(path), ".."))).toString("utf8");
}

/** Run with the service stopped: rewrite storage only and verify every expanded canonical hash. */
export async function compactReviewWorkspace(workspace) {
  const root = new LocalDirectoryHandle(workspace);
  const directory = await root.getDirectoryHandle("workflow");
  const files = [];
  const objectBytesBefore = await objectBytes(root.storageRoot);
  for await (const [name, file] of directory.entries()) {
    if (file.kind !== "file" || !isReviewFilename(name)) continue;
    const beforeBytes = (await stat(join(directory.path, name))).size;
    const content = await (await file.getFile()).text();
    const canonicalSha256 = digest(content);
    const writable = await file.createWritable();
    await writable.write(content);
    await writable.close();
    if (digest(await (await file.getFile()).text()) !== canonicalSha256)
      throw new Error(`Compaction changed canonical workflow content: ${name}`);
    files.push({
      name,
      canonicalSha256,
      beforeBytes,
      afterBytes: (await stat(join(directory.path, name))).size,
    });
  }
  const objectBytesAfter = await objectBytes(root.storageRoot);
  return {
    files,
    objectBytesBefore,
    objectBytesAfter,
    beforeBytes: files.reduce((sum, file) => sum + file.beforeBytes, objectBytesBefore),
    afterBytes: files.reduce((sum, file) => sum + file.afterBytes, objectBytesAfter),
  };
}

/**
 * Frozen agent task packets (`*task.json` from `fetch-task`) repeat the Foundation, its
 * calibration charts and the source bytes, and jobs copy them. Each packet keeps its path and
 * becomes a compact envelope over objects stored once in `<root>/.workflow-objects`. A packet
 * is replaced only after its rebuild from the stored objects matches the original bytes.
 * Run with the campaign's writers stopped.
 */
export async function compactTaskPackets(root) {
  const storageRoot = resolve(root);
  const objectBytesBefore = await objectBytes(storageRoot);
  const files = [];
  const kept = [];
  for (const path of await taskPacketPaths(storageRoot)) {
    const stored = await readFile(path);
    const content = stored.toString("utf8");
    const packet = JSON.parse(content);
    if (packet.storage === storageFormat) continue;
    // Only the canonical writer's exact bytes are rebuilt by the shared expansion.
    if (packet.contract !== taskContract || `${JSON.stringify(packet, null, 2)}\n` !== content) {
      kept.push({ path, reason: "not a canonical task packet" });
      continue;
    }
    const canonicalSha256 = digest(stored);
    const compact = await compactDocument(packet, canonicalSha256, storageRoot);
    const rebuilt = await expandPackedDocument(JSON.parse(compact), storageRoot);
    if (`${JSON.stringify(rebuilt, null, 2)}\n` !== content) {
      kept.push({ path, reason: "rebuild differs from the original bytes" });
      continue;
    }
    await atomicWrite(path, compact);
    files.push({
      path,
      canonicalSha256,
      beforeBytes: stored.length,
      afterBytes: Buffer.byteLength(compact),
    });
  }
  const objectBytesAfter = await objectBytes(storageRoot);
  return {
    files,
    kept,
    objectBytesBefore,
    objectBytesAfter,
    beforeBytes: files.reduce((sum, file) => sum + file.beforeBytes, objectBytesBefore),
    afterBytes: files.reduce((sum, file) => sum + file.afterBytes, objectBytesAfter),
  };
}

/** Restore the exact original bytes of every compact task packet under root, in place. */
export async function expandTaskPackets(root) {
  const storageRoot = resolve(root);
  const files = [];
  for (const path of await taskPacketPaths(storageRoot)) {
    const stored = await readFile(path);
    const content = await expandContent(stored, storageRoot);
    if (content === stored) continue;
    await atomicWrite(path, content);
    files.push({ path, canonicalSha256: digest(content), bytes: Buffer.byteLength(content) });
  }
  return { files };
}

/** Exact original text of one task packet, compact or not; root holds its `.workflow-objects`. */
export async function readTaskPacketFile(path, root) {
  return (await expandContent(await readFile(path), resolve(root))).toString("utf8");
}

async function taskPacketPaths(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith("task.json"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

async function objectBytes(storageRoot) {
  const directory = join(storageRoot, ".workflow-objects");
  const names = await readdir(directory).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  const sizes = await Promise.all(
    names.map(async (name) => (await stat(join(directory, name))).size),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

function child(parent, name) {
  if (!name || name === "." || name === ".." || /[/\\]/.test(name)) {
    throw new Error("Expected a single directory entry name.");
  }
  return join(parent, name);
}

async function exists(path, kind) {
  try {
    const entry = await stat(path);
    if (kind === "directory" ? !entry.isDirectory() : !entry.isFile()) {
      throw new Error(`Expected ${kind}: ${path}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new DOMException(`Entry not found: ${path}`, "NotFoundError");
  }
}
