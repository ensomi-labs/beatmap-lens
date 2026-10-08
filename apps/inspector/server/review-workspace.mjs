import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { gzip } from "node:zlib";
import { resolveReviewAudio, streamReviewAudio } from "./review-audio.mjs";
import { createCommunityTagReader } from "./review-community-tags.mjs";
import { buildGoldenSet } from "./review-golden-set.mjs";
import { atomicWrite, LocalDirectoryHandle } from "./workflow-local-directory.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const compress = promisify(gzip);
const require = createRequire(new URL("../package.json", import.meta.url));
const packetContracts = {
  handoff: "beatmap-lens-agent-handoff",
  audit: "beatmap-lens-independent-audit",
};

/** One local writer owns both HTTP commands and filesystem exchange delivery. */
export async function startReviewWorkspace(options) {
  const workspace = resolve(options.workspace);
  const dataset = resolve(
    options.dataset ??
      process.env.ENSOMI_DATASET ??
      join(process.env.ENSOMI_ROOT ?? join(repo, "../ensomi-model"), "dataset"),
  );
  const communityTags = createCommunityTagReader(dataset);
  const exchange = join(workspace, "exchange");
  const staticRoot = resolve(options.staticRoot ?? join(repo, "apps/inspector/dist"));
  for (const name of ["inbox", "outbox", "receipts", "requests"]) {
    await mkdir(join(exchange, name), { recursive: true });
  }
  const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
  const vite = await createServer({
    root: repo,
    configFile: false,
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { "beatmap-lens": join(repo, "packages/beatmap-lens/src/index.ts") } },
  });
  const domain = await vite.ssrLoadModule("/apps/inspector/src/annotation/workflow/domain.ts");
  const { confidenceObservationSummaries } = await vite.ssrLoadModule(
    "/apps/inspector/src/annotation/workflow/confidence-review.ts",
  );
  const { encodeReviewResponse } = await vite.ssrLoadModule(
    "/apps/inspector/src/annotation/workflow/review-transport.ts",
  );
  const { WorkflowDirectoryV2 } = await vite.ssrLoadModule(
    "/apps/inspector/src/annotation/workflow/directory.ts",
  );
  const { serializeCanonicalJson } = await vite.ssrLoadModule(
    "/apps/inspector/src/annotation/canonical-json.ts",
  );
  const { parseOsu, getLastPropertyValue } = await vite.ssrLoadModule(
    "/packages/beatmap-lens/src/parser.ts",
  );
  const directory = new WorkflowDirectoryV2(new LocalDirectoryHandle(workspace));
  const receipts = new Map();
  const requests = new Map();
  // Full documents include large frozen source/Foundation snapshots; inbox summaries never do.
  const sources = new Map();
  const summaries = new Map();
  let fullSourceReads = 0;
  const errors = [];
  let pending = Promise.resolve();
  const exclusive = (operation) => {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  };
  const json = (value) => serializeCanonicalJson(value);
  const digest = (value) => createHash("sha256").update(value).digest("hex");

  async function sourceStamp(sha) {
    if (!/^[a-f\d]{64}$/.test(sha)) throw httpError(400, "Invalid source SHA-256.");
    const filename = join(workspace, "workflow", `${sha}.v2.json`);
    const info = await stat(filename).catch((error) => {
      if (error.code === "ENOENT")
        throw httpError(404, "Source is not registered in this workspace.");
      throw error;
    });
    // Cached projections must follow the current review semantics, not frozen packet metadata.
    return `review-trust-v2:${info.mtimeMs}:${info.size}`;
  }

  async function source(sha) {
    const stamp = await sourceStamp(sha);
    const cached = sources.get(sha);
    if (cached?.stamp === stamp) {
      sources.delete(sha);
      sources.set(sha, cached);
      return cached;
    }
    const stored = await directory.read(sha);
    fullSourceReads++;
    const task = stored.document.tasks.at(-1);
    if (!task)
      throw httpError(400, "This source has no registered task containing its exact bytes.");
    const value = {
      stamp,
      stored,
      sourceBytes: Uint8Array.from(task.sourceBytes),
      task,
    };
    const { document, version } = stored;
    const agentReviews = await domain.readAgentReviewsV2(document);
    const handoffsById = new Map(
      document.handoffs.map(({ handoff }) => [handoff.handoffId, handoff]),
    );
    const auditsById = new Map((document.audits ?? []).map(({ audit }) => [audit.auditId, audit]));
    const reviews = agentReviews.map(
      ({
        handoffId,
        claimId,
        claim,
        status,
        trust,
        rationale,
        question,
        expertReason,
        supersededBy,
        audits,
      }) => ({
        handoffId,
        claimId,
        tagId: claim.tagId,
        scope: claim.scope,
        ...(claim.playbackRate !== undefined ? { playbackRate: claim.playbackRate } : {}),
        status,
        trust,
        rationale,
        agent: handoffsById.get(handoffId).agent,
        submittedAt: handoffsById.get(handoffId).createdAt,
        audits: audits.map(({ auditId, result }) => {
          const audit = auditsById.get(auditId);
          return {
            auditId,
            agent: audit.agent,
            createdAt: audit.createdAt,
            outcome: result.outcome,
          };
        }),
        ...(question ? { question } : {}),
        ...(expertReason ? { expertReason } : {}),
        ...(supersededBy ? { supersededBy } : {}),
      }),
    );
    const counts = { total: reviews.length };
    for (const row of reviews) counts[row.status] = (counts[row.status] ?? 0) + 1;
    const currentSummary = {
      stamp,
      row: {
        source: document.source,
        version,
        updatedAt: document.updatedAt,
        latestTaskId: task.taskId,
        counts,
        humanObservations: confidenceObservationSummaries(document),
        expertQueue: reviews.filter((row) => row.status === "needs-expert"),
        reviews,
      },
      decidedClaims: new Set(
        document.decisions.map((decision) => json([decision.handoffId, decision.claimId])),
      ),
      handoffs: new Map(
        document.handoffs.map((entry) => [
          entry.handoff.handoffId,
          {
            sha256: entry.handoffSha256,
            claimIds: new Set(entry.handoff.proposals.map((claim) => claim.id)),
          },
        ]),
      ),
    };
    currentSummary.feedback = await createFeedback(value, agentReviews, currentSummary);
    summaries.set(sha, currentSummary);
    await saveSummary(sha, currentSummary);
    sources.delete(sha);
    sources.set(sha, value);
    while (sources.size > 1) sources.delete(sources.keys().next().value);
    return value;
  }

  function sourceAudio(current) {
    current.audioFilename ??=
      getLastPropertyValue(
        parseOsu(new TextDecoder().decode(current.sourceBytes)),
        "General",
        "AudioFilename",
      )?.trim() ?? "";
    return resolveReviewAudio(dataset, current.stored.document.source, current.audioFilename);
  }

  async function summary(sha) {
    const stamp = await sourceStamp(sha);
    if (summaries.get(sha)?.stamp !== stamp) {
      const saved = await readFile(
        join(exchange, "outbox", `${sha}.feedback-cache.json`),
        "utf8",
      ).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const cached = saved ? JSON.parse(saved) : undefined;
      if (cached?.stamp === stamp && cached.row.source.sha256 === sha) {
        summaries.set(sha, {
          ...cached,
          restored: true,
          decidedClaims: new Set(cached.decidedClaims),
          handoffs: new Map(
            cached.handoffs.map(([id, value]) => [
              id,
              { ...value, claimIds: new Set(value.claimIds) },
            ]),
          ),
        });
      } else await source(sha);
    }
    return summaries.get(sha);
  }

  async function saveSummary(sha, current) {
    await atomicWrite(
      join(exchange, "outbox", `${sha}.feedback-cache.json`),
      json({
        ...current,
        decidedClaims: [...current.decidedClaims],
        handoffs: [...current.handoffs].map(([id, value]) => [
          id,
          { ...value, claimIds: [...value.claimIds] },
        ]),
      }),
    );
  }

  function reviewRequests(current) {
    return [...requests.values()]
      .filter((request) => request.sourceSha256 === current.row.source.sha256)
      .map((request) => ({
        ...request,
        pendingClaimIds: request.claimIds.filter(
          (claimId) => !current.decidedClaims.has(json([request.handoffId, claimId])),
        ),
      }));
  }

  async function dispositions(sha) {
    const { stored } = await source(sha);
    const original = await domain.readDispositionsV2(stored.document);
    const trust = await resolveHandoffTrust(summaries.get(sha));
    const value = {
      ...original,
      agentReviews: original.agentReviews.map((row) => ({ ...row, trust: trust[row.handoffId] })),
      handoffs: original.handoffs.map((row) => ({ ...row, trust: trust[row.handoffId] })),
      documentVersion: stored.version,
      reviewRequests: reviewRequests(summaries.get(sha)),
      handoffTrust: trust,
    };
    await atomicWrite(join(exchange, "outbox", `${sha}.dispositions.json`), json(value));
    return value;
  }

  async function feedback(sha) {
    const current = await summary(sha);
    const trust = await resolveHandoffTrust(current);
    return {
      ...current.feedback,
      agentReviews: current.feedback.agentReviews.map((row) => ({
        ...row,
        trust: trust[row.handoffId],
      })),
      handoffs: current.feedback.handoffs.map((row) => ({ ...row, trust: trust[row.handoffId] })),
      reviewRequests: reviewRequests(current),
    };
  }

  // Reference freshness is computed on read: changing another chart's gold must be
  // visible even when this chart's persisted summary has not changed.
  async function resolveHandoffTrust(current) {
    const referenced = new Map();
    const result = {};
    for (const handoff of current.feedback.handoffs) {
      const packets = [
        handoff,
        ...current.feedback.audits.filter((audit) => audit.handoffId === handoff.handoffId),
      ];
      let humanContext = packets.some((packet) => packet.humanEvidenceRefs === undefined)
        ? "untracked"
        : "current";
      for (const ref of packets.flatMap((packet) => packet.humanEvidenceRefs ?? [])) {
        if (!referenced.has(ref.sourceSha256)) {
          let evidence;
          try {
            evidence =
              ref.sourceSha256 === current.row.source.sha256
                ? current
                : await summary(ref.sourceSha256);
          } catch (error) {
            if (error.status !== 404) throw error;
          }
          referenced.set(
            ref.sourceSha256,
            evidence
              ? new Map(
                  evidence.feedback.effectiveHumanObservations
                    .filter(
                      (observation) =>
                        observation.trust.source === "current" &&
                        observation.trust.foundation === "current",
                    )
                    .map((observation) => [observation.id, observation.observationSha256]),
                )
              : undefined,
          );
        }
        const observations = referenced.get(ref.sourceSha256);
        if (observations && observations.get(ref.observationId) !== ref.observationSha256)
          humanContext = "changed";
        else if (!observations && humanContext !== "changed") humanContext = "untracked";
      }
      result[handoff.handoffId] = { ...handoff.trust, humanContext };
    }
    return result;
  }

  async function createFeedback({ stored, task }, reviews, current) {
    const { document, version } = stored;
    const observations = new Map(document.observations.map((entry) => [entry.id, entry]));
    const baseStatuses = new Map(reviews.map((row) => [row.handoffId, row.baseStatus]));
    const trusts = new Map(reviews.map((row) => [row.handoffId, row.trust]));
    const foundationSha256 = await domain.hashWorkflowValueV2(document.foundation);
    const effectiveHumanObservations = await Promise.all(
      domain.effectiveHumanObservationsV2(document).map(async (observation) => {
        const { claim, ...entry } = observation;
        const decision =
          observation.origin.kind === "agent-proposal"
            ? document.decisions.find((row) => row.id === observation.origin.decisionId)
            : undefined;
        return {
          ...entry,
          summary: claimSummary(claim),
          humanComment: decision ? decision.rationale : claim.evidence.rationale,
          observationSha256: await domain.hashWorkflowValueV2(observation),
          trust: {
            source: "current",
            foundation: observation.foundationSha256 === foundationSha256 ? "current" : "changed",
          },
        };
      }),
    );
    const effectiveById = new Map(effectiveHumanObservations.map((row) => [row.id, row]));
    return {
      contract: "beatmap-lens-agent-feedback",
      version: 2,
      sourceSha256: document.source.sha256,
      documentVersion: version,
      reviewBase: await domain.baseForTaskV2(document),
      taskBinding: taskBinding(task),
      counts: current.row.counts,
      agentReviews: reviews.map((row) => ({
        handoffId: row.handoffId,
        claimId: row.claimId,
        status: row.status,
        baseStatus: row.baseStatus,
        trust: row.trust,
        summary: claimSummary(row.claim),
        audits: row.audits.map(({ auditId, result }) => ({ auditId, result })),
        ...(row.decision ? { decision: row.decision } : {}),
        ...(row.decision?.observationId
          ? { observationSha256: effectiveById.get(row.decision.observationId)?.observationSha256 }
          : {}),
        ...(row.supersededBy ? { supersededBy: row.supersededBy } : {}),
        ...(row.decision?.disposition === "modified"
          ? { modifiedClaim: observations.get(row.decision.observationId).claim }
          : {}),
        ...(row.expertReason ? { expertReason: row.expertReason } : {}),
        ...(row.question ? { question: row.question } : {}),
      })),
      handoffs: await Promise.all(
        document.handoffs.map(async ({ handoff, handoffSha256, baseStatus }) => ({
          handoffId: handoff.handoffId,
          handoffSha256,
          ...(handoff.supersedes ? { supersedes: handoff.supersedes } : {}),
          ...(handoff.humanEvidenceRefs === undefined
            ? {}
            : { humanEvidenceRefs: handoff.humanEvidenceRefs }),
          trust:
            trusts.get(handoff.handoffId) ??
            (await domain.handoffTrustV2(document, handoff.handoffId)),
          ...taskBinding(handoff),
          agent: handoff.agent,
          baseStatus:
            baseStatuses.get(handoff.handoffId) ??
            (await domain.handoffBaseStatusV2(document, handoff.handoffId)),
          importedBaseStatus: baseStatus,
          embeddedAudit: handoff.audit,
          questions: handoff.questions,
        })),
      ),
      audits: (document.audits ?? []).map(({ audit, auditSha256, baseStatus }) => ({
        auditId: audit.auditId,
        auditSha256,
        handoffId: audit.handoffId,
        handoffSha256: audit.handoffSha256,
        ...taskBinding(audit),
        agent: audit.agent,
        ...(audit.humanEvidenceRefs === undefined
          ? {}
          : { humanEvidenceRefs: audit.humanEvidenceRefs }),
        importedBaseStatus: baseStatus,
        questions: audit.questions,
      })),
      effectiveHumanObservations,
      directObservations: effectiveHumanObservations.filter(
        (entry) => entry.origin.kind === "direct-human",
      ),
    };
  }

  function taskBinding(packet) {
    return {
      taskId: packet.taskId,
      taskSha256: packet.taskSha256,
      foundationSha256: packet.foundationSha256,
      base: packet.base,
    };
  }

  function claimSummary(claim) {
    const { evidence, transition, ...fields } = claim;
    const summarizeEvidence = ({ rationale, noteRefs, contextNoteRefs }) => ({
      rationale,
      witnessCount: noteRefs.length,
      contextNoteCount: contextNoteRefs.length,
    });
    return {
      ...fields,
      ...summarizeEvidence(evidence),
      ...(transition
        ? {
            transition: {
              range: transition.range,
              description: transition.description,
              ...summarizeEvidence(transition.evidence),
            },
          }
        : {}),
    };
  }

  async function saveReceipt(receipt) {
    await atomicWrite(join(exchange, "receipts", `${receipt.id}.json`), json(receipt));
    receipts.set(receipt.id, receipt);
    return receipt;
  }

  async function validateRequest(input) {
    exactKeys(input, [
      "requestId",
      "sourceSha256",
      "handoffId",
      "handoffSha256",
      "claimIds",
      "reason",
      "question",
      "requestedBy",
      "createdAt",
    ]);
    for (const key of ["requestId", "question", "createdAt"]) nonempty(input[key], key);
    if (!Number.isFinite(Date.parse(input.createdAt)))
      throw new Error("Invalid request createdAt.");
    if (input.reason !== "spot-check")
      throw new Error("Only explicit spot-check delivery is supported.");
    exactKeys(input.requestedBy, ["producerId", "role"]);
    nonempty(input.requestedBy.producerId, "requestedBy.producerId");
    if (!["labeler", "auditor", "curator"].includes(input.requestedBy.role)) {
      throw new Error("Unsupported review requester role.");
    }
    const original = (await summary(input.sourceSha256)).handoffs.get(input.handoffId);
    if (!original) return null;
    if (original.sha256 !== input.handoffSha256) {
      throw new Error("Review request targets different immutable handoff content.");
    }
    if (
      !Array.isArray(input.claimIds) ||
      !input.claimIds.length ||
      new Set(input.claimIds).size !== input.claimIds.length ||
      input.claimIds.some((id) => !original.claimIds.has(id))
    )
      throw new Error("Review request must name existing unique claims in the original handoff.");
    return input;
  }

  async function processPacket(envelope, receiptId, receivedAt) {
    const previous = receipts.get(receiptId);
    if (previous && previous.status !== "pending") return previous;
    const { kind, packet } = envelope;
    const receipt = {
      id: receiptId,
      kind,
      receivedAt,
      ...(typeof packet.sourceSha256 === "string" ? { sourceSha256: packet.sourceSha256 } : {}),
      ...((
        kind === "audit"
          ? packet.auditId
          : kind === "handoff"
            ? packet.handoffId
            : packet.requestId
      )
        ? {
            packetId:
              kind === "audit"
                ? packet.auditId
                : kind === "handoff"
                  ? packet.handoffId
                  : packet.requestId,
          }
        : {}),
    };
    try {
      exactKeys(envelope, ["kind", "packet"]);
      if (!["handoff", "audit", "review-request"].includes(kind))
        throw new Error("Unsupported machine submission kind.");
      if (kind !== "review-request" && packet.contract !== packetContracts[kind]) {
        throw new Error("Submission kind and sealed packet contract disagree.");
      }
      if (kind === "review-request") {
        const request = await validateRequest(packet);
        if (!request)
          return saveReceipt({
            ...receipt,
            status: "pending",
            error: "Waiting for the original handoff.",
          });
        const existing = requests.get(request.requestId);
        if (existing && json(existing) !== json(request))
          throw new Error("Request ID already has different immutable content.");
        if (!existing) {
          await atomicWrite(
            join(exchange, "requests", `${digest(request.requestId)}.json`),
            json(request),
          );
          requests.set(request.requestId, request);
        }
        await dispositions(packet.sourceSha256);
        return saveReceipt({
          ...receipt,
          status: existing ? "duplicate" : "imported",
          processedAt: new Date().toISOString(),
        });
      }
      if (
        kind === "audit" &&
        !(await summary(packet.sourceSha256)).handoffs.has(packet.handoffId)
      ) {
        return saveReceipt({
          ...receipt,
          status: "pending",
          error: "Waiting for the original handoff.",
        });
      }
      const current = await source(packet.sourceSha256);
      const result = await directory[kind === "handoff" ? "importHandoff" : "importAudit"](
        current.sourceBytes,
        current.stored.version,
        packet,
      );
      sources.delete(packet.sourceSha256);
      await dispositions(packet.sourceSha256);
      return saveReceipt({
        ...receipt,
        status: result.status,
        baseStatus: result.baseStatus,
        processedAt: new Date().toISOString(),
      });
    } catch (error) {
      return saveReceipt({
        ...receipt,
        status: "error",
        error: error.message,
        processedAt: new Date().toISOString(),
      });
    }
  }

  async function processInbox() {
    const incoming = [];
    for (const name of (await readdir(join(exchange, "inbox")))
      .filter((name) => name.endsWith(".json"))
      .sort()) {
      const text = await readFile(join(exchange, "inbox", name), "utf8");
      try {
        const value = JSON.parse(text);
        const envelope =
          value.kind && value.packet
            ? value
            : {
                kind:
                  value.contract === packetContracts.handoff
                    ? "handoff"
                    : value.contract === packetContracts.audit
                      ? "audit"
                      : "review-request",
                packet: value,
              };
        const id = digest(json(envelope));
        if (receipts.has(id) && receipts.get(id).status !== "pending") continue;
        incoming.push({
          envelope,
          id,
          receivedAt: receipts.get(id)?.receivedAt ?? new Date().toISOString(),
          name,
        });
      } catch (error) {
        const id = digest(text);
        if (!receipts.has(id))
          await saveReceipt({
            id,
            filename: name,
            status: "error",
            error: error.message,
            receivedAt: new Date().toISOString(),
            processedAt: new Date().toISOString(),
          });
      }
    }
    const rank = { handoff: 0, audit: 1, "review-request": 2 };
    incoming.sort(
      (a, b) =>
        (rank[a.envelope.kind] ?? 3) - (rank[b.envelope.kind] ?? 3) || a.name.localeCompare(b.name),
    );
    for (const item of incoming) await processPacket(item.envelope, item.id, item.receivedAt);
  }

  async function inbox(exportDispositions = false) {
    const rows = [];
    const files = await readdir(join(workspace, "workflow")).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const filename of files.filter((name) => /^[a-f\d]{64}\.v2\.json$/.test(name)).sort()) {
      try {
        const current = await summary(filename.slice(0, 64));
        const trust = await resolveHandoffTrust(current);
        const displayedClaims = new Map(
          current.feedback.agentReviews.map((review) => [
            json([review.handoffId, review.claimId]),
            review.modifiedClaim ?? review.summary,
          ]),
        );
        const humanClaims = current.feedback.effectiveHumanObservations.map(
          (observation) => observation.summary,
        );
        const humanAssessmentCounts = { settled: 0, unresolved: 0, unreviewed: 0 };
        for (const claim of humanClaims) {
          const presence = claim.assessment.presence;
          humanAssessmentCounts[
            presence === "present" || presence === "absent" ? "settled" : presence
          ]++;
        }
        rows.push({
          ...current.row,
          humanObservations:
            current.row.humanObservations ??
            current.feedback.effectiveHumanObservations.map((observation) => ({
              id: observation.id,
              previousIds: observation.supersedesObservationId
                ? [observation.supersedesObservationId]
                : [],
              ...(observation.confidence ? { confidence: observation.confidence } : {}),
              tagId: observation.summary.tagId,
              scope: observation.summary.scope,
              assessment: observation.summary.assessment,
              playbackRate: observation.summary.playbackRate ?? 1,
            })),
          reviews: current.row.reviews.map((review) => ({
            ...review,
            trust: trust[review.handoffId],
            assessment: displayedClaims.get(json([review.handoffId, review.claimId])).assessment,
            scope: displayedClaims.get(json([review.handoffId, review.claimId])).scope,
            tagId: displayedClaims.get(json([review.handoffId, review.claimId])).tagId,
            playbackRate:
              displayedClaims.get(json([review.handoffId, review.claimId])).playbackRate ?? 1,
          })),
          humanAssessmentCounts,
          requests: reviewRequests(current),
        });
        if (exportDispositions && !current.restored) await dispositions(filename.slice(0, 64));
      } catch (error) {
        if (!errors.some((entry) => entry.filename === filename && entry.error === error.message))
          errors.push({ filename, error: error.message });
      }
    }
    return { workspace, sources: rows, receipts: [...receipts.values()], errors };
  }

  async function goldenSet() {
    const inventory = async () => {
      const names = (await readdir(join(workspace, "workflow")))
        .filter((name) => /^[a-f\d]{64}\.v2\.json$/.test(name))
        .sort();
      return Promise.all(
        names.map(async (name) => [name.slice(0, 64), await sourceStamp(name.slice(0, 64))]),
      );
    };
    const before = await inventory();
    const current = new Map();
    for (const [sha] of before) current.set(sha, await summary(sha));
    const result = await buildGoldenSet(
      [...current.values()].map(({ row, feedback }) => ({
        sourceSha256: row.source.sha256,
        documentVersion: row.version,
        effectiveHumanObservations: feedback.effectiveHumanObservations,
      })),
    );
    if (json(before) !== json(await inventory()))
      throw httpError(
        409,
        "Human judgments changed while loading the golden set. Refresh to read the current set.",
      );
    return {
      ...result,
      checkedAt: new Date().toISOString(),
      cases: result.cases.map((entry) => {
        const { row, feedback } = current.get(entry.sourceSha256);
        const observations = new Map(
          feedback.effectiveHumanObservations.map((observation) => [observation.id, observation]),
        );
        return {
          ...entry,
          source: row.source,
          humans: Object.fromEntries(
            Object.entries(entry.humans).map(([tag, pins]) => [
              tag,
              pins.map((pin) => ({ ...pin, comment: observations.get(pin.id).humanComment })),
            ]),
          ),
        };
      }),
    };
  }

  for (const name of (await readdir(join(exchange, "receipts"))).filter((name) =>
    name.endsWith(".json"),
  )) {
    const receipt = JSON.parse(await readFile(join(exchange, "receipts", name), "utf8"));
    receipts.set(receipt.id, receipt);
  }
  for (const name of (await readdir(join(exchange, "requests"))).filter((name) =>
    name.endsWith(".json"),
  )) {
    const request = await validateRequest(
      JSON.parse(await readFile(join(exchange, "requests", name), "utf8")),
    );
    if (request) requests.set(request.requestId, request);
  }

  async function api(request, response, url) {
    const parts = url.pathname.split("/").filter(Boolean);
    const action = parts[2];
    const sha = parts[3];
    if (action === "audio" && (request.method === "GET" || request.method === "HEAD")) {
      const current = await source(sha);
      const audio = await sourceAudio(current);
      if (!audio) throw httpError(404, "Beatmap audio is not available in this dataset.");
      return streamReviewAudio(request, response, audio);
    }
    if (request.method === "GET") {
      if (action === "inbox") return send(response, 200, await inbox(), request);
      if (action === "golden-set") return send(response, 200, await goldenSet(), request);
      if (action === "source") {
        const current = await source(sha);
        const audio = await sourceAudio(current);
        return send(
          response,
          200,
          {
            ...current.stored,
            handoffTrust: await resolveHandoffTrust(summaries.get(sha)),
            sourceBytes: Array.from(current.sourceBytes),
            communityTags: await communityTags(current.stored.document.source),
            audio: audio ? { url: `/api/review/audio/${sha}`, filename: audio.filename } : null,
          },
          request,
        );
      }
      if (action === "task") return send(response, 200, (await source(sha)).task);
      if (action === "dispositions") return send(response, 200, await dispositions(sha));
      if (action === "feedback") return send(response, 200, await feedback(sha));
    }
    if (request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json"))
        throw httpError(400, "Expected application/json.");
      const body = JSON.parse(await readBody(request));
      if (action === "source" && !sha) {
        exactKeys(body, ["sourceBytes", "foundationSourceSha256", "foundationSha256"]);
        if (
          !Array.isArray(body.sourceBytes) ||
          !body.sourceBytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
        )
          throw httpError(400, "sourceBytes must contain exact byte values.");
        const result = await directory.registerSourceFromApprovedFoundation(
          Uint8Array.from(body.sourceBytes),
          { sourceSha256: body.foundationSourceSha256, foundationSha256: body.foundationSha256 },
        );
        sources.delete(result.task.source.sha256);
        await dispositions(result.task.source.sha256);
        return send(response, 200, result.task);
      }
      if (action === "task") {
        exactKeys(body, "taskId" in body ? ["taskId"] : []);
        if ("taskId" in body) nonempty(body.taskId, "taskId");
        const current = await source(sha);
        if (current.stored.document.foundation.approval.status !== "human-approved") {
          throw httpError(
            400,
            "The current Foundation needs human approval before agent task issuance.",
          );
        }
        const result = await directory.exportTask(
          current.sourceBytes,
          current.stored.version,
          body,
        );
        sources.delete(sha);
        await dispositions(sha);
        return send(response, 200, result.task);
      }
      if (action === "submit") {
        exactKeys(body, ["kind", "packet"]);
        if (!body.packet || typeof body.packet !== "object")
          throw httpError(400, "Expected a sealed packet.");
        const id = digest(json(body));
        const filename = `${id}.json`;
        await atomicWrite(join(exchange, "inbox", filename), json(body));
        const receipt = await processPacket(
          body,
          id,
          receipts.get(id)?.receivedAt ?? new Date().toISOString(),
        );
        await processInbox();
        return send(response, receipt.status === "error" ? 400 : 200, receipts.get(id));
      }
      if (action === "human") {
        exactKeys(body, ["expectedBase", "input"]);
        const current = await source(sha);
        const operation = parts[4];
        let result;
        if (["decide", "decideSection", "addObservations"].includes(operation))
          result = await directory[operation](current.sourceBytes, body.expectedBase, body.input);
        else if (operation === "exportTask")
          result = await directory.exportTask(current.sourceBytes, body.expectedBase, body.input);
        else if (operation === "approveFoundation") {
          exactKeys(body.input, ["humanId"]);
          result = await directory.approveFoundation(
            current.sourceBytes,
            body.expectedBase,
            body.input.humanId,
          );
        } else throw httpError(400, "Unsupported human command.");
        sources.delete(sha);
        await dispositions(sha);
        return send(response, 200, result, request);
      }
    }
    throw httpError(404, "Unknown review endpoint.");
  }

  async function send(response, status, value, request) {
    const shared = request?.headers["x-review-transport"] === "shared-v1";
    const text = shared ? encodeReviewResponse(value) : json(value);
    const compressed = shared && /\bgzip\b/.test(request.headers["accept-encoding"] ?? "");
    const body = compressed ? await compress(text, { level: 1 }) : text;
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: "X-Review-Transport, Accept-Encoding",
      ...(compressed ? { "Content-Encoding": "gzip" } : {}),
    });
    response.end(body);
  }

  let port;
  let closing = false;
  let closePromise;
  const server = createHttpServer((request, response) => {
    if (closing) {
      response.setHeader("Connection", "close");
      send(response, 503, { error: "Review service is shutting down. Retry after restart." });
      request.resume();
      return;
    }
    exclusive(async () => {
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host)) {
        throw httpError(403, "Only the local Review service host is allowed.");
      }
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/review/")) {
        // Same-origin browser writes and explicit local HTTP clients use separate machine/human routes.
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}`)
          throw httpError(403, "Cross-origin review access is not allowed.");
        return api(request, response, url);
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        throw httpError(405, "Read-only static content.");
      const requested =
        url.pathname === "/" || url.pathname === "/review"
          ? "index.html"
          : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const filename = resolve(staticRoot, requested);
      if (!filename.startsWith(`${staticRoot}${sep}`)) throw httpError(404, "Unknown static file.");
      let content;
      try {
        content = await readFile(filename);
      } catch (error) {
        if (error.code === "ENOENT")
          throw httpError(404, "Inspector build is missing. Build apps/inspector first.");
        throw error;
      }
      const mime = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".png": "image/png",
        ".json": "application/json",
      };
      response.writeHead(200, {
        "Content-Type": `${mime[extname(filename)] ?? "application/octet-stream"}; charset=utf-8`,
        "Cache-Control": "no-cache",
      });
      response.end(request.method === "HEAD" ? undefined : content);
    }).catch((error) => {
      if (response.headersSent) return response.end();
      send(response, error.name === "WorkflowConflictError" ? 409 : (error.status ?? 400), {
        error: error.message,
        ...(error.name === "WorkflowConflictError" ? { actual: error.actual } : {}),
      });
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4176, "127.0.0.1", resolveListen);
  });
  port = server.address().port;
  await exclusive(async () => {
    await processInbox();
    // Keep startup hydration serialized with already connected browser polling.
    await inbox(true);
  });
  let scanning = false;
  const timer = setInterval(() => {
    if (scanning) return;
    scanning = true;
    exclusive(processInbox)
      .catch((error) => errors.push({ error: error.message }))
      .finally(() => {
        scanning = false;
      });
  }, options.pollIntervalMs ?? 1000);
  timer.unref();
  return {
    url: `http://127.0.0.1:${port}`,
    cacheInfo: () => ({ fullSources: sources.size, summaries: summaries.size, fullSourceReads }),
    processInbox: () => exclusive(processInbox),
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(timer);
      const stopped = new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      closePromise = (async () => {
        // Already admitted commands must finish saving before streams/sockets are destroyed.
        await pending;
        server.closeAllConnections();
        await stopped;
        await vite.close();
      })();
      return closePromise;
    },
  };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function exactKeys(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in value))
  ) {
    throw httpError(400, `Expected only ${keys.join(", ")}.`);
  }
}

function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be nonempty text.`);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      workspace: { type: "string" },
      port: { type: "string" },
      dataset: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !values.workspace) {
    process.stdout.write(
      "Local Review writer\n  node apps/inspector/server/review-workspace.mjs --workspace PATH [--port 4176] [--dataset PATH]\n\nOpen /review. Agents submit handoff, audit or review-request packets through\n/api/review/submit or exchange/inbox/*.json, and read exchange/outbox dispositions.\n",
    );
    process.exit(values.help ? 0 : 1);
  }
  const service = await startReviewWorkspace({
    workspace: values.workspace,
    port: values.port ? Number(values.port) : 4176,
    dataset: values.dataset,
  });
  process.stdout.write(
    `${JSON.stringify({ url: `${service.url}/review`, workspace: resolve(values.workspace) })}\n`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => service.close().then(() => process.exit(0)));
}
