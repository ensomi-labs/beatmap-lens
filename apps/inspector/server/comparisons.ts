import { createHash, randomInt, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { type ManiaChart, parseBeatmap } from "../../../packages/beatmap-lens/src/index.ts";
import type {
  BlindExcerpt,
  ComparisonExcerpt,
  ComparisonManifest,
  ComparisonPair,
  ComparisonSource,
  ComparisonVerdict,
  OpenComparison,
  ShownChart,
  VerdictRecord,
} from "../src/compare/contracts.ts";
import { proposeExcerpts } from "../src/compare/excerpts.ts";
import {
  assertLocalRequest,
  fullPath,
  localService,
  localServicePlugin,
  readBody,
  sendJson,
} from "./local-service.ts";

const prefix = "/api/inspector/comparisons";
const verdicts: readonly ComparisonVerdict[] = [
  "a_better",
  "b_better",
  "no_difference",
  "cant_tell",
];

interface Session {
  comparisonId: string;
  verdictPath: string;
  pairs: Pair[];
}

interface Pair {
  input: ComparisonPair;
  charts: [ManiaChart, ManiaChart];
  sources: [ShownChart, ShownChart];
  excerpts: Excerpt[];
}

interface Excerpt {
  excerpt: ComparisonExcerpt;
  /** Manifest chart indexes in displayed A, B order. */
  order: [0, 1] | [1, 0];
  verdict?: VerdictRecord;
}

export const comparisonsPlugin = () =>
  localServicePlugin("inspector-comparisons", prefix, comparisonsHandler);

export const createComparisonsMiddleware = () => localService(prefix, comparisonsHandler());

function comparisonsHandler() {
  const sessions = new Map<string, Session>();
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    assertLocalRequest(request, url);
    if (request.method !== "POST") throw new Error("Use POST for comparison operations.");
    const body = JSON.parse((await readBody(request)).toString("utf8"));
    const operation = url.pathname.slice(prefix.length + 1);
    if (operation === "open") {
      const id = randomUUID();
      const session = await openSession(body);
      sessions.set(id, session);
      sendJson(response, describe(id, session));
      return;
    }
    const session = sessions.get(body.session_id);
    if (!session) throw new Error("Reopen the comparison to reconnect the local service.");
    const pair = session.pairs[body.pair_index];
    if (!pair) throw new Error("Choose a song.");
    if (operation === "audio") {
      response.setHeader("Content-Type", "application/octet-stream");
      response.end(await readFile(fullPath(pair.input.audio_path)));
      return;
    }
    const entry = pair.excerpts[body.excerpt_index];
    if (!entry) throw new Error("Choose an excerpt.");
    if (operation === "excerpt") sendJson(response, blind(pair, entry));
    else if (operation === "verdict")
      sendJson(response, await saveVerdict(session, pair, entry, body));
    else throw new Error("Unknown comparison operation.");
  };
}

async function openSession(body: {
  manifest_path?: string;
  chart_paths?: [string, string];
  output_folder?: string;
}): Promise<Session> {
  const manifestPath = body.manifest_path ? fullPath(body.manifest_path) : undefined;
  const manifest: ComparisonManifest = manifestPath
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : await manifestFromCharts(body.chart_paths ?? ["", ""]);
  if (manifest.version !== 1) throw new Error("Expected comparison manifest version 1.");
  const folder = body.output_folder
    ? fullPath(body.output_folder)
    : manifestPath && dirname(manifestPath);
  if (!folder) throw new Error("Choose an output folder for this comparison.");
  await mkdir(folder, { recursive: true });
  const name = manifestPath ? basename(manifestPath, ".json") : "comparison";
  const verdictPath = join(await realpath(folder), `${name}.verdicts.jsonl`);
  const saved = await savedVerdicts(verdictPath, manifest.id);
  const pairs: Pair[] = [];
  for (const input of manifest.pairs) pairs.push(await loadPair(input, saved));
  return { comparisonId: manifest.id, verdictPath, pairs };
}

/** Two loose charts become a one-pair manifest; audio sits beside the first chart. */
async function manifestFromCharts(paths: [string, string]): Promise<ComparisonManifest> {
  const [first, second] = [fullPath(paths[0]), fullPath(paths[1])];
  const audio = parseBeatmap(await readFile(first, "utf8")).audioFilename;
  if (!audio) throw new Error("The first chart needs an AudioFilename.");
  const id = createHash("sha256").update(`${first}\n${second}`).digest("hex").slice(0, 16);
  return {
    version: 1,
    id: `paths-${id}`,
    pairs: [
      {
        id,
        title: "Chart comparison",
        audio_path: resolve(dirname(first), audio.replaceAll("\\", "/")),
        charts: [
          { chart_path: first, model: "First input chart" },
          { chart_path: second, model: "Second input chart" },
        ],
      },
    ],
  };
}

async function loadPair(input: ComparisonPair, saved: Map<string, VerdictRecord>): Promise<Pair> {
  const [a, b] = await Promise.all([loadChart(input.charts[0]), loadChart(input.charts[1])]);
  const sources: [ShownChart, ShownChart] = [a.source, b.source];
  const excerpts = input.excerpts?.length ? input.excerpts : proposeExcerpts(a.chart, b.chart);
  return {
    input,
    charts: [a.chart, b.chart],
    sources,
    excerpts: excerpts.map((excerpt) => {
      const verdict = saved.get(verdictKey(input.id, excerpt, sources));
      // A judged excerpt keeps the A/B it was judged with; the others are shuffled again.
      const swapped = verdict ? !sameChart(verdict.shown_a, a.source) : randomInt(2) === 1;
      return { excerpt, order: swapped ? [1, 0] : [0, 1], ...(verdict ? { verdict } : {}) };
    }),
  };
}

async function loadChart(source: ComparisonSource) {
  const path = fullPath(source.chart_path);
  const bytes = await readFile(path);
  const { chart } = parseBeatmap(bytes.toString("utf8"));
  return {
    // Metadata can name the model, so only note geometry crosses the blind boundary.
    chart: { ...chart, metadata: {}, diagnostics: [] },
    source: {
      ...source,
      chart_path: path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

/** The latest record per excerpt and chart pair, so a re-judged excerpt reads as its last verdict. */
async function savedVerdicts(path: string, comparisonId: string) {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  const saved = new Map<string, VerdictRecord>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const record: VerdictRecord = JSON.parse(line);
    if (record.comparison_id !== comparisonId) continue;
    saved.set(verdictKey(record.pair_id, record.excerpt, [record.shown_a, record.shown_b]), record);
  }
  return saved;
}

/** Same pair, excerpt bounds and two charts (by bytes and label), in either A/B order. */
function verdictKey(pairId: string, excerpt: ComparisonExcerpt, charts: ShownChart[]): string {
  const identities = charts.map((chart) => `${chart.sha256}:${chart.model}`).sort();
  return JSON.stringify([pairId, excerpt.id, excerpt.start_ms, excerpt.end_ms, ...identities]);
}

function sameChart(left: ShownChart, right: ShownChart): boolean {
  return left.sha256 === right.sha256 && left.model === right.model;
}

function describe(sessionId: string, session: Session): OpenComparison {
  return {
    session_id: sessionId,
    verdict_path: session.verdictPath,
    pairs: session.pairs.map(({ input, excerpts }) => ({
      title: input.title,
      ...(input.difficulty_band === undefined ? {} : { difficulty_band: input.difficulty_band }),
      ...(input.seed === undefined ? {} : { seed: input.seed }),
      excerpts: excerpts.map(({ excerpt, verdict }) => ({ ...excerpt, saved: Boolean(verdict) })),
    })),
  };
}

function blind(pair: Pair, { order, verdict }: Excerpt): BlindExcerpt {
  return {
    charts: [pair.charts[order[0]], pair.charts[order[1]]],
    ...(verdict ? { verdict } : {}),
  };
}

async function saveVerdict(
  session: Session,
  pair: Pair,
  entry: Excerpt,
  body: { verdict: ComparisonVerdict; note?: string; playback_rate: number },
): Promise<VerdictRecord> {
  if (!verdicts.includes(body.verdict)) throw new Error("Choose a verdict.");
  const record: VerdictRecord = {
    version: 1,
    id: randomUUID(),
    comparison_id: session.comparisonId,
    pair_id: pair.input.id,
    excerpt: entry.excerpt,
    shown_a: pair.sources[entry.order[0]],
    shown_b: pair.sources[entry.order[1]],
    verdict: body.verdict,
    note: body.note ?? "",
    time: new Date().toISOString(),
    playback_rate: body.playback_rate,
  };
  await appendFile(session.verdictPath, `${JSON.stringify(record)}\n`, {
    flag: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
  });
  entry.verdict = record;
  return record;
}
