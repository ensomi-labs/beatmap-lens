import { parseCatalogManifest } from "./catalog";
import type { DatasetFileHandle, DatasetHandle, WritableFileLike } from "./dataset-directory";
import type { BrowserDirectoryHandle } from "./file-system-access";

const endpoint = "/api/inspector/local-files";
const headers = { "Content-Type": "application/json", "X-Beatmap-Lens-Local": "1" };

export interface LocalWorkspacePaths {
  datasetPath: string;
  catalogPath: string;
  corpusPath: string;
}

export async function supportsLocalPaths(): Promise<boolean> {
  try {
    const response = await fetch(endpoint, { headers });
    return response.ok && (await response.json()).available === true;
  } catch {
    return false;
  }
}

export async function openLocalWorkspace(paths: LocalWorkspacePaths, base = endpoint) {
  const response = await checked(
    await fetch(`${base}/open`, {
      method: "POST",
      headers,
      body: JSON.stringify(paths),
    }),
  );
  const opened = await response.json();
  return {
    dataset: new LocalDirectory(base, opened.dataset.id, [], opened.dataset.name, true),
    corpus: new LocalDirectory(base, opened.corpus.id, [], opened.corpus.name, false),
    catalog: parseCatalogManifest(opened.catalog),
  };
}

async function checked(response: Response): Promise<Response> {
  if (!response.ok) {
    const result = await response.json();
    throw new DOMException(result.error, result.name);
  }
  return response;
}

class LocalHandle {
  constructor(
    readonly base: string,
    readonly root: string,
    readonly path: readonly string[],
    readonly name: string,
    readonly writable: boolean,
  ) {}

  async queryPermission(options?: { mode?: "read" | "readwrite" }): Promise<PermissionState> {
    return options?.mode === "readwrite" && !this.writable ? "denied" : "granted";
  }

  requestPermission(options?: { mode?: "read" | "readwrite" }) {
    return this.queryPermission(options);
  }

  request(operation: string, extra: Record<string, unknown> = {}) {
    return fetch(`${this.base}/handle`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root: this.root, path: this.path, operation, ...extra }),
    }).then(checked);
  }
}

class LocalDirectory extends LocalHandle implements BrowserDirectoryHandle {
  readonly kind = "directory";

  async *entries(): AsyncIterableIterator<[string, DatasetHandle]> {
    const response = await this.request("entries");
    const entries: { name: string; kind: "file" | "directory" }[] = await response.json();
    for (const entry of entries) {
      const Handle = entry.kind === "directory" ? LocalDirectory : LocalFile;
      yield [
        entry.name,
        new Handle(this.base, this.root, [...this.path, entry.name], entry.name, this.writable),
      ];
    }
  }

  async getDirectoryHandle(name: string, options?: { readonly create?: boolean }) {
    const child = new LocalDirectory(
      this.base,
      this.root,
      [...this.path, name],
      name,
      this.writable,
    );
    await child.request("directory", options);
    return child;
  }

  async getFileHandle(name: string, options?: { readonly create?: boolean }) {
    const child = new LocalFile(this.base, this.root, [...this.path, name], name, this.writable);
    await child.request("file", options);
    return child;
  }
}

class LocalFile extends LocalHandle implements DatasetFileHandle {
  readonly kind = "file";

  async getFile(): Promise<File> {
    const response = await this.request("read");
    const blob = await response.blob();
    return new File([blob], this.name, { type: blob.type });
  }

  async createWritable(): Promise<WritableFileLike> {
    let data: string | number[] | undefined;
    return {
      write: async (value) => {
        data = typeof value === "string" ? value : Array.from(value);
      },
      close: async () => {
        if (data === undefined) throw new Error("No content was written.");
        await this.request("write", { data });
      },
    };
  }
}
