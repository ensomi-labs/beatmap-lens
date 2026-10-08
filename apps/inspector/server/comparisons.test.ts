import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  BlindExcerpt,
  ComparisonManifest,
  OpenComparison,
  VerdictRecord,
} from "../src/compare/contracts";
import { createComparisonsMiddleware } from "./comparisons";

vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomInt: () => 1,
}));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("keeps model identities on the service until saving, persists the blind mapping, and restores saved excerpts", async () => {
  const f = await fixture();
  const opened: OpenComparison = await f.post("open", { manifest_path: f.manifestPath });
  expect(opened.pairs).toHaveLength(2);
  expect(opened.pairs[0]?.excerpts[0]).toMatchObject({ id: "breath", saved: false });
  expect(opened.pairs[1]?.excerpts.length).toBeGreaterThan(0);
  expect(JSON.stringify(opened)).not.toContain("secret-model");
  const target = { session_id: opened.session_id, pair_index: 0, excerpt_index: 0 };
  const blind: BlindExcerpt = await f.post("excerpt", target);
  expect(JSON.stringify(blind)).not.toContain("secret-model");
  expect(blind.charts[0].notes).toHaveLength(3);
  expect(blind.charts[1].notes).toHaveLength(2);
  const audio = await f.request("audio", target);
  expect(new Uint8Array(await audio.arrayBuffer())).toEqual(f.audio);
  const saved: VerdictRecord = await f.post("verdict", {
    ...target,
    verdict: "a_better",
    note: "More space at the breath.",
    playback_rate: 0.75,
  });
  expect(saved).toMatchObject({
    comparison_id: "trial",
    pair_id: "song-one",
    shown_a: { model: "secret-model-two" },
    shown_b: { model: "secret-model-one" },
    verdict: "a_better",
    playback_rate: 0.75,
  });
  expect(saved.time).toMatch(/^\d{4}-/);
  expect(JSON.parse((await readFile(opened.verdict_path, "utf8")).trim())).toEqual(saved);
  const reopened: OpenComparison = await f.post("open", { manifest_path: f.manifestPath });
  const restored: BlindExcerpt = await f.post("excerpt", {
    ...target,
    session_id: reopened.session_id,
  });
  expect(restored.verdict).toEqual(saved);
  expect(restored.charts).toEqual(blind.charts);
  expect(reopened.pairs[0]?.excerpts[0]?.saved).toBe(true);
  expect(await readFile(f.chartPaths[0], "utf8")).toBe(f.charts[0]);
  expect(await readFile(f.manifestPath, "utf8")).toBe(JSON.stringify(f.manifest));
});

it("opens two chart paths, infers adjacent audio, and appends verdicts only to the chosen folder", async () => {
  const f = await fixture();
  const opened: OpenComparison = await f.post("open", {
    chart_paths: f.chartPaths,
    output_folder: join(f.root, "chosen"),
  });
  expect(opened.verdict_path).toBe(join(f.root, "chosen", "comparison.verdicts.jsonl"));
  const target = { session_id: opened.session_id, pair_index: 0, excerpt_index: 0 };
  for (const verdict of ["b_better", "no_difference", "cant_tell"]) {
    await f.post("verdict", { ...target, verdict, note: "", playback_rate: 1 });
  }
  expect(
    (await readFile(opened.verdict_path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).verdict),
  ).toEqual(["b_better", "no_difference", "cant_tell"]);
  expect(new Uint8Array(await (await f.request("audio", target)).arrayBuffer())).toEqual(f.audio);
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lens-compare-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const charts = [
    source([1000, 20_000], "secret-model-one"),
    source([1000, 5000, 20_000], "secret-model-two"),
  ];
  const chartPaths: [string, string] = [join(root, "one.osu"), join(root, "two.osu")];
  for (const [i, path] of chartPaths.entries()) await writeFile(path, charts[i] as string);
  const audio = new Uint8Array([0x49, 0x44, 0x33, 0, 1, 255]);
  await writeFile(join(root, "audio.mp3"), audio);
  const pair = {
    id: "song-one",
    title: "Song one",
    audio_path: join(root, "audio.mp3"),
    charts: [
      { chart_path: chartPaths[0], model: "secret-model-one" },
      { chart_path: chartPaths[1], model: "secret-model-two" },
    ] as ComparisonManifest["pairs"][number]["charts"],
  };
  const manifest: ComparisonManifest = {
    version: 1,
    id: "trial",
    pairs: [
      {
        ...pair,
        excerpts: [{ id: "breath", start_ms: 0, end_ms: 15_000, hint: "Listen at the breath." }],
      },
      { ...pair, id: "song-two", title: "Song two" },
    ],
  };
  const manifestPath = join(root, "trial.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const middleware = createComparisonsMiddleware();
  const server = createServer((req, res) => middleware(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address.");
  const request = (operation: string, body: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/api/inspector/comparisons/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Beatmap-Lens-Local": "1" },
      body: JSON.stringify(body),
    });
  const post = async (operation: string, body: unknown) => {
    const response = await request(operation, body);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  };
  return { root, chartPaths, charts, manifestPath, manifest, audio, request, post };
}

function source(times: number[], model: string) {
  return `osu file format v14
[General]
Mode:3
AudioFilename:audio.mp3
[Metadata]
Title:${model}
Creator:${model}
[Difficulty]
CircleSize:4
[HitObjects]
${times.map((time) => `64,192,${time},1,0,0:0:0:0:`).join("\n")}
`;
}
