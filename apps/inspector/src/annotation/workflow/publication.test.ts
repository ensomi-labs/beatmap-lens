import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../canonical-json";
import { inspectOsuSourceV1 } from "../source-identity";
import type { AgentProvenanceV2, HumanEvidenceRefV2 } from "./contracts";
import {
  addHumanObservationsV2,
  addHumanObservationV2,
  createReviewDocumentV2,
  createTaskPacketV2,
  decideClaimV2,
  hashWorkflowValueV2,
  importAuditV2,
  importHandoffV2,
  registerTaskV2,
  sealAuditV2,
  sealHandoffV2,
} from "./domain";
import {
  assemblePublicationInputV1,
  humanPublicationRecordIdV1,
  projectReviewForPublicationV1,
} from "./publication";
import { NOW, workflowFixture } from "./test-fixtures";

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function reviewedFixture(
  options: {
    producer?: string;
    auditorModel?: string;
    refs?: HumanEvidenceRefV2[];
    trackedAuditor?: boolean;
  } = {},
) {
  const f = await workflowFixture();
  const agent: AgentProvenanceV2 = {
    producerId: options.producer ?? "labeler-instance-1",
    role: "labeler",
    model: "frozen-model",
    toolVersion: "frozen-tool",
    skill: { name: "judgment", version: "1", sha256: "a".repeat(64) },
  };
  const handoff = await sealHandoffV2(f.task, {
    handoffId: options.producer ?? "publication-handoff",
    agent,
    createdAt: NOW,
    proposals: [
      f.claim,
      { ...f.claim, id: "negative", tagId: "streams", assessment: { presence: "absent" } },
    ],
    audit: [],
    questions: [],
    humanEvidenceRefs: options.refs ?? [],
  });
  const imported = await importHandoffV2(f.registered, handoff, f.sourceBytes);
  const audit = await sealAuditV2(f.task, handoff, {
    auditId: `${handoff.handoffId}-audit`,
    createdAt: NOW,
    agent: {
      producerId: `auditor-${agent.producerId}`,
      role: "auditor",
      model: options.auditorModel ?? "frozen-auditor",
    },
    claims: handoff.proposals.map((claim) => ({
      claimId: claim.id,
      outcome: "supported",
      rationale: "Independent source judgment.",
    })),
    questions: [],
    ...(options.trackedAuditor === false ? {} : { humanEvidenceRefs: options.refs ?? [] }),
  });
  const reviewed = await importAuditV2(imported.document, audit, f.sourceBytes);
  return { ...f, handoff, reviewed: reviewed.document };
}

async function secondSource(f: Awaited<ReturnType<typeof workflowFixture>>) {
  const bytes = new TextEncoder().encode(
    new TextDecoder().decode(f.sourceBytes).replace("Version: Mixed", "Version: Auxiliary"),
  );
  const { source } = await inspectOsuSourceV1(bytes);
  const document = await createReviewDocumentV2(source, f.document.foundation, { now: () => NOW });
  const task = await createTaskPacketV2(document, bytes, { now: () => NOW });
  const registered = await registerTaskV2(document, task, bytes, { now: () => NOW });
  const human = await addHumanObservationV2(
    registered,
    { id: "auxiliary-gold", humanId: "expert", claim: f.claim },
    bytes,
  );
  return { bytes, human };
}

describe("dataset publication projection", () => {
  it("exports confidence-only revisions independently of claims and auxiliary evidence", async () => {
    const f = await reviewedFixture();
    const input = {
      handoffId: f.handoff.handoffId,
      claimId: f.claim.id,
      humanId: "expert",
      disposition: "accepted" as const,
    };
    const original = await decideClaimV2(
      f.reviewed,
      { ...input, id: "low", confidence: "low" },
      f.sourceBytes,
    );
    const before = (await projectReviewForPublicationV1(original)).human[0];
    const revised = await decideClaimV2(
      original,
      { ...input, id: "high", confidence: "high" },
      f.sourceBytes,
    );
    const projection = await projectReviewForPublicationV1(revised);
    const after = projection.human[0];
    expect(before?.human_confidence).toBe("low");
    expect(after?.human_confidence).toBe("high");
    expect(after?.details.proposal_changes).toEqual([]);
    expect(after?.details.human_revision).toEqual({
      previous_observation_id: before?.observation_id,
      previous_observation_sha256: before?.observation_sha256,
      changed_fields: ["confidence"],
    });
    expect(after?.details.evidence).toEqual(before?.details.evidence);
    expect(after?.details.evidence_review).toEqual(before?.details.evidence_review);
    expect(after?.auxiliary_evidence_status).toBe(before?.auxiliary_evidence_status);
    expect(after?.observation_sha256).not.toBe(before?.observation_sha256);
    expect(projection.agents.every((row) => row.human_confidence === null)).toBe(true);
    const historical = await addHumanObservationV2(
      f.registered,
      { claim: f.claim, humanId: "expert" },
      f.sourceBytes,
    );
    expect((await projectReviewForPublicationV1(historical)).human[0]?.human_confidence).toBeNull();
  });

  it("binds a label-only revision to unchanged notes and compares proposal note sets without order", async () => {
    const f = await reviewedFixture();
    const input = { handoffId: f.handoff.handoffId, claimId: f.claim.id, humanId: "expert" };
    const confirmed = await decideClaimV2(
      f.reviewed,
      { ...input, id: "before", disposition: "accepted" },
      f.sourceBytes,
    );
    const before = (await projectReviewForPublicationV1(confirmed)).human[0];
    if (!before) throw new Error("Missing confirmed publication row.");
    const modified = await decideClaimV2(
      confirmed,
      {
        ...input,
        id: "after",
        disposition: "modified",
        modifiedClaim: {
          ...f.claim,
          assessment: { presence: "absent" },
          evidence: {
            ...f.claim.evidence,
            noteRefs: [...f.claim.evidence.noteRefs].reverse(),
            contextNoteRefs: [...f.claim.evidence.contextNoteRefs].reverse(),
          },
        },
      },
      f.sourceBytes,
    );
    const after = (await projectReviewForPublicationV1(modified)).human[0];
    if (!after) throw new Error("Missing revised publication row.");
    expect(after.presence).toBe("absent");
    expect(after.details.proposal_changes).toEqual(["assessment"]);
    expect(after.details.evidence.rationale).toBe(before.details.evidence.rationale);
    expect(after.details.evidence_review).toBeNull();
    expect(after.record_id).not.toBe(before.record_id);
    expect(after.observation_sha256).not.toBe(before.observation_sha256);
    expect(after.observation_sha256).toBe(
      await hashWorkflowValueV2(
        modified.observations.find(({ id }) => id === after.observation_id),
      ),
    );
    expect(after.supersedes_record_ids).toContain(before.record_id);
    expect(after.details.human_revision).toEqual({
      previous_observation_id: before.observation_id,
      previous_observation_sha256: before.observation_sha256,
      changed_fields: ["assessment"],
    });
    const notesOnly = await decideClaimV2(
      modified,
      {
        ...input,
        id: "notes-only",
        disposition: "modified",
        modifiedClaim: {
          ...f.claim,
          assessment: { presence: "absent" },
          evidence: { ...f.claim.evidence, noteRefs: f.claim.evidence.noteRefs.slice(1) },
        },
      },
      f.sourceBytes,
    );
    const latest = (await projectReviewForPublicationV1(notesOnly)).human[0];
    expect(latest?.details.proposal_changes).toEqual(["assessment", "witnesses"]);
    expect(latest?.details.human_revision).toEqual({
      previous_observation_id: after.observation_id,
      previous_observation_sha256: after.observation_sha256,
      changed_fields: ["witnesses"],
    });
  });

  it("distinguishes successive direct label, note, and metadata-only human revisions", async () => {
    const f = await workflowFixture();
    const input = { humanId: "expert", claim: f.claim };
    const initial = await addHumanObservationV2(
      f.registered,
      { ...input, id: "initial" },
      f.sourceBytes,
    );
    const labelClaim = { ...f.claim, assessment: { presence: "absent" as const } };
    const label = await addHumanObservationV2(
      initial,
      {
        ...input,
        id: "label",
        claim: labelClaim,
        supersedesObservationId: `initial:${f.claim.id}`,
      },
      f.sourceBytes,
    );
    expect(
      (await projectReviewForPublicationV1(label)).human[0]?.details.human_revision?.changed_fields,
    ).toEqual(["assessment"]);
    const noteClaim = {
      ...labelClaim,
      evidence: { ...f.claim.evidence, noteRefs: f.claim.evidence.noteRefs.slice(1) },
    };
    const notes = await addHumanObservationV2(
      label,
      {
        ...input,
        id: "notes",
        claim: noteClaim,
        supersedesObservationId: `label:${f.claim.id}`,
      },
      f.sourceBytes,
    );
    const projected = await projectReviewForPublicationV1(notes);
    expect(projected.human).toHaveLength(1);
    const previous = label.observations.find(({ id }) => id === `label:${f.claim.id}`);
    expect(projected.human[0]?.details.human_revision).toEqual({
      previous_observation_id: `label:${f.claim.id}`,
      previous_observation_sha256: await hashWorkflowValueV2(previous),
      changed_fields: ["witnesses"],
    });
    expect(projected.human[0]?.details.proposal_changes).toBeNull();
    const metadata = await addHumanObservationsV2(
      notes,
      {
        humanId: input.humanId,
        id: "metadata",
        claims: [noteClaim],
        supersedesObservationId: `notes:${f.claim.id}`,
        evidenceReviews: {
          [f.claim.id]: {
            selectionOrigin: "inherited-human",
            sourceObservationId: `notes:${f.claim.id}`,
            sourceClaimId: f.claim.id,
            operations: [],
            selectionReviewed: true,
            rationaleReviewed: false,
          },
        },
      },
      f.sourceBytes,
    );
    const revised = (await projectReviewForPublicationV1(metadata)).human[0];
    expect(revised?.details.human_revision?.changed_fields).toEqual([]);
    expect(revised?.details.evidence_review?.selectionReviewed).toBe(true);
    expect(revised?.details.human_revision?.previous_observation_id).toBe(`notes:${f.claim.id}`);
    expect(revised?.observation_sha256).not.toBe(projected.human[0]?.observation_sha256);
  });

  it("reports proposal tag changes through the common claim comparison", async () => {
    const f = await reviewedFixture();
    const modified = await decideClaimV2(
      f.reviewed,
      {
        handoffId: f.handoff.handoffId,
        claimId: f.claim.id,
        humanId: "expert",
        id: "tag-change",
        disposition: "modified",
        modifiedClaim: { ...f.claim, tagId: "streams" },
      },
      f.sourceBytes,
    );
    const row = (await projectReviewForPublicationV1(modified)).human[0];
    expect(row?.details.proposal_changes).toEqual(["tag_id"]);
    expect(row?.details.human_revision).toBeNull();
  });

  it("builds typed HF tables from the actual domain collector projection", async () => {
    const f = await reviewedFixture();
    const document = await decideClaimV2(
      f.reviewed,
      {
        handoffId: f.handoff.handoffId,
        claimId: f.claim.id,
        humanId: "expert",
        id: "publication-accept",
        disposition: "accepted",
        confidence: "high",
        rationale: "原始人工确认。",
        evidenceReview: {
          selectionOrigin: "inherited-agent",
          sourceHandoffId: f.handoff.handoffId,
          sourceClaimId: f.claim.id,
          operations: [
            { kind: "auto-scope-fill", target: "witness" },
            { kind: "explicit-scope-selection", target: "witness" },
          ],
          selectionReviewed: true,
          rationaleReviewed: false,
        },
      },
      f.sourceBytes,
    );
    const root = await mkdtemp(join(tmpdir(), "publication-python-"));
    workspaces.push(root);
    const { collectAnnotationRelease } = await import(
      /* @vite-ignore */ pathToFileURL(
        resolve("apps/inspector/server/collect-annotation-release.mjs"),
      ).href
    );
    const { atomicWrite } = await import(
      /* @vite-ignore */ pathToFileURL(
        resolve("apps/inspector/server/workflow-local-directory.mjs"),
      ).href
    );
    await mkdir(join(root, "workflow"));
    await atomicWrite(
      join(root, "workflow", `${document.source.sha256}.v2.json`),
      JSON.stringify(document),
    );
    const input = await collectAnnotationRelease({ workspace: root, createdAt: NOW });
    await writeFile(join(root, "input.json"), JSON.stringify(input));
    const code = `
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd()/'annotation/release'))
from snapshot import build_snapshot, validate_snapshot
import pyarrow.parquet as pq
root = Path(sys.argv[1])
data = json.loads((root/'input.json').read_text())
artifact = lambda sha: dict(repository='https://github.com/ensomi-labs/beatmap-lens', commit='a'*40, path='annotation/test.json', sha256=sha)
sources = {s['sha256']: s for s in data['sources']}
for foundation in data['foundations'].values():
 for example in foundation['calibrationExamples']:
  sources[example['source']['sha256']] = example['source']
config = dict(release_id='integration', repo_id='example/integration', title='Synthetic integration', license='cc0-1.0',
 exporter=artifact('b'*64),
 sources={sha:dict(kind='hf',repository='example/corpus',commit='c'*40,path='charts.parquet',record_key=sha) for sha in sources},
 foundations={sha:dict(artifact=artifact(data['foundation_artifacts'][sha]['sha256']),relationship='source-bytes-referenced') for sha in data['foundations']},
 methods={}, policy=dict(agent_methods=list(data['methods']),auxiliary_evidence=['current'],allow_partial_method_provenance=True))
manifest=build_snapshot(data,config,root/'snapshot')
report=validate_snapshot(root/'snapshot')
human=pq.read_table(root/'snapshot/data/human.parquet').to_pylist()
assert human[0]['details']['human_rationale']=='原始人工确认。'
assert human[0]['details']['evidence_review']['selection_origin']=='inherited-agent'
assert human[0]['details']['evidence_review']['selection_reviewed'] is True
assert human[0]['details']['evidence_review']['rationale_reviewed'] is False
assert [op['kind'] for op in human[0]['details']['evidence_review']['operations']]==['auto-scope-fill','explicit-scope-selection']
assert human[0]['details']['proposal_changes']==[]
assert human[0]['observation_sha256']==data['human'][0]['observation_sha256']
assert human[0]['cell_id'].startswith('cell-')
assert human[0]['human_confidence']=='high'
assert manifest['version']==4
print(json.dumps(manifest['counts']))
`;
    const counts = JSON.parse(
      execFileSync(resolve(".venv/bin/python"), ["-c", code, root], { encoding: "utf8" }),
    );
    expect(counts.human).toBe(1);
    expect(Object.values(counts.agents)).toEqual([2]);
  }, 30_000);

  it("exports effective gold with exact direct and proposal revision lineage, without implicit negatives", async () => {
    const f = await reviewedFixture();
    const input = { handoffId: f.handoff.handoffId, claimId: f.claim.id, humanId: "expert" };
    let document = await decideClaimV2(
      f.reviewed,
      { ...input, id: "accepted", disposition: "accepted", rationale: "Human accepted." },
      f.sourceBytes,
    );
    document = await decideClaimV2(
      document,
      {
        ...input,
        id: "modified",
        disposition: "modified",
        rationale: "人类更正原文。",
        modifiedClaim: {
          ...f.claim,
          scope: { startMs: 1000, endMs: 1700 },
          assessment: { presence: "absent" },
        },
      },
      f.sourceBytes,
    );
    document = await decideClaimV2(
      document,
      { ...input, claimId: "negative", id: "rejected", disposition: "rejected" },
      f.sourceBytes,
    );
    document = await addHumanObservationV2(
      document,
      {
        id: "direct-old",
        humanId: "expert",
        claim: { ...f.claim, id: "direct", tagId: "longjack" },
      },
      f.sourceBytes,
    );
    document = await addHumanObservationV2(
      document,
      {
        id: "direct-new",
        humanId: "expert",
        supersedesObservationId: "direct-old:direct",
        claim: {
          ...f.claim,
          id: "direct",
          tagId: "longjack",
          assessment: { presence: "unreviewed" },
        },
      },
      f.sourceBytes,
    );
    const projection = await projectReviewForPublicationV1(document);
    expect(projection.human).toHaveLength(2);
    for (const row of projection.human) {
      const original = document.observations.find(
        (observation) => observation.id === row.observation_id,
      );
      expect(row.observation_sha256).toBe(await hashWorkflowValueV2(original));
    }
    expect(projection.agents.every((row) => row.observation_sha256 === undefined)).toBe(true);
    const modified = projection.human.find((row) => row.observation_id === "modified:observation");
    expect(modified).toMatchObject({
      presence: "absent",
      salience: null,
      end_ms: 1700,
      origin: "human-modified",
      details: {
        human_rationale: "人类更正原文。",
        evidence: f.claim.evidence,
        evidence_review: null,
        proposal_changes: ["assessment", "scope"],
      },
    });
    expect(modified?.supersedes_record_ids).toEqual([
      humanPublicationRecordIdV1(document.source.sha256, "accepted:observation"),
    ]);
    expect(
      projection.human.find((row) => row.observation_id === "direct-new:direct"),
    ).toMatchObject({
      presence: "unreviewed",
      salience: null,
      supersedes_record_ids: [
        humanPublicationRecordIdV1(document.source.sha256, "direct-old:direct"),
      ],
    });
    expect(
      projection.agents.map((row) => [row.review_status, row.presence, row.audit_supported]),
    ).toEqual([
      ["modified", "present", true],
      ["rejected", "absent", true],
    ]);
    expect(JSON.stringify(projection)).not.toContain("sourceBytes");
    for (const [frozenSha, artifact] of Object.entries(projection.foundation_artifacts)) {
      expect(artifact.sha256).toBe(await sha256Hex(artifact.content));
      expect(JSON.parse(artifact.content)).toEqual(projection.foundations[frozenSha]);
      expect(artifact.sha256).not.toBe(frozenSha);
    }
  });

  it("resolves cross-source dependencies from the complete inventory, preserving human authority after drift", async () => {
    const f = await workflowFixture();
    const second = await secondSource(f);
    const observation = second.human.observations[0];
    if (!observation) throw new Error("Missing auxiliary observation.");
    const ref = {
      sourceSha256: second.human.source.sha256,
      observationId: observation.id,
      observationSha256: await hashWorkflowValueV2(observation),
    };
    const labeled = await reviewedFixture({ refs: [ref] });
    const accepted = await decideClaimV2(
      labeled.reviewed,
      {
        id: "confirmed",
        humanId: "expert",
        handoffId: labeled.handoff.handoffId,
        claimId: labeled.claim.id,
        disposition: "accepted",
      },
      labeled.sourceBytes,
    );
    const firstProjection = await projectReviewForPublicationV1(accepted);
    const secondProjection = await projectReviewForPublicationV1(second.human);
    const options = { createdAt: NOW, sourceShas: [f.inspected.source.sha256] };
    const current = assemblePublicationInputV1([firstProjection, secondProjection], options);
    expect(current.sources).toHaveLength(1);
    expect(current.human[0]?.auxiliary_evidence_status).toBe("current");
    expect(current.agents.every((row) => row.auxiliary_evidence_status === "current")).toBe(true);
    const changed = await addHumanObservationV2(
      second.human,
      {
        id: "auxiliary-correction",
        supersedesObservationId: observation.id,
        humanId: "expert",
        claim: { ...f.claim, assessment: { presence: "absent" } },
      },
      second.bytes,
    );
    const stale = assemblePublicationInputV1(
      [firstProjection, await projectReviewForPublicationV1(changed)],
      options,
    );
    expect(stale.human[0]).toMatchObject({
      origin: "human-confirmed",
      auxiliary_evidence_status: "changed",
      source_status: "current",
      foundation_status: "current",
    });
    expect(stale.agents.every((row) => row.auxiliary_evidence_status === "changed")).toBe(true);
    expect(
      assemblePublicationInputV1([firstProjection], options).agents[0]?.auxiliary_evidence_status,
    ).toBe("untracked");
    const partial = await reviewedFixture({ refs: [ref], trackedAuditor: false });
    expect(
      assemblePublicationInputV1(
        [await projectReviewForPublicationV1(partial.reviewed), secondProjection],
        options,
      ).agents[0]?.auxiliary_evidence_status,
    ).toBe("untracked");
  });

  it("groups recorded methods across worker instances and keeps independent audit outcomes separate from human decisions", async () => {
    const a = await reviewedFixture({ producer: "worker-a" });
    const b = await reviewedFixture({ producer: "worker-b" });
    const c = await reviewedFixture({ producer: "worker-c", auditorModel: "different-auditor" });
    const projections = await Promise.all(
      [a, b, c].map((f) => projectReviewForPublicationV1(f.reviewed)),
    );
    expect(Object.keys(projections[0]?.methods ?? {})).toEqual(
      Object.keys(projections[1]?.methods ?? {}),
    );
    expect(Object.keys(projections[0]?.methods ?? {})).not.toEqual(
      Object.keys(projections[2]?.methods ?? {}),
    );
    const p = projections[0];
    if (!p) throw new Error("Missing projection.");
    expect(JSON.stringify(p.methods)).not.toContain("producerId");
    expect(Object.values(p.provenance)[0]?.labeler_producer_id).toBe("worker-a");
    expect(p.agents.every((row) => row.audit_status === "supported")).toBe(true);
    const conflictingAudit = await sealAuditV2(a.task, a.handoff, {
      auditId: "disagreeing-audit",
      createdAt: NOW,
      agent: { role: "auditor", producerId: "different-independent-auditor" },
      humanEvidenceRefs: [],
      claims: a.handoff.proposals.map((claim) => ({
        claimId: claim.id,
        outcome: "needs-revision",
        rationale: "Independent disagreement.",
      })),
      questions: [],
    });
    const conflict = await importAuditV2(a.reviewed, conflictingAudit, a.sourceBytes);
    const rows = (await projectReviewForPublicationV1(conflict.document)).agents;
    expect(
      rows.every(
        (row) =>
          row.audit_status === "conflicting" &&
          !row.audit_supported &&
          row.review_status === "needs-expert",
      ),
    ).toBe(true);
  });

  it("collects the same cross-source projection with serial and parallel validation", async () => {
    const f = await reviewedFixture();
    const auxiliary = await secondSource(f);
    const workspace = await mkdtemp(join(tmpdir(), "annotation-publication-parallel-"));
    workspaces.push(workspace);
    const adapterUrl = pathToFileURL(
      resolve("apps/inspector/server/workflow-local-directory.mjs"),
    ).href;
    const collectorUrl = pathToFileURL(
      resolve("apps/inspector/server/collect-annotation-release.mjs"),
    ).href;
    const { LocalDirectoryHandle } = await import(/* @vite-ignore */ adapterUrl);
    const { collectAnnotationRelease, writeCollectedInput } = await import(
      /* @vite-ignore */ collectorUrl
    );
    const root = new LocalDirectoryHandle(workspace);
    const workflow = await root.getDirectoryHandle("workflow", { create: true });
    for (const document of [f.reviewed, auxiliary.human]) {
      const file = await workflow.getFileHandle(`${document.source.sha256}.v2.json`, {
        create: true,
      });
      await file.writeCanonicalJson(document, await hashWorkflowValueV2(document));
    }
    const serial = await collectAnnotationRelease({ workspace, createdAt: NOW });
    const parallel = await collectAnnotationRelease({ workspace, createdAt: NOW, workers: 2 });
    expect(parallel).toEqual(serial);
    expect(parallel.sources).toHaveLength(2);
    expect(parallel.human).toHaveLength(1);
    expect(parallel.agents).toHaveLength(2);
    const output = join(workspace, "release-input.json");
    await writeCollectedInput(output, parallel);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(serial);

    const path = join(workspace, "workflow", `${f.reviewed.source.sha256}.v2.json`);
    await writeFile(path, "{broken");
    await expect(
      collectAnnotationRelease({ workspace, createdAt: NOW, workers: 2 }),
    ).rejects.toThrow();
  });

  it.each([1, 2])(
    "collects read-only and rejects concurrent changes with %i workers",
    async (workers) => {
      const f = await reviewedFixture();
      const workspace = await mkdtemp(join(tmpdir(), "annotation-publication-"));
      workspaces.push(workspace);
      const adapterUrl = pathToFileURL(
        resolve("apps/inspector/server/workflow-local-directory.mjs"),
      ).href;
      const collectorUrl = pathToFileURL(
        resolve("apps/inspector/server/collect-annotation-release.mjs"),
      ).href;
      const { LocalDirectoryHandle } = await import(/* @vite-ignore */ adapterUrl);
      const { collectAnnotationRelease } = await import(/* @vite-ignore */ collectorUrl);
      const root = new LocalDirectoryHandle(workspace);
      const workflow = await root.getDirectoryHandle("workflow", { create: true });
      const name = `${f.reviewed.source.sha256}.v2.json`;
      const file = await workflow.getFileHandle(name, { create: true });
      await file.writeCanonicalJson(f.reviewed, await hashWorkflowValueV2(f.reviewed));
      const path = join(workspace, "workflow", name);
      const before = await readFile(path);
      const result = await collectAnnotationRelease({ workspace, createdAt: NOW, workers });
      expect(result.contract).toBe("beatmap-lens-release-input");
      expect(result.agents).toHaveLength(2);
      const implementationPaths = Object.keys(result.collector_files);
      expect(implementationPaths).toEqual(
        expect.arrayContaining([
          "apps/inspector/server/collect-annotation-release.mjs",
          "apps/inspector/server/workflow-local-directory.mjs",
          "apps/inspector/src/annotation/workflow/domain.ts",
          "apps/inspector/src/annotation/workflow/publication.ts",
          "apps/inspector/src/annotation/source-identity.ts",
          "packages/beatmap-lens/src/parser.ts",
          "apps/inspector/package.json",
          "package.json",
          "pnpm-lock.yaml",
        ]),
      );
      expect(
        implementationPaths.every((key) => !key.includes(".test.") && !key.includes(".agents/")),
      ).toBe(true);
      for (const key of implementationPaths)
        expect(result.collector_files[key]).toBe(await sha256Hex(await readFile(resolve(key))));
      expect(result.workspace_files).toEqual([
        {
          source_sha256: f.reviewed.source.sha256,
          canonical_sha256: await hashWorkflowValueV2(f.reviewed),
        },
      ]);
      expect(await readFile(path)).toEqual(before);
      await expect(
        collectAnnotationRelease({
          workspace,
          workers,
          onProgress: async () => writeFile(path, Buffer.concat([before, Buffer.from("\n")])),
        }),
      ).rejects.toThrow("Workspace changed during release collection");
    },
  );
});
