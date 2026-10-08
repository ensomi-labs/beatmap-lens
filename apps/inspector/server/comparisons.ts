import { createHash, randomInt, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Connect, Plugin } from "vite";
import { parseBeatmap, parseOsu, toManiaChart } from "../../../packages/beatmap-lens/src/index.ts";
import type {
  ComparisonExcerpt,
  ComparisonManifest,
  ComparisonPair,
  OpenComparison,
  VerdictRecord,
} from "../src/compare/contracts.ts";
import { proposeExcerpts } from "../src/compare/excerpts.ts";

const prefix = "/api/inspector/comparisons";
interface LoadedPair {
  input: ComparisonPair;
  charts: ReturnType<typeof toManiaChart>[];
  sources: [VerdictRecord["shown_a"], VerdictRecord["shown_b"]];
  excerpts: { excerpt: ComparisonExcerpt; a: number; verdict?: VerdictRecord }[];
}
interface Session {
  id: string;
  output: string;
  pairs: LoadedPair[];
}

export function comparisonsPlugin(): Plugin {
  const install = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use(createComparisonsMiddleware());
  };
  return {
    name: "inspector-comparisons",
    configureServer: install,
    configurePreviewServer: install,
  };
}

export function createComparisonsMiddleware(): Connect.NextHandleFunction {
  const sessions = new Map<string, Session>();
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      (request.headers.origin && request.headers.origin !== url.origin) ||
      request.headers["x-beatmap-lens-local"] !== "1"
    )
      throw new DOMException(
        "Comparisons require a same-origin localhost request.",
        "NotAllowedError",
      );
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "POST") throw new Error("Use POST for comparison operations.");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (url.pathname === `${prefix}/open`) {
      const manifestPath = body.manifest_path ? fullPath(body.manifest_path) : undefined;
      const manifest: ComparisonManifest = manifestPath
        ? JSON.parse(await readFile(manifestPath, "utf8"))
        : await fromPaths(body.chart_paths);
      if (manifest.version !== 1) throw new Error("Expected comparison manifest version 1.");
      const folder = body.output_folder
        ? fullPath(body.output_folder)
        : manifestPath
          ? dirname(manifestPath)
          : undefined;
      if (!folder) throw new Error("Choose an output folder for this comparison.");
      await mkdir(folder, { recursive: true });
      const output = join(
        await realpath(folder),
        manifestPath
          ? `${basename(manifestPath, ".json")}.verdicts.jsonl`
          : "comparison.verdicts.jsonl",
      );
      const history = await readFile(output, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return "";
      });
      const records: VerdictRecord[] = history
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .reverse();
      const pairs: LoadedPair[] = [];
      for (const input of manifest.pairs) {
        const sources = [];
        const charts = [];
        for (const source of input.charts) {
          const path = fullPath(source.chart_path);
          const bytes = await readFile(path);
          const chart = toManiaChart(parseOsu(bytes.toString("utf8")));
          sources.push({
            ...source,
            chart_path: path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
          // Source metadata can contain model names. Only geometry crosses the blind boundary.
          charts.push({ ...chart, metadata: {}, diagnostics: [] });
        }
        const [first, second] = charts;
        const [sourceA, sourceB] = sources;
        if (!first || !second || !sourceA || !sourceB) throw new Error("A pair needs two charts.");
        const excerpts = input.excerpts?.length ? input.excerpts : proposeExcerpts(first, second);
        pairs.push({
          input,
          charts,
          sources: [sourceA, sourceB],
          excerpts: excerpts.map((excerpt) => {
            const verdict = records.find(
              (entry) =>
                entry.comparison_id === manifest.id &&
                entry.pair_id === input.id &&
                entry.excerpt.id === excerpt.id &&
                entry.excerpt.start_ms === excerpt.start_ms &&
                entry.excerpt.end_ms === excerpt.end_ms &&
                ((sameSource(entry.shown_a, sourceA) && sameSource(entry.shown_b, sourceB)) ||
                  (sameSource(entry.shown_a, sourceB) && sameSource(entry.shown_b, sourceA))),
            );
            return {
              excerpt,
              a: verdict ? Number(!sameSource(verdict.shown_a, sourceA)) : randomInt(2),
              ...(verdict ? { verdict } : {}),
            };
          }),
        });
      }
      const token = randomUUID();
      sessions.set(token, { id: manifest.id, output, pairs });
      const opened: OpenComparison = {
        session_id: token,
        verdict_path: output,
        pairs: pairs.map(({ input, excerpts }) => ({
          title: input.title,
          ...(input.difficulty_band === undefined
            ? {}
            : { difficulty_band: input.difficulty_band }),
          ...(input.seed === undefined ? {} : { seed: input.seed }),
          excerpts: excerpts.map(({ excerpt, verdict }) => ({
            ...excerpt,
            saved: Boolean(verdict),
          })),
        })),
      };
      json(response, opened);
      return;
    }
    const session = sessions.get(body.session_id);
    if (!session) throw new Error("Reopen the comparison to reconnect the local service.");
    const pair = session.pairs[body.pair_index];
    if (!pair) throw new Error("Choose a song.");
    if (url.pathname === `${prefix}/audio`) {
      response.setHeader("Content-Type", "application/octet-stream");
      response.end(await readFile(fullPath(pair.input.audio_path)));
      return;
    }
    const entry = pair.excerpts[body.excerpt_index];
    if (!entry) throw new Error("Choose an excerpt.");
    if (url.pathname === `${prefix}/excerpt`) {
      json(response, {
        charts: [pair.charts[entry.a], pair.charts[1 - entry.a]],
        ...(entry.verdict ? { verdict: entry.verdict } : {}),
      });
    } else if (url.pathname === `${prefix}/verdict`) {
      if (!["a_better", "b_better", "no_difference", "cant_tell"].includes(body.verdict))
        throw new Error("Choose a verdict.");
      const record: VerdictRecord = {
        version: 1,
        id: randomUUID(),
        comparison_id: session.id,
        pair_id: pair.input.id,
        excerpt: entry.excerpt,
        shown_a: pair.sources[entry.a] as VerdictRecord["shown_a"],
        shown_b: pair.sources[1 - entry.a] as VerdictRecord["shown_b"],
        verdict: body.verdict,
        note: body.note ?? "",
        time: new Date().toISOString(),
        playback_rate: body.playback_rate,
      };
      await appendFile(session.output, `${JSON.stringify(record)}\n`, {
        flag: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      });
      entry.verdict = record;
      json(response, record);
    } else throw new Error("Unknown comparison operation.");
  }
  return (request, response, next) => {
    if (!request.url?.startsWith(`${prefix}/`)) return next();
    void handle(request, response).catch((error: Error) => {
      response.statusCode = error.name === "NotAllowedError" ? 403 : 400;
      json(response, { error: error.message });
    });
  };
}

function fullPath(input: string): string {
  const path = input.trim();
  const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(expanded)) throw new Error("Enter an absolute path or a ~/ path.");
  return resolve(expanded);
}

async function fromPaths(paths: [string, string]): Promise<ComparisonManifest> {
  const chartPaths = paths.map(fullPath);
  const first = chartPaths[0] as string;
  const audio = parseBeatmap(await readFile(first, "utf8")).audioFilename;
  if (!audio) throw new Error("The first chart needs an adjacent AudioFilename.");
  const id = createHash("sha256").update(chartPaths.join("\n")).digest("hex").slice(0, 16);
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
          { chart_path: chartPaths[1] as string, model: "Second input chart" },
        ],
      },
    ],
  };
}

function json(response: ServerResponse, value: unknown) {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

function sameSource(left: VerdictRecord["shown_a"], right: VerdictRecord["shown_a"]): boolean {
  return left.sha256 === right.sha256 && left.model === right.model;
}
