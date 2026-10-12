import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readCanonicalWorkflowFile } from "./workflow-local-directory.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const { positionals, values } = parseArgs({
  args: process.argv.slice(process.argv[2] === "--" ? 3 : 2),
  allowPositionals: true,
  options: {
    task: { type: "string" },
    handoff: { type: "string" },
    input: { type: "string" },
    file: { type: "string" },
    server: { type: "string" },
    source: { type: "string" },
    "source-sha": { type: "string" },
    "foundation-source-sha": { type: "string" },
    "foundation-sha": { type: "string" },
    out: { type: "string" },
    "start-ms": { type: "string" },
    "end-ms": { type: "string" },
    fresh: { type: "boolean" },
    help: { type: "boolean" },
  },
});
const command = positionals.filter((value) => value !== "--")[0];
if (values.help || !command) {
  process.stdout.write(`Beatmap Lens annotation exchange (V2)

  inbox --server URL [--out FILE]
  register-source --server URL --source CHART.osu --foundation-source-sha SHA --foundation-sha SHA --out TASK.json
  fetch-task --server URL --source-sha SHA [--fresh] --out TASK.json
  submit --server URL --input SEALED_PACKET_OR_REVIEW_REQUEST.json [--out RECEIPT.json]
  dispositions --server URL --source-sha SHA [--out FILE]

  evidence --task TASK.json --out DIRECTORY [--start-ms N --end-ms N]
  handoff --task TASK.json --input PROPOSAL.json --out HANDOFF.json
  audit --task TASK.json --handoff HANDOFF.json --input AUDIT.json --out SEALED_AUDIT.json
  review-status --file WORKFLOW.json [--source CHART.osu] [--out FILE]
  expert-queue --file WORKFLOW.json [--source CHART.osu] [--out FILE]
  dispositions --file WORKFLOW_OR_DISPOSITIONS.json [--source CHART.osu] [--out FILE]

The fixed human inbox is http://127.0.0.1:4176/review. Agents fetch frozen tasks,
submit sealed packets, and read dispositions without human file transfers.
Tasks freeze approved workspace context. Evidence includes the full difficulty and
exact source, even when rendered pages use a bounded range. Handoff accepts
proposal, self-check notes and questions only. Independent auditors seal a separate
packet against the original handoff. Human decisions are made in Inspector;
machine review never creates a human-confirmed observation.
`);
  process.exit(0);
}

if (
  ["inbox", "register-source", "fetch-task", "submit"].includes(command) ||
  (command === "dispositions" && values.server)
) {
  try {
    await networkExchange();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
  const server = await createServer({
    root: repoRoot,
    configFile: false,
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { "beatmap-lens": join(repoRoot, "packages/beatmap-lens/src/index.ts") } },
  });

  try {
    const domain = await server.ssrLoadModule("/apps/inspector/src/annotation/workflow/domain.ts");
    const { serializeCanonicalJson } = await server.ssrLoadModule(
      "/apps/inspector/src/annotation/canonical-json.ts",
    );
    if (command === "evidence") {
      const task = await domain.assertTaskPacketV2(await readJson(required("task")));
      const destination = resolve(required("out"));
      const { inspectOsuSourceV1 } = await server.ssrLoadModule(
        "/apps/inspector/src/annotation/source-identity.ts",
      );
      const { renderSvgPages } = await server.ssrLoadModule("/packages/beatmap-lens/src/index.ts");
      const bytes = Uint8Array.from(task.sourceBytes);
      const { chart } = await inspectOsuSourceV1(bytes);
      const range = {
        startMs:
          values["start-ms"] === undefined
            ? task.structure.range.startMs
            : Number(values["start-ms"]),
        endMs:
          values["end-ms"] === undefined ? task.structure.range.endMs : Number(values["end-ms"]),
      };
      if (
        !Number.isFinite(range.startMs) ||
        !Number.isFinite(range.endMs) ||
        range.startMs >= range.endMs
      )
        throw new Error("Evidence requires a finite increasing source-ms range.");
      const pages = renderSvgPages(chart, {
        range,
        page: { size: { widthPx: 1600, heightPx: 900 }, columns: "auto" },
        panel: { playfield: { laneWidthPx: 48 }, maxNoteRows: 32 },
        scale: { type: "row-aware" },
        // Worker evidence keeps full-length tails, as the existing labels were judged on them.
        theme: { tailShortenMs: 0 },
      });
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "source.osu"), bytes);
      await writeFile(
        join(destination, "facts.json"),
        serializeCanonicalJson({ source: task.source, ...task.structure }),
      );
      const artifacts = [];
      for (const page of pages) {
        const filename = `page-${String(page.index + 1).padStart(3, "0")}.svg`;
        await writeFile(join(destination, filename), page.svg);
        artifacts.push({ filename, range: page.range, size: page.size });
      }
      const manifest = {
        contract: "beatmap-lens-source-evidence",
        version: 2,
        taskId: task.taskId,
        taskSha256: task.taskSha256,
        sourceSha256: task.source.sha256,
        foundationSha256: task.foundationSha256,
        base: task.base,
        renderedRange: range,
        fullStructure: "facts.json",
        exactSource: "source.osu",
        entryLongNoteOccupancy: task.structure.notes.filter(
          (note) =>
            note.kind === "long" && note.startMs < range.startMs && note.endMs > range.startMs,
        ),
        pages: artifacts,
      };
      await writeFile(join(destination, "manifest.json"), serializeCanonicalJson(manifest));
      process.stdout.write(
        serializeCanonicalJson({
          output: destination,
          noteCount: task.structure.notes.length,
          pageCount: pages.length,
          taskSha256: task.taskSha256,
        }),
      );
    } else if (command === "handoff") {
      const task = await domain.assertTaskPacketV2(await readJson(required("task")));
      const input = await readJson(required("input"));
      const handoff =
        input.contract === "beatmap-lens-agent-handoff"
          ? await domain.validateHandoffV2(input, task)
          : await domain.sealHandoffV2(task, input);
      await output(required("out"), serializeCanonicalJson(handoff));
      process.stdout.write(
        serializeCanonicalJson({
          handoffId: handoff.handoffId,
          taskSha256: handoff.taskSha256,
          proposals: handoff.proposals.length,
          output: resolve(required("out")),
        }),
      );
    } else if (command === "audit") {
      const task = await domain.assertTaskPacketV2(await readJson(required("task")));
      const handoff = await domain.validateHandoffV2(await readJson(required("handoff")), task);
      const input = await readJson(required("input"));
      const audit =
        input.contract === "beatmap-lens-independent-audit"
          ? await domain.validateAuditV2(input, task, handoff)
          : await domain.sealAuditV2(task, handoff, input);
      await output(required("out"), serializeCanonicalJson(audit));
      process.stdout.write(
        serializeCanonicalJson({
          auditId: audit.auditId,
          handoffId: audit.handoffId,
          handoffSha256: audit.handoffSha256,
          claims: audit.claims.length,
          output: resolve(required("out")),
        }),
      );
    } else if (command === "review-status" || command === "expert-queue") {
      const bytes = values.source ? new Uint8Array(await readFile(values.source)) : undefined;
      const document = await domain.assertReviewDocumentV2(
        JSON.parse(await readCanonicalWorkflowFile(required("file"))),
        bytes,
      );
      const reviews =
        command === "expert-queue"
          ? await domain.readExpertQueueV2(document)
          : await domain.readAgentReviewsV2(document);
      const text = serializeCanonicalJson({
        contract:
          command === "expert-queue"
            ? "beatmap-lens-expert-queue"
            : "beatmap-lens-agent-review-status",
        version: 2,
        sourceSha256: document.source.sha256,
        foundationSha256: await domain.hashWorkflowValueV2(document.foundation),
        reviewRevision: document.reviewRevision,
        count: reviews.length,
        reviews,
      });
      if (values.out) await output(values.out, text);
      else process.stdout.write(text);
    } else if (command === "dispositions") {
      const input = JSON.parse(await readCanonicalWorkflowFile(required("file")));
      let result;
      if (input.contract === "beatmap-lens-human-dispositions" && input.version === 2) {
        // This is an Inspector-produced view, not a canonical import or source-verified document.
        result = input;
      } else {
        const bytes = values.source ? new Uint8Array(await readFile(values.source)) : undefined;
        const document = await domain.assertReviewDocumentV2(input, bytes);
        result = await domain.readDispositionsV2(document);
      }
      const text = serializeCanonicalJson(result);
      if (values.out) await output(values.out, text);
      else process.stdout.write(text);
    } else {
      throw new Error(`Unknown command ${command}. Use --help.`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await server.close();
  }
}

async function networkExchange() {
  const base = required("server");
  let path;
  let submission;
  if (command === "inbox") path = "/api/review/inbox";
  else if (command === "register-source") {
    required("out");
    const foundationSourceSha256 = required("foundation-source-sha");
    const foundationSha256 = required("foundation-sha");
    const sourceBytes = Array.from(await readFile(required("source")));
    path = "/api/review/source";
    submission = { sourceBytes, foundationSourceSha256, foundationSha256 };
  } else if (command === "fetch-task" || command === "dispositions") {
    const source = encodeURIComponent(required("source-sha"));
    path = `/api/review/${command === "fetch-task" ? "task" : "dispositions"}/${source}`;
    if (command === "fetch-task") required("out");
    if (command === "fetch-task" && values.fresh) submission = {};
  } else {
    const packet = await readJson(required("input"));
    const kind =
      packet.contract === "beatmap-lens-agent-handoff"
        ? "handoff"
        : packet.contract === "beatmap-lens-independent-audit"
          ? "audit"
          : packet.requestId && packet.reason === "spot-check"
            ? "review-request"
            : undefined;
    if (!kind || (kind !== "review-request" && packet.version !== 2))
      throw new Error("submit requires a sealed V2 handoff/audit or a spot-check review request.");
    path = "/api/review/submit";
    submission = { kind, packet };
  }
  const url = new URL(path, base);
  const response = await fetch(
    url,
    submission
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(submission),
        }
      : undefined,
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${result.error ?? response.statusText}`);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (values.out) await output(values.out, text);
  else process.stdout.write(text);
  if (command === "submit" && result.status === "error")
    throw new Error(`Submission rejected: ${result.error ?? "See the submission receipt."}`);
}

function required(name) {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function output(path, text) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, text);
}
