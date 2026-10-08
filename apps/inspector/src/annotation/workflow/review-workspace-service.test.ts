import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { Agent, get as httpGet, request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { serializeCanonicalJson } from "../canonical-json";
import {
  createReviewDocumentV2,
  createTaskPacketV2,
  hashWorkflowValueV2,
  importHandoffV2,
  registerTaskV2,
  sealAuditV2,
  sealHandoffV2,
} from "./domain";
import { decodeReviewResponse } from "./review-transport";
import { historicalAcceptance, NOW, workflowFixture } from "./test-fixtures";

const serviceUrl = pathToFileURL(resolve("apps/inspector/server/review-workspace.mjs")).href;
const exec = promisify(execFile);
const { startReviewWorkspace } = await import(/* @vite-ignore */ serviceUrl);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const f = await workflowFixture();
  const workspace = await mkdtemp(join(tmpdir(), "review-service-"));
  cleanups.push(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "workflow"));
  await writeFile(
    join(workspace, "workflow", `${f.inspected.source.sha256}.v2.json`),
    serializeCanonicalJson(f.registered),
  );
  const handoff = await sealHandoffV2(f.task, {
    handoffId: "parallel-handoff",
    createdAt: NOW,
    agent: { role: "labeler", producerId: "service-labeler" },
    proposals: f.handoff.proposals.slice(0, 2),
    audit: [],
    questions: [],
  });
  const audit = await sealAuditV2(f.task, handoff, {
    auditId: "independent-service-audit",
    createdAt: NOW,
    agent: { role: "auditor", producerId: "service-auditor" },
    claims: handoff.proposals.map((claim) => ({
      claimId: claim.id,
      outcome: "supported",
      rationale: "Independent source review agrees with this synthetic fixture claim.",
    })),
    questions: [],
  });
  const request = {
    requestId: "two-claim-spot-check",
    sourceSha256: f.inspected.source.sha256,
    handoffId: handoff.handoffId,
    handoffSha256: await hashWorkflowValueV2(handoff),
    claimIds: handoff.proposals.map((claim) => claim.id),
    reason: "spot-check",
    question: "Please spot-check these two fixture claims independently.",
    requestedBy: { producerId: "service-curator", role: "curator" },
    createdAt: NOW,
  };
  return { ...f, workspace, handoff, audit, request, sha: f.inspected.source.sha256 };
}

async function start(workspace: string, dataset?: string, port = 0) {
  const service = await startReviewWorkspace({ workspace, dataset, port, pollIntervalMs: 25 });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await service.close();
  };
  cleanups.push(close);
  return { ...service, close };
}

async function post(url: string, pathname: string, body: unknown) {
  const response = await fetch(`${url}/api/review/${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, value: await response.json() };
}

async function get(url: string, pathname: string) {
  const response = await fetch(`${url}/api/review/${pathname}`);
  expect(response.status).toBe(200);
  return response.json();
}

describe("local Review service exchange", () => {
  it("browses the exact current gate selection without saving and follows confidence revisions", async () => {
    const f = await fixture();
    const service = await start(f.workspace);
    const initial = await get(service.url, `source/${f.sha}`);
    const claims = [
      { ...f.claim, id: "high-one" },
      { ...f.claim, id: "high-two", playbackRate: 1 },
      { ...f.claim, id: "slow-high", playbackRate: 0.75 },
      { ...f.claim, id: "low" },
      { ...f.claim, id: "unspecified" },
    ];
    const saved = await post(service.url, `human/${f.sha}/addObservations`, {
      expectedBase: initial.version,
      input: {
        humanId: "fixture-human",
        claims,
        confidences: { "high-one": "high", "high-two": "high", "slow-high": "high", low: "low" },
      },
    });
    expect(saved.status).toBe(200);
    const canonicalPath = join(f.workspace, "workflow", `${f.sha}.v2.json`);
    const before = await readFile(canonicalPath, "utf8");
    const golden = await get(service.url, "golden-set");
    expect(golden.gateError).toBeUndefined();
    expect(golden.cases).toHaveLength(2);
    expect(
      golden.cases.find((entry: { playbackRate: number }) => entry.playbackRate === 1).humans.tech,
    ).toHaveLength(2);
    const expected = await exec("uv", [
      "run",
      "--locked",
      "python",
      "-c",
      [
        "import json, sys",
        "sys.path.insert(0, 'annotation/evaluation')",
        "from high_confidence_suite import build_suite, current_feedback",
        "print(json.dumps(build_suite(current_feedback(sys.argv[1]), 'reference')['cases']))",
      ].join("\n"),
      f.workspace,
    ]);
    expect(
      golden.cases.map(
        ({
          source: _source,
          humans,
          ...entry
        }: {
          source: unknown;
          humans: Record<string, Array<{ comment?: string }>>;
        }) => ({
          ...entry,
          humans: Object.fromEntries(
            Object.entries(humans).map(([tag, pins]) => [
              tag,
              pins.map(({ comment: _comment, ...pin }) => pin),
            ]),
          ),
        }),
      ),
    ).toEqual(JSON.parse(expected.stdout));
    expect(await readFile(canonicalPath, "utf8")).toBe(before);
    const revised = await post(service.url, `human/${f.sha}/addObservations`, {
      expectedBase: saved.value.version,
      input: {
        humanId: "fixture-human",
        claims: claims.slice(0, 2),
        confidences: { "high-one": "low", "high-two": "low" },
        supersedesObservationIds: Object.fromEntries(
          saved.value.document.observations
            .slice(0, 2)
            .map((observation: { id: string; claim: { id: string } }) => [
              observation.claim.id,
              observation.id,
            ]),
        ),
      },
    });
    expect(revised.status).toBe(200);
    const current = await get(service.url, "golden-set");
    expect(current.cases).toHaveLength(1);
    expect(current.cases[0].playbackRate).toBe(0.75);
    const conflicting = await post(service.url, `human/${f.sha}/addObservations`, {
      expectedBase: revised.value.version,
      input: {
        humanId: "another-fixture-human",
        claims: [
          {
            ...claims[2],
            id: "conflicting-high",
            assessment: { presence: "present", salience: "supporting" },
          },
        ],
        confidences: { "conflicting-high": "high" },
      },
    });
    expect(conflicting.status).toBe(200);
    const blocked = await get(service.url, "golden-set");
    expect(blocked.cases).toEqual([]);
    expect(blocked.gateError).toContain("Conflicting independent current High judgments");
  }, 20_000);

  it("submits a section review atomically through the human command endpoint", async () => {
    const f = await fixture();
    const service = await start(f.workspace);
    expect((await post(service.url, "submit", { kind: "handoff", packet: f.handoff })).status).toBe(
      200,
    );
    const current = await get(service.url, `source/${f.sha}`);
    const decisions = f.handoff.proposals.map((claim) => ({
      handoffId: f.handoff.handoffId,
      claimId: claim.id,
      disposition: "accepted",
    }));
    const saved = await post(service.url, `human/${f.sha}/decideSection`, {
      expectedBase: current.version,
      input: {
        id: "service-section",
        humanId: "expert",
        decisions,
        observations: f.foundation.tags
          .filter((tag) => !f.handoff.proposals.some((claim) => claim.tagId === tag.id))
          .map((tag) => ({
            ...f.claim,
            id: `direct-${tag.id}`,
            tagId: tag.id,
            assessment: { presence: "absent" },
          })),
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.value.document.revision).toBe(current.document.revision + 1);
    expect(saved.value.document.reviewRevision).toBe(current.document.reviewRevision + 1);
    expect(saved.value.document.decisions).toHaveLength(2);
    expect(saved.value.document.observations).toHaveLength(5);
    expect((await get(service.url, `source/${f.sha}`)).version).toEqual(saved.value.version);
    const stale = await post(service.url, `human/${f.sha}/decideSection`, {
      expectedBase: current.version,
      input: { humanId: "expert", decisions },
    });
    expect(stale.status).toBe(409);
    expect((await get(service.url, `source/${f.sha}`)).version).toEqual(saved.value.version);
  });

  it("tracks referenced gold revisions across charts without blocking human review or rewriting packets", async () => {
    const f = await fixture();
    const service = await start(f.workspace);
    const referenceBytes = Array.from(
      new TextEncoder().encode(
        new TextDecoder().decode(f.sourceBytes).replace("Workflow fixture", "Reference fixture"),
      ),
    );
    const registered = await post(service.url, "source", {
      sourceBytes: referenceBytes,
      foundationSourceSha256: f.sha,
      foundationSha256: f.task.foundationSha256,
    });
    expect(registered.status).toBe(200);
    const referenceSha = registered.value.source.sha256;
    const reference = await get(service.url, `source/${referenceSha}`);
    const gold = await post(service.url, `human/${referenceSha}/addObservations`, {
      expectedBase: reference.version,
      input: { claims: [f.claim], humanId: "expert" },
    });
    expect(gold.status).toBe(200);
    const originalObservation = gold.value.document.observations[0];
    const handoff = await sealHandoffV2(f.task, {
      handoffId: "reference-aware-handoff",
      createdAt: NOW,
      agent: f.handoff.agent,
      proposals: [f.claim],
      audit: [],
      questions: [],
      humanEvidenceRefs: [],
    });
    const audit = await sealAuditV2(f.task, handoff, {
      auditId: "reference-aware-audit",
      createdAt: NOW,
      agent: f.audit.agent,
      claims: [{ claimId: f.claim.id, outcome: "supported", rationale: "Independent review." }],
      questions: [],
      humanEvidenceRefs: [
        {
          sourceSha256: referenceSha,
          observationId: originalObservation.id,
          observationSha256: await hashWorkflowValueV2(originalObservation),
        },
      ],
    });
    expect((await post(service.url, "submit", { kind: "handoff", packet: handoff })).status).toBe(
      200,
    );
    expect((await post(service.url, "submit", { kind: "audit", packet: audit })).status).toBe(200);
    const before = await get(service.url, `source/${f.sha}`);
    expect(before.handoffTrust[handoff.handoffId]).toEqual({
      source: "current",
      foundation: "current",
      humanContext: "current",
    });
    // An unrelated additional observation does not invalidate a consulted example.
    const unrelated = await post(service.url, `human/${referenceSha}/addObservations`, {
      expectedBase: gold.value.version,
      input: { claims: [{ ...f.claim, id: "unrelated" }], humanId: "expert" },
    });
    expect(unrelated.status).toBe(200);
    expect((await get(service.url, `feedback/${f.sha}`)).agentReviews[0].trust.humanContext).toBe(
      "current",
    );
    const revised = await post(service.url, `human/${referenceSha}/addObservations`, {
      expectedBase: unrelated.value.version,
      input: {
        claims: [{ ...f.claim, assessment: { presence: "absent" } }],
        humanId: "expert",
        supersedesObservationId: originalObservation.id,
      },
    });
    expect(revised.status).toBe(200);
    expect(revised.value.document.observations[0]).toEqual(originalObservation);
    const feedback = await get(service.url, `feedback/${f.sha}`);
    expect(feedback.agentReviews[0]).toMatchObject({
      status: "agent-reviewed",
      baseStatus: "current",
      trust: { source: "current", foundation: "current", humanContext: "changed" },
    });
    const unchanged = await get(service.url, `source/${f.sha}`);
    expect(unchanged.version).toEqual(before.version);
    expect(unchanged.document.handoffs[0].handoff).toEqual(handoff);
    expect(unchanged.handoffTrust[handoff.handoffId].humanContext).toBe("changed");
    const dispositions = await get(service.url, `dispositions/${f.sha}`);
    expect(dispositions.agentReviews[0].trust.humanContext).toBe("changed");
    expect(dispositions.handoffs[0].trust.humanContext).toBe("changed");
    const inbox = await get(service.url, "inbox");
    expect(
      inbox.sources.find((row: { source: { sha256: string } }) => row.source.sha256 === f.sha)
        .reviews[0].trust.humanContext,
    ).toBe("changed");
    const accepted = await post(service.url, `human/${f.sha}/decide`, {
      expectedBase: unchanged.version,
      input: {
        handoffId: handoff.handoffId,
        claimId: f.claim.id,
        disposition: "accepted",
        humanId: "expert",
        rationale: "Checked current evidence.",
        confidence: "low",
      },
    });
    expect(accepted.status).toBe(200);
    const correction = await post(service.url, `human/${f.sha}/decide`, {
      expectedBase: accepted.value.version,
      input: {
        handoffId: handoff.handoffId,
        claimId: f.claim.id,
        disposition: "modified",
        humanId: "expert",
        rationale: "Revised gold.",
        confidence: "high",
        modifiedClaim: {
          ...f.claim,
          tagId: "streams",
          scope: { startMs: 900, endMs: 1800 },
          assessment: { presence: "absent" },
        },
      },
    });
    expect(correction.status).toBe(200);
    expect(correction.value.document.decisions).toHaveLength(2);
    expect(correction.value.document.observations).toHaveLength(2);
    const correctedInbox = await get(service.url, "inbox");
    expect(
      correctedInbox.sources.find(
        (row: { source: { sha256: string } }) => row.source.sha256 === f.sha,
      ).reviews[0],
    ).toMatchObject({
      tagId: "streams",
      scope: { startMs: 900, endMs: 1800 },
      assessment: { presence: "absent" },
    });
    const currentGold = (await get(service.url, `feedback/${f.sha}`)).effectiveHumanObservations;
    expect(currentGold).toHaveLength(1);
    expect(currentGold[0]).toMatchObject({
      confidence: "high",
      observationSha256: await hashWorkflowValueV2(correction.value.document.observations[1]),
      summary: { assessment: { presence: "absent" } },
      humanComment: "Revised gold.",
    });
    expect(currentGold[0].summary).not.toHaveProperty("confidence");
    // A concurrent editor still must refresh before saving: trust is not a write lock.
    expect(
      (
        await post(service.url, `human/${f.sha}/decide`, {
          expectedBase: accepted.value.version,
          input: {
            handoffId: handoff.handoffId,
            claimId: f.claim.id,
            disposition: "accepted",
            humanId: "other-expert",
          },
        })
      ).status,
    ).toBe(409);
    await service.close();
    const restarted = await start(f.workspace);
    expect((await get(restarted.url, `feedback/${f.sha}`)).effectiveHumanObservations).toEqual(
      currentGold,
    );
    expect(
      (await get(restarted.url, `source/${f.sha}`)).handoffTrust[handoff.handoffId].humanContext,
    ).toBe("changed");
  });
  it("negotiates compressed shared snapshots without changing the canonical source", async () => {
    const f = await fixture();
    const service = await start(f.workspace);
    const initial = await get(service.url, `source/${f.sha}`);
    const response = await fetch(`${service.url}/api/review/source/${f.sha}`, {
      headers: { "X-Review-Transport": "shared-v1", "Accept-Encoding": "gzip" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(decodeReviewResponse(await response.json())).toEqual(initial);
    expect((await get(service.url, `source/${f.sha}`)).version).toEqual(initial.version);
  });

  it("persists a modified human judgment without a rationale across restart", async () => {
    const f = await fixture();
    const service = await start(f.workspace);
    await post(service.url, "submit", { kind: "handoff", packet: f.handoff });
    const initial = await get(service.url, `source/${f.sha}`);
    const result = await post(service.url, `human/${f.sha}/decide`, {
      expectedBase: initial.version,
      input: {
        handoffId: f.handoff.handoffId,
        claimId: f.claim.id,
        disposition: "modified",
        humanId: "expert",
        modifiedClaim: {
          ...f.claim,
          assessment: { presence: "absent" },
          evidence: { ...f.claim.evidence, rationale: "" },
        },
      },
    });
    expect(result.status).toBe(200);
    expect(result.value.document.decisions[0]).toMatchObject({
      disposition: "modified",
      rationale: "",
    });
    expect(result.value.document.observations[0].claim.evidence.rationale).toBe("");
    expect(result.value.document.handoffs[0].handoff).toEqual(f.handoff);
    await service.close();
    const restarted = await start(f.workspace);
    expect((await get(restarted.url, `source/${f.sha}`)).document).toEqual(result.value.document);
  });

  it("publishes machine revision lineage and preserves it across a service restart", async () => {
    const f = await fixture();
    const service = await start(f.workspace);
    const original = await sealHandoffV2(f.task, {
      handoffId: "pending-original",
      createdAt: NOW,
      agent: f.handoff.agent,
      proposals: [{ ...f.claim, assessment: { presence: "unresolved" } }],
      audit: [],
      questions: [],
    });
    const oldAudit = await sealAuditV2(f.task, original, {
      auditId: "pending-original-audit",
      createdAt: NOW,
      agent: f.audit.agent,
      claims: [
        {
          claimId: f.claim.id,
          outcome: "needs-expert",
          rationale: "A calibrated comparison is needed.",
          expertReason: "semantic-boundary",
          question: "Does this qualify?",
        },
      ],
      questions: [],
    });
    await post(service.url, "submit", { kind: "handoff", packet: original });
    await post(service.url, "submit", { kind: "audit", packet: oldAudit });
    const replacement = await sealHandoffV2(f.task, {
      handoffId: "settled-replacement",
      createdAt: NOW,
      agent: f.handoff.agent,
      proposals: [{ ...f.claim, id: "settled-claim", assessment: { presence: "absent" } }],
      audit: [],
      questions: [],
      supersedes: [
        {
          handoffId: original.handoffId,
          handoffSha256: await hashWorkflowValueV2(original),
          claimId: f.claim.id,
          replacementClaimId: "settled-claim",
        },
      ],
    });
    expect(
      (await post(service.url, "submit", { kind: "handoff", packet: replacement })).status,
    ).toBe(200);
    const pending = await get(service.url, `feedback/${f.sha}`);
    expect(pending.counts["needs-expert"]).toBe(1);
    expect(pending.handoffs[1].supersedes).toEqual(replacement.supersedes);
    const audit = await sealAuditV2(f.task, replacement, {
      auditId: "settled-audit",
      createdAt: NOW,
      agent: f.audit.agent,
      claims: [
        {
          claimId: "settled-claim",
          outcome: "supported",
          rationale: "The source-backed comparison establishes absence.",
        },
      ],
      questions: [],
    });
    expect((await post(service.url, "submit", { kind: "audit", packet: audit })).status).toBe(200);
    const feedback = await get(service.url, `feedback/${f.sha}`);
    expect(feedback.counts).toEqual({ total: 2, superseded: 1, "agent-reviewed": 1 });
    expect((await get(service.url, "inbox")).sources[0].reviews).toContainEqual(
      expect.objectContaining({
        claimId: "settled-claim",
        status: "agent-reviewed",
        assessment: { presence: "absent" },
      }),
    );
    expect(feedback.agentReviews[0].supersededBy).toEqual({
      handoffId: replacement.handoffId,
      claimId: "settled-claim",
    });
    expect(feedback.reviewBase).toEqual(pending.reviewBase);
    const dispositions = await get(service.url, `dispositions/${f.sha}`);
    expect(dispositions.handoffs[1].supersedes).toEqual(replacement.supersedes);
    expect(dispositions.agentReviews.every((row: { decision?: unknown }) => !row.decision)).toBe(
      true,
    );
    await service.close();
    const restarted = await start(f.workspace);
    expect(await get(restarted.url, `feedback/${f.sha}`)).toEqual(feedback);
    expect(restarted.cacheInfo().fullSourceReads).toBe(0);
  }, 10_000);

  it("rebuilds summaries written before inbox provenance without changing canonical records", async () => {
    const f = await fixture();
    const service = await start(f.workspace);
    await post(service.url, "submit", { kind: "handoff", packet: f.handoff });
    await post(service.url, "submit", { kind: "audit", packet: f.audit });
    await get(service.url, "inbox");
    await service.close();
    const sourcePath = join(f.workspace, "workflow", `${f.sha}.v2.json`);
    const before = await readFile(sourcePath, "utf8");
    const info = await stat(sourcePath);
    const cachePath = join(f.workspace, "exchange/outbox", `${f.sha}.feedback-cache.json`);
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    cache.stamp = `${info.mtimeMs}:${info.size}`;
    for (const review of cache.row.reviews) {
      delete review.agent;
      delete review.submittedAt;
      delete review.audits;
    }
    await writeFile(cachePath, JSON.stringify(cache));
    const restarted = await start(f.workspace);
    const inbox = await get(restarted.url, "inbox");
    expect(inbox.sources[0].reviews[0]).toMatchObject({
      agent: f.handoff.agent,
      submittedAt: f.handoff.createdAt,
      audits: [{ agent: f.audit.agent, outcome: "supported" }],
    });
    expect(restarted.cacheInfo().fullSourceReads).toBe(1);
    expect(await readFile(sourcePath, "utf8")).toBe(before);
  });

  it("drains queued human decisions, closes old keep-alive streams, and restarts on the same port", async () => {
    const f = await fixture();
    const dataset = join(f.workspace, "dataset");
    await mkdir(join(dataset, "0/456"), { recursive: true });
    const audio = await open(join(dataset, "0/456/song.mp3"), "w");
    await audio.truncate(16 * 1024 * 1024);
    await audio.close();
    const service = await start(f.workspace, dataset);
    await post(service.url, "submit", { kind: "handoff", packet: f.handoff });
    await post(service.url, "submit", { kind: "audit", packet: f.audit });
    const audioTask = await post(service.url, "source", {
      sourceBytes: Array.from(
        new TextEncoder().encode(
          new TextDecoder()
            .decode(f.sourceBytes)
            .replace("Mode: 3", "Mode: 3\nAudioFilename: song.mp3"),
        ),
      ),
      foundationSourceSha256: f.sha,
      foundationSha256: f.task.foundationSha256,
    });
    const current = await get(service.url, `source/${f.sha}`);
    const paused = await new Promise<IncomingMessage>((resolveResponse, reject) => {
      httpGet(`${service.url}/api/review/audio/${audioTask.value.source.sha256}`, (response) => {
        response.pause();
        response.on("error", () => {});
        resolveResponse(response);
      }).on("error", reject);
    });
    const agent = new Agent({ keepAlive: true, maxSockets: 2 });
    cleanups.push(async () => agent.destroy());
    function admittedPost(path: string, body: unknown) {
      const text = JSON.stringify(body);
      let resolveResponse!: (value: { status: number | undefined; value: unknown }) => void;
      let rejectResponse!: (error: Error) => void;
      const completed = new Promise<{ status: number | undefined; value: unknown }>(
        (resolve, reject) => {
          resolveResponse = resolve;
          rejectResponse = reject;
        },
      );
      const request = httpRequest(
        `${service.url}/api/review/${path}`,
        {
          method: "POST",
          agent,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(text),
            Expect: "100-continue",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolveResponse({
              status: response.statusCode,
              value: JSON.parse(Buffer.concat(chunks).toString()),
            }),
          );
          response.on("error", rejectResponse);
        },
      );
      request.on("error", rejectResponse);
      const admitted = new Promise<void>((resolve) => request.once("continue", resolve));
      request.flushHeaders();
      return { request, text, admitted, completed };
    }
    // Keep the writer awaiting the first request body while the human command enters its queue.
    const gate = admittedPost("submit", { kind: "audit", packet: f.audit });
    await gate.admitted;
    const decision = admittedPost(`human/${f.sha}/decide`, {
      expectedBase: current.version,
      input: {
        handoffId: f.handoff.handoffId,
        claimId: f.claim.id,
        disposition: "accepted",
        humanId: "shutdown-expert",
        rationale: "This accepted decision must survive shutdown.",
      },
    });
    await decision.admitted;
    decision.request.end(decision.text);
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    gate.request.end(gate.text);
    try {
      expect((await gate.completed).status).toBe(200);
      expect((await decision.completed).status).toBe(200);
      await expect.poll(() => closed, { timeout: 1_000 }).toBe(true);
    } finally {
      paused.destroy();
      await closing;
    }
    const restarted = await start(f.workspace, dataset, Number(new URL(service.url).port));
    const response = await new Promise<IncomingMessage>((resolveResponse, reject) => {
      httpGet(`${restarted.url}/api/review/feedback/${f.sha}`, { agent }, resolveResponse).on(
        "error",
        reject,
      );
    });
    expect(response.statusCode).toBe(200);
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk);
    const feedback = JSON.parse(Buffer.concat(chunks).toString());
    expect(feedback.agentReviews[0].decision).toMatchObject({
      disposition: "accepted",
      humanId: "shutdown-expert",
      rationale: "This accepted decision must survive shutdown.",
    });
    expect((await get(restarted.url, `source/${f.sha}`)).document.decisions).toHaveLength(1);
  }, 10_000);

  it("streams registered beatmap audio with seeking and HEAD without blocking review or changing records", async () => {
    const f = await fixture();
    const dataset = join(f.workspace, "dataset");
    const service = await start(f.workspace, dataset);
    expect((await get(service.url, `source/${f.sha}`)).audio).toBeNull();
    expect((await fetch(`${service.url}/api/review/audio/${f.sha}`)).status).toBe(404);
    const registered = await post(service.url, "source", {
      sourceBytes: Array.from(
        new TextEncoder().encode(
          new TextDecoder()
            .decode(f.sourceBytes)
            .replace(
              "Mode: 3",
              "Mode: 3\nAudioFilename: unused.ogg\nAudioFilename: music\\song.mp3",
            ),
        ),
      ),
      foundationSourceSha256: f.sha,
      foundationSha256: f.task.foundationSha256,
    });
    expect(registered.status).toBe(200);
    const sha = registered.value.source.sha256;
    const audioPath = join(dataset, "0/456/music/song.mp3");
    await mkdir(join(dataset, "0/456/music"), { recursive: true });
    const prefix = Buffer.from("0123456789abcdef");
    await writeFile(audioPath, prefix);
    const audioFile = await open(audioPath, "r+");
    const size = 16 * 1024 * 1024;
    await audioFile.truncate(size);
    await audioFile.close();
    const canonicalPath = join(f.workspace, "workflow", `${sha}.v2.json`);
    const original = await readFile(canonicalPath, "utf8");
    const feedback = await get(service.url, `feedback/${sha}`);
    const source = await get(service.url, `source/${sha}`);
    expect(source.audio).toEqual({ url: `/api/review/audio/${sha}`, filename: "music\\song.mp3" });
    expect(source.document).not.toHaveProperty("audio");
    const url = `${service.url}${source.audio.url}`;
    const range = await fetch(url, { headers: { Range: "bytes=2-7" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-type")).toBe("audio/mpeg");
    expect(range.headers.get("accept-ranges")).toBe("bytes");
    expect(range.headers.get("content-range")).toBe(`bytes 2-7/${size}`);
    expect(range.headers.get("content-length")).toBe("6");
    expect(Buffer.from(await range.arrayBuffer())).toEqual(prefix.subarray(2, 8));
    const suffix = await fetch(url, { headers: { Range: "bytes=-3" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(`bytes ${size - 3}-${size - 1}/${size}`);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(Buffer.alloc(3));
    const head = await fetch(url, { method: "HEAD", headers: { Range: "bytes=2-7" } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(size));
    expect(await head.text()).toBe("");
    const unsatisfiable = await fetch(url, { headers: { Range: `bytes=${size}-` } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${size}`);
    await unsatisfiable.arrayBuffer();
    const paused = await new Promise<IncomingMessage>((resolveResponse, reject) => {
      httpGet(url, (response) => {
        response.pause();
        resolveResponse(response);
      }).on("error", reject);
    });
    try {
      expect(paused.statusCode).toBe(200);
      const concurrent = await fetch(`${service.url}/api/review/feedback/${sha}`, {
        signal: AbortSignal.timeout(2_000),
      });
      expect(await concurrent.json()).toEqual(feedback);
    } finally {
      paused.destroy();
    }
    expect(await get(service.url, `task/${sha}`)).toEqual(registered.value);
    expect(await readFile(canonicalPath, "utf8")).toBe(original);
    await rm(audioPath);
    expect((await get(service.url, `source/${sha}`)).audio).toBeNull();
    expect((await fetch(url)).status).toBe(404);
  }, 10_000);

  it("keeps audio paths inside the registered set, including symlink targets", async () => {
    const f = await fixture();
    const dataset = join(f.workspace, "dataset");
    await mkdir(join(dataset, "0/456"), { recursive: true });
    const outside = join(f.workspace, "outside.mp3");
    await writeFile(outside, "Outside the registered set");
    await writeFile(join(dataset, "0/outside.mp3"), "Sibling of the registered set");
    await symlink(outside, join(dataset, "0/456/escape.mp3"));
    await symlink(f.workspace, join(dataset, "0/457"));
    await mkdir(join(dataset, "0/458"));
    await writeFile(join(dataset, "0/458/outside.mp3"), "Another beatmapset's audio");
    await symlink(join(dataset, "0/458"), join(dataset, "0/459"));
    const service = await start(f.workspace, dataset);
    for (const [filename, setId] of [
      ["../outside.mp3", 456],
      ["..\\outside.mp3", 456],
      [outside, 456],
      ["escape.mp3", 456],
      ["outside.mp3", 457],
      ["outside.mp3", 459],
    ] as const) {
      const registered = await post(service.url, "source", {
        sourceBytes: Array.from(
          new TextEncoder().encode(
            new TextDecoder()
              .decode(f.sourceBytes)
              .replace("Mode: 3", `Mode: 3\nAudioFilename: ${filename}`)
              .replace("BeatmapSetID: 456", `BeatmapSetID: ${setId}`),
          ),
        ),
        foundationSourceSha256: f.sha,
        foundationSha256: f.task.foundationSha256,
      });
      expect(registered.status).toBe(200);
      const sha = registered.value.source.sha256;
      expect((await get(service.url, `source/${sha}`)).audio).toBeNull();
      expect((await fetch(`${service.url}/api/review/audio/${sha}`)).status).toBe(404);
    }
  }, 10_000);

  it("adds difficulty-specific community votes only to the human source response", async () => {
    const f = await fixture();
    const dataset = join(f.workspace, "dataset");
    const service = await start(f.workspace, dataset);
    expect((await get(service.url, `source/${f.sha}`)).communityTags).toBeNull();
    const second = await post(service.url, "source", {
      sourceBytes: Array.from(
        new TextEncoder().encode(
          new TextDecoder().decode(f.sourceBytes).replace("BeatmapID: 123", "BeatmapID: 124"),
        ),
      ),
      foundationSourceSha256: f.sha,
      foundationSha256: f.task.foundationSha256,
    });
    expect(second.status).toBe(200);
    const originalFile = await readFile(join(f.workspace, "workflow", `${f.sha}.v2.json`), "utf8");
    const task = await get(service.url, `task/${f.sha}`);
    const feedback = await get(service.url, `feedback/${f.sha}`);
    const inbox = await get(service.url, "inbox");
    const fetchedAt = "2026-08-05T08:27:08.166480+00:00";
    await mkdir(join(dataset, "0/456"), { recursive: true });
    await mkdir(join(dataset, "metadata"));
    await writeFile(
      join(dataset, "0/456/metadata.json"),
      JSON.stringify({
        schema_version: 1,
        id: 456,
        fetched_at: fetchedAt,
        tags: {
          mapper_raw: "Keywords do not count as community votes",
          related: [
            { id: 58, name: "sliders/high sv" },
            { id: 118, name: "style/generic hybrid" },
          ],
        },
        beatmaps: [
          {
            id: 123,
            top_tag_ids: [
              { tag_id: 58, count: 4 },
              { tag_id: 118, count: 2 },
              { tag_id: 111, count: 4 },
            ],
          },
          {
            id: 124,
            top_tag_ids: [
              { tag_id: 111, count: 1 },
              { tag_id: 118, count: 12 },
            ],
          },
        ],
      }),
    );
    const vocabularyPath = join(dataset, "metadata/osu_tags_2026-08-07.json");
    await writeFile(
      vocabularyPath,
      JSON.stringify({ schema_version: 1, tags: [{ id: 111, name: "skillset/tech" }] }),
    );
    const first = await get(service.url, `source/${f.sha}`);
    expect(first.communityTags).toEqual({
      tags: [
        { id: 111, name: "skillset/tech", count: 4 },
        { id: 58, name: "sliders/high sv", count: 4 },
        { id: 118, name: "style/generic hybrid", count: 2 },
      ],
      totalVotes: 10,
      fetchedAt,
    });
    await rm(vocabularyPath);
    expect((await get(service.url, `source/${second.value.source.sha256}`)).communityTags).toEqual({
      tags: [
        { id: 118, name: "style/generic hybrid", count: 12 },
        { id: 111, name: "skillset/tech", count: 1 },
      ],
      totalVotes: 13,
      fetchedAt,
    });
    expect(first.document).toEqual(f.registered);
    expect(first.document).not.toHaveProperty("communityTags");
    expect(await get(service.url, `task/${f.sha}`)).toEqual(task);
    expect(await get(service.url, `task/${second.value.source.sha256}`)).toEqual(second.value);
    expect(await get(service.url, `feedback/${f.sha}`)).toEqual(feedback);
    expect(await get(service.url, "inbox")).toEqual(inbox);
    expect(await readFile(join(f.workspace, "workflow", `${f.sha}.v2.json`), "utf8")).toBe(
      originalFile,
    );
  }, 10_000);

  it("counts explicit human assessments separately from historical uncertain acceptances", async () => {
    const f = await fixture();
    const claim = { ...f.claim, assessment: { presence: "unresolved" as const } };
    const handoff = await sealHandoffV2(f.task, {
      handoffId: "uncertain-handoff",
      createdAt: NOW,
      agent: f.handoff.agent,
      proposals: [claim],
      audit: [],
      questions: [],
    });
    const imported = await importHandoffV2(f.registered, handoff, f.sourceBytes);
    const historical = historicalAcceptance(imported.document, handoff.handoffId, claim.id);
    await writeFile(
      join(f.workspace, "workflow", `${f.sha}.v2.json`),
      serializeCanonicalJson(historical),
    );
    const service = await start(f.workspace);
    const inbox = await get(service.url, "inbox");
    expect(inbox.sources[0].humanAssessmentCounts).toEqual({
      settled: 0,
      unresolved: 1,
      unreviewed: 0,
    });
    expect(inbox.sources[0].reviews[0]).toMatchObject({
      status: "accepted",
      assessment: { presence: "unresolved" },
    });
    const feedback = await get(service.url, `feedback/${f.sha}`);
    const clarified = await post(service.url, `human/${f.sha}/addObservations`, {
      expectedBase: feedback.documentVersion,
      input: {
        claims: [{ ...claim, assessment: { presence: "present", salience: "supporting" } }],
        humanId: "fixture-human",
      },
    });
    expect(clarified.status).toBe(200);
    expect(clarified.value.document.decisions).toEqual(historical.decisions);
    expect(clarified.value.document.observations[0]).toEqual(historical.observations[0]);
    expect((await get(service.url, "inbox")).sources[0].humanAssessmentCounts).toEqual({
      settled: 1,
      unresolved: 1,
      unreviewed: 0,
    });
    expect((await get(service.url, `feedback/${f.sha}`)).directObservations[0]).toMatchObject({
      confirmedAt: clarified.value.document.observations[1].confirmedAt,
      summary: {
        id: claim.id,
        tagId: claim.tagId,
        scope: claim.scope,
        assessment: { presence: "present", salience: "supporting" },
      },
    });
  });

  it("returns compact agent feedback with exact human modifications and immutable provenance", async () => {
    const f = await fixture();
    const service = await start(f.workspace);
    const handoff = await sealHandoffV2(f.task, {
      handoffId: "feedback-handoff",
      createdAt: NOW,
      agent: {
        ...f.handoff.agent,
        skill: { name: "fixture-judgment", version: "1", sha256: "a".repeat(64) },
      },
      proposals: f.handoff.proposals,
      audit: f.handoff.audit,
      questions: [{ id: "scope-question", claimIds: [f.claim.id], text: "Check the entry hold." }],
    });
    const audit = await sealAuditV2(f.task, handoff, {
      auditId: "feedback-audit",
      createdAt: NOW,
      agent: {
        ...f.audit.agent,
        skill: { name: "fixture-judgment", version: "2", sha256: "b".repeat(64) },
      },
      claims: f.audit.claims,
      questions: [
        {
          questionId: "scope-question",
          disposition: "resolved",
          rationale: "The exact entering hold is present.",
        },
      ],
    });
    expect((await post(service.url, "submit", { kind: "handoff", packet: handoff })).status).toBe(
      200,
    );
    expect((await post(service.url, "submit", { kind: "audit", packet: audit })).status).toBe(200);
    const initial = await get(service.url, `feedback/${f.sha}`);
    expect(initial.taskBinding).toEqual({
      taskId: f.task.taskId,
      taskSha256: f.task.taskSha256,
      foundationSha256: f.task.foundationSha256,
      base: f.task.base,
    });
    expect(initial.reviewBase).toEqual(f.task.base);
    expect(initial.counts).toEqual({ total: 2, "agent-reviewed": 2 });
    const initialInbox = await get(service.url, "inbox");
    expect(initialInbox.sources[0].reviews).toEqual(
      handoff.proposals.map((claim) =>
        expect.objectContaining({
          claimId: claim.id,
          status: "agent-reviewed",
          tagId: claim.tagId,
          scope: claim.scope,
          assessment: claim.assessment,
          agent: handoff.agent,
          submittedAt: handoff.createdAt,
          audits: [
            {
              auditId: audit.auditId,
              agent: audit.agent,
              createdAt: audit.createdAt,
              outcome: audit.claims.find((result) => result.claimId === claim.id)?.outcome,
            },
          ],
        }),
      ),
    );
    expect(initialInbox.sources[0].humanAssessmentCounts).toEqual({
      settled: 0,
      unresolved: 0,
      unreviewed: 0,
    });
    expect(initial.handoffs[0]).toMatchObject({
      handoffId: handoff.handoffId,
      handoffSha256: await hashWorkflowValueV2(handoff),
      agent: handoff.agent,
      questions: handoff.questions,
    });
    expect(initial.audits[0]).toMatchObject({
      auditId: audit.auditId,
      auditSha256: await hashWorkflowValueV2(audit),
      agent: audit.agent,
      questions: audit.questions,
    });
    expect(initial.agentReviews[0].summary).toMatchObject({
      scope: f.claim.scope,
      reviewContext: f.claim.reviewContext,
      assessment: f.claim.assessment,
      rationale: f.claim.evidence.rationale,
      witnessCount: f.claim.evidence.noteRefs.length,
      boundaryUncertainty: f.claim.boundaryUncertainty,
      transition: { description: f.claim.transition?.description, witnessCount: 2 },
    });
    expect(initial.agentReviews[0].audits).toEqual([
      { auditId: audit.auditId, result: audit.claims[0] },
    ]);
    expect(JSON.stringify(initial)).not.toMatch(
      /"(?:sourceBytes|structure|noteRefs|contextNoteRefs)":|"foundation":\{/,
    );
    const modifiedClaim = {
      ...f.claim,
      assessment: { presence: "present", salience: "supporting" },
      evidence: {
        ...f.claim.evidence,
        noteRefs: [f.refs[0], f.refs[4]],
        rationale: "Human correction retains the entering hold and later discontiguous witness.",
      },
    };
    const modified = await post(service.url, `human/${f.sha}/decide`, {
      expectedBase: initial.documentVersion,
      input: {
        handoffId: handoff.handoffId,
        claimId: f.claim.id,
        disposition: "modified",
        humanId: "local-expert",
        rationale: "Use supporting salience for these specific witnesses.",
        modifiedClaim,
      },
    });
    expect(modified.status).toBe(200);
    const feedback = await get(service.url, `feedback/${f.sha}`);
    expect(feedback.documentVersion).toEqual(modified.value.version);
    expect(feedback.reviewBase.revision).toBe(initial.reviewBase.revision + 1);
    expect(feedback.taskBinding).toEqual(initial.taskBinding);
    expect(feedback.agentReviews[0].summary).toEqual(initial.agentReviews[0].summary);
    expect(feedback.agentReviews[0].decision).toEqual(modified.value.document.decisions[0]);
    expect(feedback.agentReviews[0].modifiedClaim).toEqual(modifiedClaim);
    expect(feedback.agentReviews[1]).not.toHaveProperty("modifiedClaim");
    expect(feedback.counts).toEqual({ total: 2, modified: 1, "agent-reviewed": 1 });
    const inbox = await get(service.url, "inbox");
    expect(inbox.sources[0].reviews[0]).toMatchObject({
      status: "modified",
      assessment: modifiedClaim.assessment,
    });
    expect(inbox.sources[0].reviews[1]).toEqual(initialInbox.sources[0].reviews[1]);
    expect(inbox.sources[0].humanAssessmentCounts).toEqual({
      settled: 1,
      unresolved: 0,
      unreviewed: 0,
    });
    expect(JSON.stringify(inbox)).not.toMatch(
      /"(?:sourceBytes|structure|noteRefs|contextNoteRefs)":|"foundation":\{/,
    );
    const withoutModified = structuredClone(feedback);
    delete withoutModified.agentReviews[0].modifiedClaim;
    expect(JSON.stringify(withoutModified)).not.toMatch(
      /"(?:sourceBytes|structure|noteRefs|contextNoteRefs)":|"foundation":\{/,
    );
    expect((await get(service.url, `dispositions/${f.sha}`)).agentReviews[0].claim).toEqual(
      f.claim,
    );
    expect((await get(service.url, `source/${f.sha}`)).version).toEqual(modified.value.version);
    await service.close();
    const restarted = await start(f.workspace);
    expect(restarted.cacheInfo().fullSourceReads).toBe(0);
    expect(await get(restarted.url, `feedback/${f.sha}`)).toEqual(feedback);
    expect(await get(restarted.url, "inbox")).toEqual(inbox);
    expect(restarted.cacheInfo().fullSourceReads).toBe(0);
  }, 10_000);

  it("bounds full-source retention while unchanged inbox polls use compact summaries", async () => {
    const f = await fixture();
    const service = await start(f.workspace);
    await post(service.url, "submit", { kind: "handoff", packet: f.handoff });
    await post(service.url, "submit", { kind: "audit", packet: f.audit });
    await post(service.url, "submit", { kind: "review-request", packet: f.request });
    const original = await get(service.url, `source/${f.sha}`);
    for (let index = 0; index < 5; index++) {
      const sourceBytes = Array.from(
        new TextEncoder().encode(
          new TextDecoder()
            .decode(f.sourceBytes)
            .replace("Version: Mixed", `Version: Batch ${index}`),
        ),
      );
      const registered = await post(service.url, "source", {
        sourceBytes,
        foundationSourceSha256: f.sha,
        foundationSha256: f.task.foundationSha256,
      });
      expect(registered.status).toBe(200);
    }
    const warmed = service.cacheInfo();
    expect(warmed).toMatchObject({ fullSources: 1, summaries: 6 });
    for (let poll = 0; poll < 3; poll++) {
      const inbox = await get(service.url, "inbox");
      expect(inbox.sources).toHaveLength(6);
      const initial = inbox.sources.find(
        (row: { source: { sha256: string } }) => row.source.sha256 === f.sha,
      );
      expect(initial.counts).toEqual({ total: 2, "agent-reviewed": 2 });
      expect(initial.requests[0].pendingClaimIds).toEqual(f.request.claimIds);
      const feedback = await get(service.url, `feedback/${f.sha}`);
      expect(feedback.counts).toEqual(initial.counts);
    }
    expect(service.cacheInfo()).toEqual(warmed);
    expect(await get(service.url, `source/${f.sha}`)).toEqual(original);
    expect(service.cacheInfo()).toEqual({ ...warmed, fullSourceReads: warmed.fullSourceReads + 1 });
    const decided = await post(service.url, `human/${f.sha}/decide`, {
      expectedBase: original.version,
      input: {
        handoffId: f.handoff.handoffId,
        claimId: f.claim.id,
        disposition: "accepted",
        humanId: "local-expert",
        rationale: "Check the summary after reopening an evicted source.",
      },
    });
    expect(decided.status).toBe(200);
    const updated = await get(service.url, "inbox");
    const initial = updated.sources.find(
      (row: { source: { sha256: string } }) => row.source.sha256 === f.sha,
    );
    expect(initial.version).toEqual(decided.value.version);
    expect(initial.counts).toEqual({ total: 2, accepted: 1, "agent-reviewed": 1 });
    expect(initial.requests[0].pendingClaimIds).toEqual(["streams-claim"]);
    const refreshed = service.cacheInfo();
    await get(service.url, "inbox");
    expect(service.cacheInfo()).toEqual(refreshed);
    expect(refreshed.fullSources).toBe(1);
  }, 10_000);

  it("registers a local source through the real CLI using the original canonical Foundation approval", async () => {
    const f = await fixture();
    const service = await start(f.workspace);
    const sourcePath = join(f.workspace, "another.osu");
    const outputPath = join(f.workspace, "registered-task.json");
    const newBytes = new TextEncoder().encode(
      new TextDecoder().decode(f.sourceBytes).replace("Version: Mixed", "Version: Another"),
    );
    await writeFile(sourcePath, newBytes);
    const script = resolve("apps/inspector/server/annotation-workflow.mjs");
    const args = [
      script,
      "register-source",
      "--server",
      service.url,
      "--source",
      sourcePath,
      "--foundation-source-sha",
      f.sha,
      "--foundation-sha",
      f.task.foundationSha256,
      "--out",
      outputPath,
    ];
    await exec(process.execPath, args);
    const task = JSON.parse(await readFile(outputPath, "utf8"));
    expect(task.contract).toBe("beatmap-lens-agent-task");
    expect(task.sourceBytes).toEqual(Array.from(newBytes));
    expect(task.foundation).toEqual(f.task.foundation);
    expect(task.foundationSha256).toBe(f.task.foundationSha256);
    const stored = await get(service.url, `source/${task.source.sha256}`);
    expect(stored.document.tasks).toEqual([task]);
    expect(stored.document.decisions).toEqual([]);
    expect(stored.document.observations).toEqual([]);
    expect(stored.document.reviewRevision).toBe(1);
    expect((await get(service.url, "inbox")).sources).toHaveLength(2);
    await exec(process.execPath, args);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(task);
    expect(await get(service.url, `source/${task.source.sha256}`)).toEqual(stored);
    const rejected = await post(service.url, "source", {
      sourceBytes: Array.from(newBytes),
      foundationSourceSha256: f.sha,
      foundationSha256: "0".repeat(64),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.value.error).toContain("Foundation hash differs");
    expect(await get(service.url, `source/${task.source.sha256}`)).toEqual(stored);
    const evidence = join(f.workspace, "registered-evidence");
    await exec(process.execPath, [script, "evidence", "--task", outputPath, "--out", evidence]);
    expect(await readFile(join(evidence, "source.osu"))).toEqual(Buffer.from(newBytes));
  }, 10_000);

  it("accepts independent concurrent deliveries, persists partial human decisions, and survives restart", async () => {
    const f = await fixture();
    const service = await start(f.workspace);
    const original = await get(service.url, `source/${f.sha}`);
    const responses = await Promise.all([
      post(service.url, "submit", { kind: "audit", packet: f.audit }),
      post(service.url, "submit", { kind: "handoff", packet: f.handoff }),
      post(service.url, "submit", { kind: "review-request", packet: f.request }),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await service.processInbox();
    const inbox = await get(service.url, "inbox");
    expect(inbox.sources[0].counts).toEqual({ total: 2, "agent-reviewed": 2 });
    expect(inbox.sources[0].expertQueue).toEqual([]);
    expect(inbox.sources[0].requests[0].pendingClaimIds).toEqual(f.request.claimIds);
    const current = await get(service.url, `source/${f.sha}`);
    expect(current.sourceBytes).toEqual(Array.from(f.sourceBytes));
    expect(current.document.decisions).toEqual([]);
    expect(current.document.observations).toEqual([]);
    const input = {
      handoffId: f.handoff.handoffId,
      claimId: f.claim.id,
      disposition: "accepted",
      humanId: "local-expert",
      rationale: "This specific fixture claim was checked by the human.",
    };
    const conflict = await post(service.url, `human/${f.sha}/decide`, {
      expectedBase: original.version,
      input,
    });
    expect(conflict).toMatchObject({ status: 409, value: { actual: current.version } });
    const [decided, retry] = await Promise.all([
      post(service.url, `human/${f.sha}/decide`, { expectedBase: current.version, input }),
      post(service.url, "submit", { kind: "audit", packet: f.audit }),
    ]);
    expect(decided.status).toBe(200);
    expect(retry.status).toBe(200);
    const readback = await get(service.url, `dispositions/${f.sha}`);
    expect(readback.agentReviews.map((row: { status: string }) => row.status)).toEqual([
      "accepted",
      "agent-reviewed",
    ]);
    expect(readback.handoffs[0].claims[0].observations).toHaveLength(1);
    expect(readback.reviewRequests[0].pendingClaimIds).toEqual(["streams-claim"]);
    const deferred = await post(service.url, `human/${f.sha}/decide`, {
      expectedBase: decided.value.version,
      input: {
        ...input,
        claimId: "streams-claim",
        disposition: "deferred",
        rationale: "Leave unsettled.",
      },
    });
    expect(deferred.status).toBe(200);
    const beforeRestart = await get(service.url, `source/${f.sha}`);
    const dispositions = await get(service.url, `dispositions/${f.sha}`);
    expect(dispositions.reviewRequests[0].pendingClaimIds).toEqual([]);
    expect(dispositions.agentReviews.map((row: { status: string }) => row.status)).toEqual([
      "accepted",
      "deferred",
    ]);
    expect(
      JSON.parse(
        await readFile(join(f.workspace, "exchange/outbox", `${f.sha}.dispositions.json`), "utf8"),
      ),
    ).toEqual(dispositions);
    expect((await get(service.url, `task/${f.sha}`)).taskSha256).toBe(f.task.taskSha256);
    await service.close();
    const restarted = await start(f.workspace);
    const repeat = await post(restarted.url, "submit", { kind: "handoff", packet: f.handoff });
    expect(repeat.status).toBe(200);
    expect(await get(restarted.url, `source/${f.sha}`)).toEqual(beforeRestart);
    expect((await get(restarted.url, "inbox")).sources[0].requests[0].pendingClaimIds).toEqual([]);
    expect(await readdir(join(f.workspace, "exchange/receipts"))).toHaveLength(3);
    const fresh = await post(restarted.url, `task/${f.sha}`, {});
    expect(fresh.status).toBe(200);
    expect(fresh.value.taskSha256).not.toBe(f.task.taskSha256);
    expect(fresh.value.base.revision).toBe(beforeRestart.document.reviewRevision);
    expect((await get(restarted.url, `task/${f.sha}`)).taskSha256).toBe(fresh.value.taskSha256);
    const refreshed = await get(restarted.url, `source/${f.sha}`);
    expect(refreshed.document.decisions).toEqual(beforeRestart.document.decisions);
    expect(refreshed.document.observations).toEqual(beforeRestart.document.observations);
  }, 20_000);

  it("polls raw inbox packets and persists visible immutable-target and machine-authority errors", async () => {
    const f = await fixture();
    const service = await start(f.workspace);
    const inboxPath = join(f.workspace, "exchange/inbox");
    const wrongHost = await new Promise<number | undefined>((resolveStatus, reject) => {
      httpGet(
        `${service.url}/api/review/inbox`,
        { headers: { Host: "untrusted.example" } },
        (response) => {
          response.resume();
          resolveStatus(response.statusCode);
        },
      ).on("error", reject);
    });
    expect(wrongHost).toBe(403);
    const wrongOrigin = await fetch(`${service.url}/api/review/inbox`, {
      headers: { Origin: "https://untrusted.example" },
    });
    expect(wrongOrigin.status).toBe(403);
    await writeFile(join(inboxPath, "01-audit.json"), JSON.stringify(f.audit));
    await writeFile(join(inboxPath, "02-handoff.json"), JSON.stringify(f.handoff));
    await expect
      .poll(async () => (await get(service.url, "inbox")).sources[0].counts["agent-reviewed"], {
        timeout: 5000,
      })
      .toBe(2);
    const before = await get(service.url, `source/${f.sha}`);
    const invalid = await post(service.url, "submit", {
      kind: "handoff",
      packet: {
        ...f.handoff,
        handoffId: "agent-cannot-confirm",
        decisions: [{ disposition: "accepted" }],
      },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.value.status).toBe("error");
    expect(invalid.value.error).toContain("not an allowed field");
    const wrongTarget = await post(service.url, "submit", {
      kind: "review-request",
      packet: { ...f.request, handoffSha256: "0".repeat(64) },
    });
    expect(wrongTarget.status).toBe(400);
    expect(wrongTarget.value.error).toContain("different immutable handoff content");
    expect(await get(service.url, `source/${f.sha}`)).toEqual(before);
    const valid = await post(service.url, "submit", { kind: "review-request", packet: f.request });
    expect(valid.status).toBe(200);
    const changed = await post(service.url, "submit", {
      kind: "review-request",
      packet: { ...f.request, question: "Silently replaced question" },
    });
    expect(changed.status).toBe(400);
    const inbox = await get(service.url, "inbox");
    expect(
      inbox.receipts.filter((receipt: { status: string }) => receipt.status === "error"),
    ).toHaveLength(3);
    expect(inbox.sources[0].requests[0].question).toBe(f.request.question);
    await writeFile(join(inboxPath, "broken.json"), "{unfinished");
    await service.processInbox();
    expect(
      (await get(service.url, "inbox")).receipts.some(
        (receipt: { filename?: string; status: string }) =>
          receipt.filename === "broken.json" && receipt.status === "error",
      ),
    ).toBe(true);
  }, 15_000);

  it("issues fresh agent tasks only after explicit Foundation approval", async () => {
    const f = await fixture();
    const proposed = await createReviewDocumentV2(f.inspected.source, f.foundation);
    const task = await createTaskPacketV2(proposed, f.sourceBytes);
    const registered = await registerTaskV2(proposed, task, f.sourceBytes);
    await writeFile(
      join(f.workspace, "workflow", `${f.sha}.v2.json`),
      serializeCanonicalJson(registered),
    );
    const service = await start(f.workspace);
    const denied = await post(service.url, `task/${f.sha}`, {});
    expect(denied.status).toBe(400);
    expect(denied.value.error).toContain("human approval");
    const current = await get(service.url, `source/${f.sha}`);
    expect(current.document.tasks).toHaveLength(1);
    const approved = await post(service.url, `human/${f.sha}/approveFoundation`, {
      expectedBase: current.version,
      input: { humanId: "local-expert" },
    });
    expect(approved.status).toBe(200);
    const issued = await post(service.url, `task/${f.sha}`, {});
    expect(issued.status).toBe(200);
    expect(issued.value.foundation.approval.status).toBe("human-approved");
    const latest = await get(service.url, `source/${f.sha}`);
    expect(latest.document.reviewRevision).toBe(approved.value.document.reviewRevision);
    expect(latest.document.decisions).toEqual([]);
    expect(latest.document.observations).toEqual([]);
  }, 10_000);
});

import { execFile } from "node:child_process";
