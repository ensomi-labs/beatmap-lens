import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { serializeCanonicalJson } from "../canonical-json";
import {
  createTaskPacketV2,
  decideClaimV2,
  importAuditV2,
  importHandoffV2,
  readAgentReviewsV2,
  readDispositionsV2,
  readExpertQueueV2,
  sealAuditV2,
} from "./domain";
import { workflowFixture } from "./test-fixtures";

const exec = promisify(execFile);
const script = fileURLToPath(
  new URL("../../../../../apps/inspector/server/annotation-workflow.mjs", import.meta.url),
);
const adapterUrl = pathToFileURL(join(script, "../workflow-local-directory.mjs")).href;
const { compactReviewWorkspace, readCanonicalWorkflowFile } = await import(
  /* @vite-ignore */ adapterUrl
);
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("external annotation exchange CLI", () => {
  it("reads the fixed inbox and saves the server's exact frozen task without rebinding", async () => {
    const f = await workflowFixture();
    const dir = await temporary();
    const inbox = { workspace: dir, sources: [{ source: f.task.source }], receipts: [] };
    const freshTask = await createTaskPacketV2(f.registered, f.sourceBytes, {
      taskId: "fresh-task",
    });
    const requests: unknown[] = [];
    const url = await serve(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ method: request.method, path: request.url, body });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/api/review/inbox"
            ? inbox
            : request.method === "POST"
              ? freshTask
              : f.task,
        ),
      );
    });
    const listed = await exec(process.execPath, [script, "inbox", "--server", url]);
    expect(JSON.parse(listed.stdout)).toEqual(inbox);
    const path = join(dir, "fetched/task.json");
    await exec(process.execPath, [
      script,
      "fetch-task",
      "--server",
      url,
      "--source-sha",
      f.task.source.sha256,
      "--out",
      path,
    ]);
    expect(await json(path)).toEqual(f.task);
    const freshPath = join(dir, "fetched/fresh-task.json");
    await exec(process.execPath, [
      script,
      "fetch-task",
      "--server",
      url,
      "--source-sha",
      f.task.source.sha256,
      "--fresh",
      "--out",
      freshPath,
    ]);
    expect(await json(freshPath)).toEqual(freshTask);
    expect(await json(path)).toEqual(f.task);
    expect(requests).toEqual([
      { method: "GET", path: "/api/review/inbox", body: "" },
      { method: "GET", path: `/api/review/task/${f.task.source.sha256}`, body: "" },
      { method: "POST", path: `/api/review/task/${f.task.source.sha256}`, body: "{}" },
    ]);
  });

  it("submits original sealed packets and honest spot-check requests while preserving pending receipts", async () => {
    const f = await workflowFixture();
    const dir = await temporary();
    const audit = await sealAuditV2(f.task, f.handoff, {
      auditId: "network-audit",
      createdAt: f.handoff.createdAt,
      agent: { producerId: "network-auditor", role: "auditor" },
      claims: f.handoff.proposals.map((claim) => ({
        claimId: claim.id,
        outcome: "needs-revision",
        rationale: "Complete the evidence before settling this fixture claim.",
      })),
      questions: f.handoff.questions.map((question) => ({
        questionId: question.id,
        disposition: "needs-revision",
        rationale: "The agent can resolve this through source inspection.",
      })),
    });
    const reviewRequest = {
      requestId: "network-spot-check",
      sourceSha256: f.task.source.sha256,
      handoffId: f.handoff.handoffId,
      handoffSha256: audit.handoffSha256,
      claimIds: [f.claim.id],
      reason: "spot-check",
      question: "Please sample this source-backed judgment.",
      requestedBy: { producerId: "external-labeler", role: "labeler" },
      createdAt: f.handoff.createdAt,
    };
    const submissions: unknown[] = [];
    const url = await serve(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      submissions.push({ method: request.method, path: request.url, body: JSON.parse(body) });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: `receipt-${submissions.length}`, status: "pending" }));
    });
    const packets = [
      { kind: "handoff", packet: f.handoff },
      { kind: "audit", packet: audit },
      { kind: "review-request", packet: reviewRequest },
    ];
    for (const { kind, packet } of packets) {
      const input = join(dir, `${kind}.json`);
      const original = serializeCanonicalJson(packet);
      await writeFile(input, original);
      const result = await exec(process.execPath, [
        script,
        "submit",
        "--server",
        url,
        "--input",
        input,
      ]);
      expect(JSON.parse(result.stdout).status).toBe("pending");
      expect(await readFile(input, "utf8")).toBe(original);
    }
    expect(submissions).toEqual(
      packets.map((body) => ({ method: "POST", path: "/api/review/submit", body })),
    );
  });

  it("reads server dispositions with human decisions and reports HTTP conflicts without a stack trace", async () => {
    const f = await workflowFixture();
    const dir = await temporary();
    const imported = await importHandoffV2(f.registered, f.handoff, f.sourceBytes);
    const document = await decideClaimV2(
      imported.document,
      {
        handoffId: f.handoff.handoffId,
        claimId: f.claim.id,
        humanId: "network-fixture-human",
        disposition: "deferred",
        rationale: "Preserve the unresolved human response.",
      },
      f.sourceBytes,
    );
    const dispositions = {
      ...(await readDispositionsV2(document)),
      documentVersion: "saved-version",
    };
    const url = await serve((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === `/api/review/dispositions/${f.task.source.sha256}`)
        response.end(JSON.stringify(dispositions));
      else {
        response.statusCode = 409;
        response.end(
          JSON.stringify({ error: "Immutable packet identity already has different content." }),
        );
      }
    });
    const path = join(dir, "dispositions.json");
    await exec(process.execPath, [
      script,
      "dispositions",
      "--server",
      url,
      "--source-sha",
      f.task.source.sha256,
      "--out",
      path,
    ]);
    expect(await json(path)).toEqual(dispositions);
    await writeFile(join(dir, "handoff.json"), serializeCanonicalJson(f.handoff));
    await expect(
      exec(process.execPath, [
        script,
        "submit",
        "--server",
        url,
        "--input",
        join(dir, "handoff.json"),
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: "HTTP 409: Immutable packet identity already has different content.\n",
    });
  });

  it("seals an independent audit and exposes only expert cases without writing human observations", async () => {
    const f = await workflowFixture();
    const dir = await temporary();
    await writeFile(join(dir, "task.json"), serializeCanonicalJson(f.task));
    await writeFile(join(dir, "handoff.json"), serializeCanonicalJson(f.handoff));
    await writeFile(
      join(dir, "audit-input.json"),
      serializeCanonicalJson({
        auditId: "cli-independent-audit",
        createdAt: f.handoff.createdAt,
        agent: { producerId: "cli-auditor", role: "auditor" },
        claims: f.handoff.proposals.map((claim) =>
          claim.assessment.presence === "unresolved"
            ? {
                claimId: claim.id,
                outcome: "needs-expert",
                rationale: "Unresolved calibration distinction.",
                expertReason: "semantic-boundary",
                question: "How should the synthetic disputed case be interpreted?",
              }
            : {
                claimId: claim.id,
                outcome: "supported",
                rationale: "Independent source review supports this claim.",
              },
        ),
        questions: f.handoff.questions.map((question) => ({
          questionId: question.id,
          disposition: "needs-expert",
          rationale: "This specific question remains open.",
        })),
      }),
    );
    await exec(process.execPath, [
      script,
      "audit",
      "--task",
      join(dir, "task.json"),
      "--handoff",
      join(dir, "handoff.json"),
      "--input",
      join(dir, "audit-input.json"),
      "--out",
      join(dir, "audit.json"),
    ]);
    const imported = await importHandoffV2(f.registered, f.handoff, f.sourceBytes);
    const reviewed = await importAuditV2(
      imported.document,
      await json(join(dir, "audit.json")),
      f.sourceBytes,
    );
    const file = join(dir, "workflow.json");
    const content = serializeCanonicalJson(reviewed.document);
    await writeFile(file, content);
    const status = JSON.parse(
      (await exec(process.execPath, [script, "review-status", "--file", file])).stdout,
    );
    const queue = JSON.parse(
      (await exec(process.execPath, [script, "expert-queue", "--file", file])).stdout,
    );
    expect(status.reviews.map((review: { status: string }) => review.status)).toEqual([
      "agent-reviewed",
      "agent-reviewed",
      "needs-expert",
    ]);
    expect(queue.reviews.map((review: { claimId: string }) => review.claimId)).toEqual([
      "speedjack-claim",
    ]);
    expect(reviewed.document.observations).toEqual([]);
    expect(reviewed.document.decisions).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(content);
  });

  it("exports full source facts alongside a bounded rendering and original entering LN occupancy", async () => {
    const f = await workflowFixture();
    const dir = await temporary();
    const taskPath = join(dir, "task.json");
    await writeFile(taskPath, serializeCanonicalJson(f.task));
    await exec(process.execPath, [
      script,
      "--",
      "evidence",
      "--task",
      taskPath,
      "--out",
      join(dir, "evidence"),
      "--start-ms",
      "500",
      "--end-ms",
      "1400",
    ]);
    const facts = await json(join(dir, "evidence/facts.json"));
    const manifest = await json(join(dir, "evidence/manifest.json"));
    expect(facts.notes).toEqual(f.task.structure.notes);
    expect(manifest.taskSha256).toBe(f.task.taskSha256);
    expect(manifest.renderedRange).toEqual({ startMs: 500, endMs: 1400 });
    expect(manifest.entryLongNoteOccupancy[0].startMs).toBe(200);
    expect(manifest.entryLongNoteOccupancy[0].endMs).toBe(1300);
    expect(new Uint8Array(await readFile(join(dir, "evidence/source.osu")))).toEqual(f.sourceBytes);
    expect(await readFile(join(dir, "evidence", manifest.pages[0].filename), "utf8")).toContain(
      "<svg",
    );
  });

  it("seals proposals, then reads saved human dispositions without changing the original handoff", async () => {
    const f = await workflowFixture();
    const dir = await temporary();
    await writeFile(join(dir, "task.json"), serializeCanonicalJson(f.task));
    const { handoffId, createdAt, agent, proposals, audit, questions } = f.handoff;
    await writeFile(
      join(dir, "proposal.json"),
      serializeCanonicalJson({ handoffId, createdAt, agent, proposals, audit, questions }),
    );
    await exec(process.execPath, [
      script,
      "handoff",
      "--task",
      join(dir, "task.json"),
      "--input",
      join(dir, "proposal.json"),
      "--out",
      join(dir, "handoff.json"),
    ]);
    const handoff = await json(join(dir, "handoff.json"));
    expect(handoff).toEqual(f.handoff);
    let document = (await importHandoffV2(f.registered, handoff, f.sourceBytes)).document;
    document = await decideClaimV2(
      document,
      {
        handoffId,
        claimId: f.claim.id,
        humanId: "fixture-human",
        disposition: "accepted",
        rationale: "Test of an explicit human operation.",
      },
      f.sourceBytes,
    );
    document = await decideClaimV2(
      document,
      {
        handoffId,
        claimId: "streams-claim",
        humanId: "fixture-human",
        disposition: "deferred",
        rationale: "Leave this independent claim open.",
      },
      f.sourceBytes,
    );
    const canonicalPath = join(dir, "review.v2.json");
    const canonical = serializeCanonicalJson(document);
    await writeFile(canonicalPath, canonical);
    const result = await exec(process.execPath, [script, "dispositions", "--file", canonicalPath]);
    expect(JSON.parse(result.stdout)).toEqual(await readDispositionsV2(document));
    expect(await readFile(canonicalPath, "utf8")).toBe(canonical);
    expect(await json(join(dir, "handoff.json"))).toEqual(f.handoff);

    await mkdir(join(dir, "workflow"));
    const compactPath = join(dir, "workflow", `${f.inspected.source.sha256}.v2.json`);
    await writeFile(compactPath, canonical);
    await compactReviewWorkspace(dir);
    const compactBytes = await readFile(compactPath, "utf8");
    expect(JSON.parse(compactBytes).storage).toBe("beatmap-lens-local-compact-v1");
    expect(await readCanonicalWorkflowFile(compactPath)).toBe(canonical);
    for (const command of ["dispositions", "review-status", "expert-queue"]) {
      const result = JSON.parse(
        (await exec(process.execPath, [script, command, "--file", compactPath])).stdout,
      );
      if (command === "dispositions") expect(result).toEqual(await readDispositionsV2(document));
      else {
        expect(result.reviews).toEqual(
          command === "review-status"
            ? await readAgentReviewsV2(document)
            : await readExpertQueueV2(document),
        );
      }
    }
    expect(await readFile(compactPath, "utf8")).toBe(compactBytes);
    expect(await readCanonicalWorkflowFile(compactPath)).toBe(canonical);
  });
});

describe("task packet storage CLI", () => {
  it("compacts a finished campaign's packets and expands them to the exact bytes", async () => {
    const f = await workflowFixture();
    const dir = await temporary();
    const folder = join(dir, "dispatch/delivery/labeler-001/packets/case-1");
    const path = join(folder, "task.json");
    const canonical = serializeCanonicalJson(f.task);
    await mkdir(folder, { recursive: true });
    await writeFile(path, canonical);
    const compacted = await exec(process.execPath, [script, "compact-packets", "--root", dir]);
    expect(JSON.parse(compacted.stdout)).toMatchObject({ compacted: 1, kept: [] });
    expect(JSON.parse(await readFile(path, "utf8")).storage).toBe("beatmap-lens-local-compact-v1");
    const expanded = await exec(process.execPath, [script, "expand-packets", "--root", dir]);
    expect(JSON.parse(expanded.stdout)).toEqual({ expanded: 1 });
    expect(await readFile(path, "utf8")).toBe(canonical);
  });
});

async function temporary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "beatmap-lens-cli-"));
  directories.push(dir);
  return dir;
}

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function serve(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a port.");
  return `http://127.0.0.1:${address.port}`;
}
