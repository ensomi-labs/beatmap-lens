# Agent–human section review

For learning from natural charts, community observations, and confirmed expert
sections, use the [beatmap reading workflow](beatmap-learning.md). Agent-only
section proposals and agreeing audits are workflow artifacts, not learning targets
or human experience in that path.

Beatmap Lens gives a human and an external agent the same source-backed object of
judgment. A beatmapset groups the work. Each claim belongs to one difficulty's
exact source bytes and one source-time interval. Shared audio and community tags
do not transfer a claim to another difficulty.

## Judgment and evidence

A claim separates judgment, context, and evidence:

- `scope` is the half-open source interval whose complete arrangement is judged.
- `reviewContext` is the surrounding source interval needed to inspect that judgment.
- `evidence.noteRefs` and `evidence.contextNoteRefs` select the witness notes and
  relevant context for this particular claim. They may be non-contiguous.

Witnesses explain a section judgment; they are not note-level ground truth or a
new cropped chart. A hold beginning before the claim can remain occupied inside
it. Its original start, end, column, and source line remain intact. Playback rate,
visual speed, pagination, and selection do not change source identity or time.

Each tag receives its own assessment:

| Assessment | Meaning |
| --- | --- |
| `present`, `supporting` | A certain positive that contributes to the section |
| `present`, `prominent` | A positive that strongly characterizes the section |
| `absent` | An explicit negative for a dimension actually inspected in this scope |
| `unresolved` | Inspected, but the evidence or semantic boundary does not settle the judgment |
| `unreviewed` or no claim | This dimension has no recorded assessment |

Multiple tags can be prominent. Supporting does not mean uncertain. Collection
is positive-first and partially exhaustive: missing labels never become negatives.
Accepting one claim does not settle another claim in the same section.

`boundaryUncertainty` optionally describes acceptable cuts near the nominal
boundaries. `transition` describes an evidenced temporal change, with its own
witnesses and explanation. Neither field is a substitute for an unresolved
assessment. Overlapping sections and mixed sections are allowed; overlaps do not
create independent training examples. `exemplarRole` records a calibration use
separately from the concept judgment.

## Vocabulary and authority

The annotation workflow uses the approved Jack, Stream, Trill, Tech, and LN
coordination definitions carried by the task's Foundation. Read the
[judgment guide](../../.agents/skills/mania-pattern-judgment/references/judgment-guide.md)
for interpretation and the [design decisions](../decisions/0006-query-assisted-style-recognition.md)
for the rationale behind the selected vocabulary. A proposed template or documented
research hypothesis does not acquire approval by being loaded into a task.

Section predicates and whole-difficulty community tags have different scopes.
Community tags can guide discovery; they do not locate or prove section judgments.
In particular, the local Tech concept is not an alias for a community complex-snap
tag, an exclusive category, or a fallback for passages that lack other labels.
Source facts support a judgment; agent agreement cannot approve a semantic change.

Selected-section labelers and auditors use the shared
[worker mounting protocol](fine-annotation.md#worker-mounting-protocol): a fresh
context, the prepared job's frozen instructions, and at most four windows per
worker. Source and human-reference inspection remain available inside that job's
harness boundary. The parent prepares and delivers; it does not supply a second
interpretation guide or carry earlier batches into the worker's context.

Preserve exact human assessments and their optional original comments. Missing
human explanation does not license an agent rationale to become expert evidence.
Use the [curator role](../../annotation/roles/curator.md) for actual semantic
proposals outside routine labeling and audit.

## Persistent workspace and automatic delivery

Run the local service against the persistent workspace containing the registered
sources and approved Foundation. Build the Inspector before serving it:

```sh
pnpm --filter @ensomi/beatmap-lens-inspector build
pnpm review:workspace --workspace .local/campaign/workspace
```

The equivalent service command is
`node apps/inspector/server/review-workspace.mjs --workspace .local/campaign/workspace`.
The fixed human page is **http://127.0.0.1:4176/review**. It displays incoming
expert cases, explicit spot-check requests, ordinary agent review status, and saved
human responses. Normal review requires no JSON import/export or directory picker.
The selected chart's left rail shows difficulty-level community tags, per-tag votes,
their sum, and the dataset snapshot date. The service reads metadata on demand from
`ENSOMI_DATASET` or the configured ensomi checkout; use `--dataset PATH`
for another dataset root. See [runtime configuration](corpus-annotation.md#local-inputs-and-runtime). These
display-only tags are joined by beatmapset and beatmap IDs and are excluded from
canonical review documents, frozen agent tasks, and agent feedback.
The service keeps canonical documents in `workflow/*.v2.json` and exchange delivery
records in `exchange/inbox`, `exchange/receipts`, `exchange/requests`, and
`exchange/outbox`, within the selected persistent workspace.

Agents can work while the human reviews. They submit packets to the service;
the service validates and serializes canonical updates, updates the inbox, and
writes dispositions to the outbox. An audit delivered before its original handoff
can receive `pending`; later delivery of the dependency allows it to be processed.
Receipts distinguish `imported`, `duplicate`, `pending`, and `error`. Keep receipt
identity and packet identity when inspecting a retry; never change sealed content
to make a stale or rejected submission appear current.

### Agent commands

```sh
pnpm annotation:workflow -- inbox --server http://127.0.0.1:4176
pnpm annotation:workflow -- fetch-task --server http://127.0.0.1:4176 --source-sha SOURCE_SHA --fresh --out task.json
pnpm annotation:workflow -- evidence --task task.json --out evidence/
pnpm annotation:workflow -- handoff --task task.json --input proposal.json --out handoff.json
pnpm annotation:workflow -- submit --server http://127.0.0.1:4176 --input handoff.json --out handoff-receipt.json
pnpm annotation:workflow -- audit --task task.json --handoff handoff.json --input audit.json --out sealed-audit.json
pnpm annotation:workflow -- submit --server http://127.0.0.1:4176 --input sealed-audit.json --out audit-receipt.json
pnpm annotation:workflow -- dispositions --server http://127.0.0.1:4176 --source-sha SOURCE_SHA --out dispositions.json
```

Use a source SHA returned by `inbox`. `fetch-task` without `--fresh` reads the
latest registered task; `--fresh` explicitly freezes current approved context
through the service. This bookkeeping does not need another human approval. It
creates a new task and never rebases an old packet. An auditor uses the exact task
that produced the original labeler handoff, not whichever task is latest now.

The task contains exact source bytes, the full normalized difficulty, Foundation
content and hash, and the review base. The labeler discovers sections without
human-selected windows. A bounded `evidence` export changes only the SVG range;
`source.osu` and `facts.json` still contain the complete difficulty, with entering
hold occupancy recorded in the manifest.

`submit` sends an existing sealed handoff/audit or an explicit review request,
without resealing, replacing hashes, or creating human decisions. It returns the
server receipt and fails cleanly on rejected HTTP requests or error receipts.
`inbox` includes per-source statuses, focused expert cases, pending review-request
members, and receipts. Network `dispositions` preserves human decisions, audit
results, review requests, and the saved document version. Agents read these views;
the human does not shuttle files between workers.

The network endpoints are `GET /api/review/inbox`, `GET`/`POST
/api/review/task/:sourceSha`, `POST /api/review/submit`, and `GET
/api/review/dispositions/:sourceSha`. These agent commands expose no Foundation
approval or human-observation mutation. See [the contracts](../../apps/inspector/src/annotation/workflow/contracts.ts),
[the CLI](../../apps/inspector/server/annotation-workflow.mjs), and
[the local service](../../apps/inspector/server/review-workspace.mjs).

### Explicit spot-check requests

A useful audit can support every selected claim. Do not fabricate uncertainty to
populate the expert queue. For a small human sample, a labeler or auditor can
submit a delivery-only request with `reason: "spot-check"`:

```json
{
  "requestId": "pilot-spot-check-1",
  "sourceSha256": "<source SHA-256>",
  "handoffId": "<original handoff ID>",
  "handoffSha256": "<original handoff content hash>",
  "claimIds": ["<claim to inspect>", "<another claim to inspect>"],
  "reason": "spot-check",
  "question": "Please inspect this small sample of independently audited claims.",
  "requestedBy": { "producerId": "<actual agent ID>", "role": "auditor" },
  "createdAt": "<creation timestamp>"
}
```

The agent sends this through `submit --server ... --input review-request.json`.
The service verifies its original handoff hash and claim IDs, persists the request,
and exposes it on the fixed human page. It does not alter the claim's audit status,
produce a semantic disagreement, or claim that the human requested the sample.
Each actual human decision, including defer, resolves only that request member;
other requested claims stay pending. The record of who requested the work remains.

### File operations

Evidence export, sealing, and file readback are also available to local tools:

```sh
pnpm annotation:workflow -- evidence --task task.json --out section-evidence/ --start-ms 40000 --end-ms 44000
pnpm annotation:workflow -- review-status --file review.v2.json --out agent-status.json
pnpm annotation:workflow -- expert-queue --file review.v2.json --out expert-queue.json
pnpm annotation:workflow -- dispositions --file review.v2.json --out dispositions.json
```

Read commands print to stdout if `--out` is omitted. Supply `--source chart.osu`
when a canonical file has no embedded source-bearing task. File `dispositions`
also accepts an Inspector-exported dispositions view; `review-status` and
`expert-queue` read canonical workflow documents. Offline commands do not import
packets or create human observations. The standalone file-based Review workspace
remains available for explicit offline use.

### Labeler submission

The `handoff` input has `handoffId`, `createdAt`, `agent`, `proposals`, `audit`, and
`questions`. Use role `labeler`, a stable producer identity, and at least one
source-backed claim. Its `audit` array preserves submission self-check notes; it
is not independent audit evidence and cannot promote a claim to agent-reviewed.
Questions identify affected claim IDs. A question with an empty `claimIds` array
applies to all claims in that handoff.

Sealing copies source, Foundation, task, and base bindings from the frozen task.
Keep an unchanged packet and its ID when retrying. A changed proposal is a new
handoff with a new ID; the old proposal remains intact. Do not silently replace
bindings with the current browser state. Source mismatches are rejected. A change
to unrelated human judgments does not invalidate the proposal or require rereading.
Source/Foundation compatibility and consulted human evidence are reported separately
from review status, as described below.
Repeated imports of identical content do not create duplicates.

A new machine review of an unresolved claim can include `supersedes`, with
`handoffId`, `handoffSha256`, `claimId`, and `replacementClaimId` for each old/new
claim pair. The source, Foundation, and tag must match. Normally the complete scope
also matches. A source-backed crop repair must supply `scopeChangeReason` on the
link and overlap the original scope; the independent auditor reviews the corrected
crop. Only the new range receives its assessment. Removed or added parts do not
inherit a separate label, and the invalid original crop remains in history. Only one
replacement may target a claim; further revisions continue from that replacement.
The old task remains active until independent review either supports the
replacement or refers its concrete uncertainty to the expert. An audited unresolved
revision can therefore reopen an earlier machine judgment without keeping that
judgment eligible as settled supervision or duplicating the expert task.
Original proposals and audits remain immutable, and the UI
links their superseded rows to the new judgment. Feedback includes both the exact
links and the effective `supersededBy` status; consumers follow the chain to its
current judgment instead of treating `superseded` as a semantic label.

A recorded human decision cannot be superseded by importing a machine proposal.
If the human responds while a replacement is being audited, that human decision
still takes precedence. Human acceptance or modification of a replacement also
keeps the prior machine task retired; rejection or deferral does not establish a
settled replacement. A later conflicting audit sends the current replacement to
expert review; its superseded history remains available through the same lineage.

New handoffs and independent audits require claims. A standalone semantic question
belongs to the curator lane.
### Independent audit

An independent auditor reads the same frozen task and the original sealed labeler
handoff. Submit `auditId`, `createdAt`, `agent`, `claims`, and `questions` to the
`audit` command. The auditor has role `auditor` and a `producerId` distinct from the
labeler's. Changing an identity on a self-check does not constitute independent
review. The resulting packet binds the original handoff ID **and content hash**,
as well as the exact source, Foundation, task, and base. It does not copy or rewrite
labeler proposals. Submit it to the same workspace; an out-of-order audit waits
for its original handoff instead of requiring a human to arrange imports.

Every original claim needs exactly one result with `claimId`, `outcome`, and
`rationale`. Outcomes are `supported`, `needs-revision`, or `needs-expert`;
`needs-expert` also requires an `expertReason` and a concrete `question`. Unresolved
or unreviewed proposals cannot be supported as settled claims. Return omissions
or incorrect crops that the agent can fix for revision instead of escalating
routine source inspection to the expert.

Every original question also needs exactly one disposition, with `questionId`,
`disposition`, and `rationale`. The dispositions are `resolved`, `needs-revision`,
and `needs-expert`. A supported claim cannot retain an unresolved associated
question. A question needing expert review requires each affected claim to carry
`needs-expert`; an empty original `claimIds` list affects every claim. Covering
all claims while dropping an inconvenient question does not pass validation.

### Routine results and expert decisions

The service inbox and dispositions show each original claim with its audit results
and any saved human decision; offline `review-status` exposes the same routing. The current routing is:

| Status | Next action |
| --- | --- |
| `awaiting-audit` | An independent auditor must inspect the proposal. |
| `agent-reviewed` | Current claim with consistently supported independent audits; retain as a machine workflow result, excluded from the natural-chart learning evidence. |
| `superseded` | Follow `supersededBy` to the current reviewed replacement, which can itself need the expert; retain this row as history. |
| `needs-revision` | Return the concrete defect to the labeler; submit a new immutable proposal and audit its new content. |
| `needs-expert` | Present the specific unresolved choice, evidence, and reason to the expert. Conflicting audit outcomes also enter this queue. |
| `stale` | The original source or Foundation no longer matches. Keep the immutable proposal as history; humans may inspect it and save an explicit judgment under the current Foundation. |
| `accepted`, `modified`, `rejected`, `deferred` | Follow the recorded human disposition. |

The human Review inbox has separate **Labeler version** and **Auditor version**
filters for requests, sampling, and history. Each option identifies the skill name,
revision and full content hash. Distinct named revisions remain selectable even
when their skill bytes are identical; the same revision name can also have different
content hashes. Historical saved samples with hash-only filters retain their full
content group. The chart's Review history and version selector are also visible
when opened from the connected inbox. Selecting an auditor finds claims it reviewed without
recomputing their recorded status from only that auditor's findings. A current
task base means source/Foundation compatibility, not the latest skill or unchanged
workspace-wide human history.

### Human revisions and evidence confidence

Humans may open every section, including stale, superseded, unaudited and already
reviewed proposals. An existing gold judgment can be revised. Each save appends a
new decision and observation; previous records remain available in history. Direct
human observations use an explicit `supersedesObservationId` revision link. Agent
proposals and audits remain immutable and cannot overwrite human decisions.

Consumers use `effectiveHumanObservations` in service feedback for current gold;
full dispositions retain the decision and observation history. An explicit revision
replaces its predecessor in that current view, even if its scope changes. Separate
overlapping human judgments are not silently merged or resolved by timestamps.
Concurrent writes still compare the actual document version and reject an obsolete
editor save, so revision support does not permit lost updates.

Review status describes who has judged a claim and the audit outcome. `trust`
separately records evidence compatibility, without numerical confidence scores:

| Layer | Meaning |
| --- | --- |
| `source` | Whether the exact source bytes match the frozen proposal. |
| `foundation` | Whether the definitions match the frozen proposal or current human observation. |
| `humanContext` | Whether the particular human examples exposed to the worker are still effective gold with the same content. |

The harness records the exact returned examples in an evidence trace. Delivery seals
their source hashes, observation IDs and observation hashes in `humanEvidenceRefs`
on both labeler handoffs and independent audits. The combined evidence flag covers
both roles; a legacy audit with missing tracking cannot count as tracked evidence.
The service checks those references across charts when reading feedback. Changing an
unrelated human judgment has no effect. A revised referenced example produces
`humanContext: changed`; unavailable or unrecorded provenance is `untracked`.
An explicitly tracked empty reference set is current, whereas legacy packets without
reference tracking remain untracked. These flags do not claim that a judgment is
correct or incorrect.

Auxiliary evidence changes never automatically enqueue rereading, remove a result
from human sampling, or prevent a human save. Publication and coverage analysis
can assess these layers independently; coverage reports expose `confidenceCounts`
without treating every evidence change as a repair request. Accepting an original
proposal under changed definitions is not implicit: the human reviews and saves an
explicit modified judgment against the current Foundation.

Requests, Sample, and History are separate views. A saved sample offers direct
continuation, with new-sample settings collapsed. In chart review, the judgment,
range, version, and decision controls precede expandable reasoning, audit findings,
and reference material. Saved human judgments remain visible.

Use the **History** view to search by chart, difficulty, or producer and
filter by status and label. Stale, superseded, and human-decided proposals remain
openable. A selected result shows the labeler version, individual auditor versions,
and other judgments for overlapping ranges. Overlap does not imply a replacement;
explicit supersession links still define the revision chain.

Sampling deduplicates identical scoped judgments only within the same labeler and
auditor version group. Saved samples retain their original version filters;
changing a filter applies to the next draw. These controls expose existing
provenance without retiring old claims or changing canonical human decisions.

Machine agreement does not create a human-confirmed observation, approve semantic
changes, or fill unreviewed dimensions. All agreeing `supported` results produce
agent-reviewed status; any disagreement between independent audit outcomes routes
the original claim to expert review. The semantic `expert-queue` export contains
only current `needs-expert` rows; delivery-only spot-check requests appear
separately in the service inbox. Awaiting audits and revision work remain with
agents. Saved human dispositions take precedence; a deferred claim remains
unsettled in its history even though it is no longer an open queue row.

The human sees the section's five style assessments together as adjacent horizontal
sliders: **Absent**, **Supporting**, and **Prominent**. Unreviewed and unresolved
remain explicit separate states; missing historical dimensions are not initialized
as absent. The original scope and playback rate stay visible, and per-tag evidence
and rationale remain available below the sliders. Selecting a tag changes the
focused evidence without replacing the other drafts or moving the viewport.

**Golden set** in the connected Review inbox opens the current High-confidence
human references selected by the [agent regression gate](../../annotation/evaluation/README.md).
**Check golden set** beside the section sliders opens the same view in a new tab,
filtered to the active label, while the original section draft stays in place.
Filter by label, strength, or chart to compare exact source previews, judgment
rates, saved human comments, and Foundation criteria. Only protected labels are
shown; a missing dimension is not an absence judgment.

The view calls the gate's existing selector, so equal duplicate cells retain their
human identities and conflicting High judgments block the set. It refreshes on
returning to the tab or with **Refresh golden set**, and follows current human
revisions rather than historical High records. Browsing is read-only; it does not
freeze a comparison suite, approve a gate run, or save a human judgment.

**Submit section review** saves the displayed section assessments in one atomic
command. Unchanged original proposals are accepted; edited proposals create modified
decisions. Previously settled, unchanged judgments are retained, and missing
dimensions receive direct human observations after explicit assessment. All proposal
dimensions must be settled before confirmation. New direct annotation uses
**Save section judgments**; it can retain explicitly unresolved assessments and
leave untouched dimensions unreviewed. Reopening a saved section loads its sibling
judgments together. **Save revised section** appends direct revisions with an
individual supersession link for each changed dimension.

Grouping retains the handoff and playback rate as well as section identity (or exact
original scope for legacy claims without section IDs), so repeated model runs do not
become one proposal. The service checks every submitted decision before one write;
an invalid or stale command cannot partially save a section. Sliders remain editable
while that section saves, duplicate submission is blocked, and newer edits or failed
drafts remain available. A completed save does not silently replace newer edits.

Human decision notes and human-claim rationales are optional. Changing an
assessment clears its inherited rationale rather than presenting the old explanation
as support for a new judgment. Agent proposals and audits still require reasoning.
Saved versions remain in history. Acceptance or modification creates human-provenance
observations; rejection is not `absent`, and deferral does not license a guessed
label. The existing single-claim command remains available to current consumers,
but the human section interface submits the assessments together. Original proposals, independent
audits, self-checks, questions, and human decisions remain separate records. Agents
read the inbox and network `dispositions` rather than infer decisions from UI state.
Structured human feedback is authoritative; consuming it does not require a
second confirmation of the same decision. If subsequent agent work changes the
judgment or scope, create a new immutable proposal and independent audit, escalating
only actual remaining doubt.

Opening a frozen task in a different workspace retains its old base; it does not
transfer canonical history. Continue against the original persistent workspace.
Use `fetch-task --fresh` when creating new proposals under current approved context,
while retaining old tasks, packets, and decisions unchanged. Human edits alone do
not require new agent proposals.

Role guides: [labeler](../../annotation/roles/labeler.md), [auditor](../../annotation/roles/auditor.md), and
[curator](../../annotation/roles/curator.md). The curator handles proposed semantic revisions
outside routine labeling and auditing. It does not automatically rewrite a pinned
Foundation or make community targets part of the section vocabulary.
