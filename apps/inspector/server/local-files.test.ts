import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBeatmapAudioFileContext,
  resolveBeatmapAudioFile,
} from "../src/annotation/audio-playback";
import { loadBeatmapSession } from "../src/annotation/beatmap-session";
import { createDatasetDirectory, openDatasetDirectory } from "../src/annotation/dataset-directory";
import { bootstrapFoundationV1 } from "../src/annotation/foundation";
import { openLocalWorkspace } from "../src/annotation/local-paths";
import { addReviewNoteV1 } from "../src/annotation/quality";
import { MemorySessionStore } from "../src/annotation/session-store";
import { createLocalFilesMiddleware } from "./local-files";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Inspector full paths", () => {
  it("loads charts and audio and preserves saved comments when the workspace is reopened", async () => {
    const f = await fixture();
    const opened = await openLocalWorkspace(f.paths, f.url);
    const source = await fetch(opened.catalog.source);
    expect(await source.text()).toBe(f.index);
    const directory = await createDatasetDirectory(opened.dataset, {
      name: "Listening comments",
      catalogSources: [{ url: opened.catalog.source, csvSha256: opened.catalog.sha256 }],
      foundation: bootstrapFoundationV1({
        foundationId: crypto.randomUUID(),
        creatorId: "test-reviewer",
        createdAt: new Date().toISOString(),
        catalogTags: [],
      }),
    });
    const task = opened.catalog.tasks[0];
    if (!task) throw new Error("Missing fixture task.");
    const session = await loadBeatmapSession(
      task,
      opened.catalog,
      opened.corpus,
      directory,
      new MemorySessionStore(),
    );
    const audio = await resolveBeatmapAudioFile(
      await createBeatmapAudioFileContext(
        opened.corpus as unknown as FileSystemDirectoryHandle,
        task,
        session.parsed,
      ),
    );
    if (!audio) throw new Error("Missing fixture audio.");
    expect(audio.type).toBe("audio/mpeg");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(f.audio);
    const document = addReviewNoteV1(session.document, {
      text: "Timing feels late here.",
      range: { startMs: 1000, endMs: 3000 },
    });
    expect(
      (
        await directory.saveAnnotation(document, null, {
          sourceBytes: session.sourceBytes,
          chart: session.chart,
        })
      ).status,
    ).toBe("saved");

    const reconnected = await openLocalWorkspace(f.paths, f.url);
    const reopened = await openDatasetDirectory(reconnected.dataset);
    const restored = await loadBeatmapSession(
      task,
      reconnected.catalog,
      reconnected.corpus,
      reopened,
      new MemorySessionStore(),
    );
    expect(restored.document.reviewNotes).toMatchObject([
      { text: "Timing feels late here.", range: { startMs: 1000, endMs: 3000 } },
    ]);
    expect(await readFile(join(f.paths.corpusPath, "song #1", "chart.osu"), "utf8")).toBe(chart);
    expect((await reopened.scanAnnotations()).map((entry) => entry.status)).toEqual(["ok"]);
  });

  it("keeps the corpus read-only and rejects traversal and symlinks outside the dataset", async () => {
    const f = await fixture();
    const opened = await openLocalWorkspace(f.paths, f.url);
    await expect(opened.corpus.getFileHandle("new.osu", { create: true })).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    await expect(opened.dataset.getDirectoryHandle("..")).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    await symlink(f.paths.corpusPath, join(f.paths.datasetPath, "outside"));
    await expect(opened.dataset.getDirectoryHandle("outside")).rejects.toMatchObject({
      name: "NotAllowedError",
    });
  });

  it("rejects cross-origin requests and requests without the local-client header", async () => {
    const f = await fixture();
    for (const headers of [
      { "Content-Type": "application/json" },
      {
        "Content-Type": "application/json",
        "X-Beatmap-Lens-Local": "1",
        Origin: "https://unrelated.example",
      },
    ]) {
      const response = await fetch(`${f.url}/open`, {
        method: "POST",
        headers,
        body: JSON.stringify(f.paths),
      });
      expect(response.status).toBe(403);
    }
  });

  it("reports a missing folder without creating a dataset elsewhere", async () => {
    const f = await fixture();
    await expect(
      openLocalWorkspace({ ...f.paths, datasetPath: join(f.paths.datasetPath, "missing") }, f.url),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inspector-paths-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = {
    datasetPath: join(root, "comments"),
    corpusPath: join(root, "corpus"),
    catalogPath: join(root, "catalog.json"),
  };
  await mkdir(paths.datasetPath);
  await mkdir(join(paths.corpusPath, "song #1"), { recursive: true });
  await writeFile(join(paths.corpusPath, "song #1", "chart.osu"), chart);
  const audio = new Uint8Array([0x49, 0x44, 0x33, 0, 1, 255]);
  await writeFile(join(paths.corpusPath, "song #1", "audio.mp3"), audio);
  const index = "path\nsong #1/chart.osu\n";
  await writeFile(join(paths.corpusPath, "index.csv"), index);
  await writeFile(
    paths.catalogPath,
    JSON.stringify({
      version: 1,
      catalog: {
        source: "index.csv",
        sha256: createHash("sha256").update(index).digest("hex"),
        categoryEnum: [],
      },
      corpus: { root: "corpus" },
      pathCategories: { "corpus/song #1/chart.osu": [] },
    }),
  );
  const middleware = createLocalFilesMiddleware();
  const server = createServer((request, response) =>
    middleware(request, response, () => {
      response.writeHead(404).end();
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address.");
  return { paths, index, audio, url: `http://127.0.0.1:${address.port}/api/inspector/local-files` };
}

const chart = `osu file format v14
[General]
Mode:3
AudioFilename:audio.mp3
[Metadata]
Title:Path fixture
Artist:Beatmap Lens
Creator:Test
Version:4K
[Difficulty]
CircleSize:4
[TimingPoints]
0,500,4,2,0,100,1,0
[HitObjects]
64,192,1000,1,0,0:0:0:0:
192,192,2000,1,0,0:0:0:0:
320,192,4000,1,0,0:0:0:0:
`;
