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

// Show the manifest's second chart as A, so A/B order differs from input order.
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomInt: () => 1,
}));

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("keeps model labels on the service until a verdict is appended", async () => {
  const f = await fixture();
  const opened: OpenComparison = await f.post("open", { manifest_path: f.manifestPath });
  expect(opened.pairs.map((pair) => pair.excerpts[0]?.id)).toEqual(["breath", "diff-0"]);
  const target = { session_id: opened.session_id, pair_index: 0, excerpt_index: 0 };
  const blind: BlindExcerpt = await f.post("excerpt", target);
  expect(JSON.stringify([opened, blind])).not.toContain("secret-model");
  expect(blind.charts.map((chart) => chart.notes.length)).toEqual([3, 2]);
  expect(new Uint8Array(await (await f.request("audio", target)).arrayBuffer())).toEqual(f.audio);

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
  expect(JSON.parse(await readFile(opened.verdict_path, "utf8"))).toEqual(saved);
  expect(await readFile(f.chartPaths[0], "utf8")).toBe(f.charts[0]);
  expect(await readFile(f.manifestPath, "utf8")).toBe(JSON.stringify(f.manifest));
});

it("reopens a judged excerpt with its A/B mapping, even after the manifest is repacked", async () => {
  const f = await fixture();
  const first: OpenComparison = await f.post("open", { manifest_path: f.manifestPath });
  const target = { session_id: first.session_id, pair_index: 0, excerpt_index: 0 };
  const shown: BlindExcerpt = await f.post("excerpt", target);
  const saved = await f.post("verdict", { ...target, verdict: "b_better", playback_rate: 1 });

  // Same chart bytes and labels, new path and input order.
  const moved = join(f.root, "relocated-two.osu");
  await writeFile(moved, f.charts[1]);
  const pair = f.manifest.pairs[0];
  if (!pair) throw new Error("Missing pair.");
  const [one, two] = pair.charts;
  pair.charts = [{ ...two, chart_path: moved }, one];
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));

  const reopened: OpenComparison = await f.post("open", { manifest_path: f.manifestPath });
  expect(reopened.pairs[0]?.excerpts[0]?.saved).toBe(true);
  expect(await f.post("excerpt", { ...target, session_id: reopened.session_id })).toEqual({
    ...shown,
    verdict: saved,
  });
});

it("opens two loose charts with adjacent audio and appends to the chosen folder", async () => {
  const f = await fixture();
  const opened: OpenComparison = await f.post("open", {
    chart_paths: f.chartPaths,
    output_folder: join(f.root, "chosen"),
  });
  expect(opened.verdict_path).toBe(join(f.root, "chosen", "comparison.verdicts.jsonl"));
  const target = { session_id: opened.session_id, pair_index: 0, excerpt_index: 0 };
  expect(new Uint8Array(await (await f.request("audio", target)).arrayBuffer())).toEqual(f.audio);
  for (const verdict of ["b_better", "no_difference"])
    await f.post("verdict", { ...target, verdict, playback_rate: 1 });
  const lines = (await readFile(opened.verdict_path, "utf8")).trim().split("\n");
  expect(lines.map((line) => JSON.parse(line).verdict)).toEqual(["b_better", "no_difference"]);
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lens-compare-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const charts: [string, string] = [
    osu([1000, 20_000], "secret-model-one"),
    osu([1000, 5000, 20_000], "secret-model-two"),
  ];
  const chartPaths: [string, string] = [join(root, "one.osu"), join(root, "two.osu")];
  await writeFile(chartPaths[0], charts[0]);
  await writeFile(chartPaths[1], charts[1]);
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
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
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

function osu(times: number[], model: string) {
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
