# Publish an annotation dataset snapshot

The publication pipeline reads the V2 Review workspace and produces a compact
Hugging Face dataset. It uses the existing human revision rules. It does not run
annotation agents, change golden judgments, or require the Review server to stop.
See the [format decision](../decisions/0008-dataset-snapshot-publication.md).

## Prepare the local inputs

Run from the repository with its locked Python environment and installed Node
dependencies. Hugging Face authentication uses the normal local `hf auth login`
credentials; do not put access tokens in release configuration or source control.

```sh
uv sync --locked
pnpm dataset:release collect \
  --workspace .local/corpus-500-v2/workspace \
  --out .local/release-work/release-input.json
pnpm dataset:release init \
  --input .local/release-work/release-input.json \
  --out .local/release-work/config
```

Collection validates exact source bytes through the existing workflow domain,
extracts effective human observations, and resolves auxiliary human evidence
against the whole frozen workspace. A concurrent canonical edit makes collection
fail; collect again after the edit. The internal input includes public Foundation
projections and dependency metadata. Only the final snapshot directory is uploaded.
For large workspaces, add `collect --workers 4` to validate source documents in
parallel. Output ordering and whole-workspace consistency checks stay identical
to the default single-worker collection.

`init` creates `release.json` with the project defaults (`sed-i/mania-pattern-annotations`,
MIT, human-only), explicit missing artifact commits, and official source locators.
It writes each
public Foundation JSON under `foundations/`. These artifacts retain definitions,
policies, and calibration judgments, but replace embedded chart bytes with hashes.
Publish the chosen artifacts in GitHub, then fill their exact commit/path/hash
references. The original frozen Foundation hash and public artifact hash differ.

Fill the release configuration with:

- `repo_id`, title, release ID, and the dataset license.
- `exporter`: the public GitHub commit, entrypoint path and file SHA-256 containing
  the implementation being used. A dirty checkout is not an immutable code version.
- `sources`: each selected original source SHA-256 and its public external locator,
  including the calibration sources needed by selected Foundations.
- `foundations`: public artifact references for the selected frozen Foundation hashes.
- `policy.agent_methods`: optional exact method IDs from the collected inventory.
  The default empty list publishes only human judgments.
- `policy.agent_handoff_ids`: optional exact handoff allowlist for a particular
  campaign. Other handoffs, including other runs of the same method, are excluded
  as `handoff-not-selected`. Omission keeps method-wide selection; an empty list
  admits no machine rows. Human records and their ancestry are not filtered by it.
- `release_notes`: optional Markdown describing this release's scope, model and
  method references, limitations, and acknowledgments. The text is retained in
  the manifest and Dataset Card, outside its generated configuration metadata.
- `policy.human_precedence`: new configurations set this to `true`. An effective
  human assessment at the exact same source hash, start, end, tag and playback
  rate excludes an otherwise eligible machine row, even on a different handoff.
  Unresolved and unreviewed human assessments also mask machine supervision.
  This is a publication filter; it does not delete historical machine proposals
  or change human records. Historical configurations without this field retain
  their original overlap behavior.
- `policy.excluded_sources`: optional source SHA-256 to reason mapping, for example
  when the annotated historical bytes are no longer publicly retrievable. It
  excludes those judgments from this snapshot and records their counts and reasons;
  it never changes workspace gold. A required Foundation calibration source cannot
  be excluded from its definition's dependencies.

An HF source reference has this shape (values shown are placeholders):

```json
{
  "kind": "hf",
  "repository": "organization/source-corpus",
  "commit": "<full-HF-commit>",
  "path": "data/sources.parquet",
  "record_key": "<source-record-key>",
  "uri": null
}
```

Set `record_key` to null for a file whose entire bytes are the original `.osu`.
Alternatively use `kind: "content-addressed"` and an HTTPS `uri` containing the exact
source SHA-256; other locator fields are null. For a chart with a public beatmap ID,
`init` uses `kind: "osu"`, `uri: "https://osu.ppy.sh/osu/<beatmap-id>"`, and null
values for the other locator fields. This official URL can change: identity is the
original `source_sha256`, and publication downloads and checks those exact bytes.
Consumers must do the same. A missing file or hash mismatch means the annotated
version is unavailable, and never authorizes attaching labels to another version.
An external mirror that retains the exact bytes can use `kind: "url"` and its
HTTPS `uri` (other locator fields null). This also requires byte-for-byte SHA-256
verification; neither a mirror's beatmap ID nor a normalized-chart match suffices.
No chart bytes, normalized notes, audio, or images are added to the publication.
The MIT license covers the annotations; it does not relicense linked beatmaps.

Agent methods preserve the recorded labeler/auditor identities, independent of
worker IDs. Declare immutable skill, role, and harness artifacts for complete
provenance. Unknown historical artifacts remain partial: only an explicit
`allow_partial_method_provenance` policy admits them. The separately declared
`auxiliary_evidence` policy selects which of `current`, `changed`, and `untracked`
are allowed for agent rows. Human judgments are independent of these machine gates.
These fields describe provenance and admission, not measured annotation accuracy.

## Build and check the snapshot

```sh
pnpm dataset:release build \
  --input .local/release-work/release-input.json \
  --config .local/release-work/config/release.json \
  --out .local/releases/2026-09-09.1
pnpm dataset:release validate .local/releases/2026-09-09.1
```

The output directory must be new. The builder writes typed Zstandard Parquet,
generates the Dataset Card with `human` as the default configuration, includes the
MIT `LICENSE` notice, and records
file hashes, row counts, registries, exclusions, and policy in `manifest.json`.
Source/Foundation incompatibility is reported as an exclusion. Explicit unresolved
or unreviewed assessments remain masked values; missing rows never become absent.
Agent proposals that were modified, rejected, superseded, or lack an independent
supporting audit are excluded from the agent subset.

Validation checks schemas, hashes, counts, identifiers, ranges, assessments,
references, and the exact file inventory. Unexpected files and symbolic links
fail validation. It does not claim semantic accuracy or execute a model evaluation.
New snapshots use manifest version 4 and `judgment-v4`, including a required
`playback_rate`, a derived `cell_id`, nullable `human_confidence`, and nullable
observation/evidence-review metadata.
Historical version 1, 2 and 3 Arrow schemas remain readable without rewriting their
files; version 1 implicitly uses 1×. Missing historical review metadata stays
unknown. All source
coordinates stay in original milliseconds; see [playback rates](playback-rate.md).
Contradictory supervised human judgments for the exact same source/scope/tag/rate block
release; different overlapping scopes remain distinguishable. Empty configurations
can be inspected locally but cannot be published: deselect empty agent methods,
and include at least one effective human judgment in the default configuration.

For a later release, download the previous snapshot at a fixed HF commit, pass
`build --previous PATH`, and set `previous_snapshot` to its `repo_id` and `commit`.
The pipeline retains explicit revision lineage and requires reasons for removed
records not superseded by a replacement. Remote publication also checks that this
predecessor is still the destination's current commit.

## Preview and publish

```sh
pnpm dataset:release plan .local/releases/2026-09-09.1
pnpm dataset:release publish .local/releases/2026-09-09.1 \
  --receipt .local/release-work/published.json
```

`plan` is read-only. It verifies public GitHub artifact bytes and source locators,
then lists added/replaced/deleted snapshot files. Standalone source files are
downloaded and hash-checked; corpus shard references are checked for public file
availability at the pinned commit, without downloading and decoding whole shards.
The report distinguishes these checks. Consumers must still verify the original
source byte hash when resolving a corpus row.

`publish` repeats validation and reference checks, copies the exact file inventory
into private temporary staging, and sends one HF commit guarded by the observed
parent commit. Old files are removed only when owned by the preceding manifest.
Unmanaged remote files stop publication. A retry after a successful commit returns
the existing commit identity when the same snapshot is already present.

For the first release into a new repository, add `--create-repo`; new repositories
are private unless `--public` is also supplied. This flag never changes visibility
of an existing repository. The receipt stays outside the immutable snapshot and
contains the full HF commit and citation URL. The code and Foundation GitHub
commits are independent of this HF dataset commit. No version tag is moved. Every release remains accessible at its full HF commit;
a version tag may be added to that commit without modifying the snapshot.
The manifest includes digests of the actual collector/exporter implementation
files; publication verifies those files at the declared GitHub commit as well as
the entrypoint. A previous local snapshot is bound to its HF predecessor through
the previous manifest's checksum.

```python
from datasets import load_dataset

human = load_dataset("sed-i/mania-pattern-annotations", "human", revision="<HF-commit>", split="full")
supervision = human.filter(lambda row: row["presence"] in ("present", "absent"))
```

Install `datasets` in the consumer's own environment. The `full` split is an
annotation resource, not an advertised held-out benchmark. Agent configurations
are opt-in and must not be silently unioned with human judgments as independent gold.
When constructing training examples, deduplicate agreeing human observations on
the exact source/scope/tag/rate key so independent provenance records do not add
duplicate training weight. Preserve the original records for traceability. Use
the human precedence policy when adding machine supervision; missing or masked
human values do not become machine-provided negatives. Different scopes and rates
remain distinct judgments.

## Evidence provenance and research use

A human row records the final human assessment and its attached source-backed
notes. Human authority over the label does not imply that a person independently
selected, minimized, or specifically reviewed those notes. Independent machine
audit likewise does not certify a note-level human gold set or minimal/sufficient
evidence. An inherited explanation can remain attached to a changed assessment;
an empty human explanation also does not invalidate the label.

Version 3 introduced these evidence distinctions; version 4 also records human
label confidence independently of evidence review and expression strength:

| Field | Meaning and limits |
| --- | --- |
| `record_id`, `observation_id`, `observation_sha256` | The immutable record and, when available, canonical human observation hash bind the current assessment and notes. The hash is null for machines and when unavailable. A new human revision receives a new identity; adding explicit review declarations to an existing identity is forbidden. |
| `human_confidence` | Version 4: `high` or `low` as saved with the human observation; null for historical omissions and machine records. It describes certainty in the label, not style strength, exemplar representativeness or note-selection quality. Only explicit High human labels are eligible for the automatic method regression suite. |
| `details.proposal_changes` | Claim fields differing from the original `handoff_id`/`claim_id`. Sets compare exact source note tuples, ignoring order. `[]` means unchanged; null means no comparison was supplied. Changes are factual lineage, not judgments about explanation correctness. |
| `details.human_revision` | The immediately preceding human observation's ID/hash and `changed_fields`, for both direct revisions and successive decisions on one proposal. This separates the latest revision from cumulative changes against an original machine proposal. Null means no preceding human observation was supplied. |
| `details.evidence_review.selection_origin` | The recorded starting point: inherited agent/human selection, a new human claim, copied section, or unknown. Source handoff/observation/claim pointers identify that starting point when recorded. |
| `details.evidence_review.operations` | Saved draft operations distinguish `auto-scope-fill`, `explicit-scope-selection`, `manual-note-edit`, and `range-filter`, with witness/context/both targets. The list is not a full per-note action history. |
| `details.evidence_review.selection_reviewed` | Nullable legacy declaration, retained only when recorded. Current saves do not require or manufacture it. |
| `details.evidence_review.rationale_reviewed` | Nullable legacy declaration about an explanation, retained only when recorded. No separate explanation review is required. |
| `cell_id` | A deterministic identity for the exact source/scope/tag/rate tuple, independent of record, method, and authority. It groups duplicates without deleting record identities or assigning a universal weight. |

The entire `evidence_review` field is null for older untracked records. No importer
infers past UI operations or human intent from the resulting note-set shape.
`proposal_changes` containing `assessment` but neither `witnesses` nor `rationale`
makes a label revision with inherited notes/explanation visible without revoking
that human label or requiring a post-hoc explanation. Agents select notes while
making their judgment. A later agent annotation retains its own authority and
does not rewrite a historical human observation. The common claim comparison covers `tag_id`, `assessment`, `scope`,
`playback_rate`, `review_context`, `witnesses`, `context_notes`, `rationale`,
`section_id`, `boundary_uncertainty`, `transition`, and `exemplar_role`. Identity
and evidence-review declarations are metadata, so changing only those declarations
has empty `changed_fields`; the observation IDs/hashes still change. Version 4
adds `confidence` to `human_revision.changed_fields` for confidence changes. It
never adds confidence to `proposal_changes`, because machine claims carry no
human confidence. If A→B changes a label
and B→C only edits notes, C's `human_revision.changed_fields` lists `witnesses`,
while its comparison against the original proposal can still include `assessment`.
The superseded records remain addressable through lineage; the current table
contains only effective observations and does not copy private journal bodies.

Version 1/2 predecessors can acquire derived grouping/comparison/hash
columns in a later snapshot while their original claims remain identical; this
does not grant missing human review declarations. A version 3/4 record cannot change
its existing review metadata or identity binding under the same record ID. Version
4 can represent an unchanged version 3 record with null confidence; assigning a
confidence requires a new human observation rather than changing that record.

See [human confidence](human-confidence.md) for editing and current-gold selection.

`auxiliary_evidence_status` answers whether the referenced human exemplars still
match their recorded source/observation hashes and Foundation. It does **not**
answer whether this row's rationale explains its current label. Keep dependency
freshness, label authority, selection origin, and explanation content separate.
The legacy review declarations describe only what was recorded; they are not
required stages of annotation.

The section delivery packager constructs `contextNoteRefs` from every note in the
supplied review context except witnesses. That operation is automatic; it is not
an agent's active negative-note selection. Unselected notes are not semantic
negatives, and existing records provide no per-note reason for their omission.
Full-section selections, partial chords, disconnected sets, and notes crossing
section boundaries are allowed. A strict subset, including one that only omits
entering long notes, is not proof of deliberate fine selection. Do not convert
coverage thresholds into salience or evidence-quality labels.

Research eligibility depends on the question:

- Section-label learning can retain final human labels while masking unresolved or
  unreviewed assessments, including labels with inherited or empty explanations.
  Select authority/method layers first and weight agreeing exact cells
  once. Resolve contradictions among selected machine methods explicitly.
- Selection research must preserve the recorded origin of each set and
  keep the complete section and review context available, including unselected
  intervening rows and original start/end times of crossing long notes. Explicit
  review alone does not establish necessity or sufficiency. Existing selections
  do not supply reasons for individual omissions, and agents are not required to
  generate those reasons.
- Salience prediction must exclude evidence rationale, human decision comments,
  and audit explanations from model inputs because they can disclose the target.
  Group related rates, overlapping sections, and source versions during splitting.
  Preserve all manifest `human_evidence_refs` edges, including unpublished
  references with null `record_id`; their exact source and observation hashes are
  still dependency identities and potential leakage paths.

These are use restrictions and provenance distinctions, not retroactive changes
to the Foundation or frozen labels. The published v0.2.0 files remain unchanged.

## Published snapshots

### v3: human confidence and the latest audited Astra campaign

[v3](https://huggingface.co/datasets/sed-i/mania-pattern-annotations/tree/b22a7a443783e05fee4db4b1d22b8e573ad448ae) was published on 2026-09-12 under MIT at HF commit
`b22a7a443783e05fee4db4b1d22b8e573ad448ae`; the `v3` tag resolves to that commit. GitHub was synchronized
and its 24 preparation files were publicly downloaded and hash-verified before HF
publication. The exporter and [frozen method package](https://github.com/ensomi-labs/beatmap-lens/tree/647009ab60ed69d98190712a6ab025807cca07b8/annotation/methods/astra-1000-20260912) are pinned to
GitHub commit `647009ab60ed69d98190712a6ab025807cca07b8`.

| Layer | Records | Annotated charts |
| --- | ---: | ---: |
| Default `human` | 592 | 192 |
| Opt-in latest Astra method | 4,403 | 477 |

Together the layers cover 545 annotated charts. The human layer contains
300 present and 292 absent records across 590 exact cells.
Explicit confidence is preserved (171 High, 22 Low,
399 unspecified). Publication schema v4 also retains observation hashes,
human revision lineage and source-linked evidence metadata.

The machine layer selects exact handoffs from the 2026-09-12 campaign of
1,000 sections on 500 charts. `method-5ebd91cd0db19242f14bf5d4fc96b328c792b185ec4ab2bc785ca2e13a4d056c` records labeler model
`gpt-6-astra` with requested medium reasoning and a separate `gpt-6-astra`
auditor with requested high reasoning; CLI `codex-cli 0.154.0-alpha.6.2`.
The frozen package records skill manifest SHA-256
`bf56212bc04c99b4bcc5736917285680f0fba756864bd8222c8a22ca3a186299`,
harness source commit `eb233598c6d0fcf5e9931416948d105f23ca8a71`, complete
roles/prompts, and all eight evidence-tool hashes. Per-record identities bind
handoffs, independent audits, and auxiliary human evidence. The selected machine
records cover 954 source sections, with per-tag admission rather than a claim
that all 1,000 sections are fully settled. Other batches, older machine methods,
Luna shadows, unsupported judgments and exact human cells are excluded.

All 545 published source references were downloaded and checked against their
original SHA-256, alongside 106 public artifact references. There are
23 explicitly excluded historical source identities: the previous six and
17 additional charts whose original bytes were unavailable from official and
three checked mirror URLs. Their canonical labels are unchanged. The eight
previously deferred human records remain outside the release.

Relative to v2.1, 399 human record identities are retained and
193 effective identities are added; 68 earlier human identities have
explicit revision/removal lineage. The old machine tables are omitted under the
new campaign-selection policy, with individual removal reasons and full historical
access at v2.1. All prior version tags are unchanged.

The complete repository check passed 515 TypeScript and 342 Python tests,
source/skill checks, types, builds, package checks and corpus smokes. Candidate
checks reproduced exact campaign admission and preserved canonical label fields,
confidence and observation identities. Anonymous download of all six snapshot
files matched the local candidate and passed snapshot validation. The manifest
SHA-256 is `92ecf080737ec2e38a2508b0730a672e09edd45d48f46a2d5777cbb70cefcbcf`.

The method's bounded development score is 21/24 across eight cells and three
fresh labeler repeats. Full-suite and auditor semantic accuracy were not
established. Repeated development on those cells is not held-out evaluation;
independent same-model audit does not eliminate correlated errors. No population
accuracy claim is made. The Dataset Card includes: "Thanks to LuckyCosine7042 for
moral support."

### v2.1: human revisions and dependency freshness

[v2.1](https://huggingface.co/datasets/sed-i/mania-pattern-annotations/tree/d717909f764b05dd63d13caec1748585029d8ab5)
was published on 2026-09-10 with 467 human records and 2,398 machine records
(2,368 initial and 30 repair), spanning 332 annotated charts and 336 source
references. It incorporated six explicit human revisions and excluded 21 machine
rows with changed human-exemplar dependencies. Its schema-v3 snapshot and earlier
tags remain immutable.


### v0.2.0: frozen expansion with separate machine layers

[v0.2.0](https://huggingface.co/datasets/sed-i/mania-pattern-annotations/tree/a8ee5391b5f9dd68e9b2fb478674a46f354c7375) was published on 2026-09-10 under MIT at HF commit
`a8ee5391b5f9dd68e9b2fb478674a46f354c7375`; the `v0.2.0` tag resolves to that
commit. The exporter and public
[frozen method bundle](https://github.com/ensomi-labs/beatmap-lens/tree/d0427e9aa3efb79c421964f99883b0d285743772/annotation/methods/scale-500-20260910)
are pinned to GitHub commit `d0427e9aa3efb79c421964f99883b0d285743772`.
The skill and Foundation semantics remain unchanged.

| Layer | Records | Annotated charts |
| --- | ---: | ---: |
| Default `human` | 467 | 168 |
| Initial method `a444f6f5…` | 2,388 | 179 |
| Repair method `46fb9e0f…` | 31 | 25 |
| Both opt-in machine methods | 2,419 | 179 |

The full method IDs and loadable configuration names are in the Dataset Card and
manifest. The human layer contains 243 present and 224 absent observations,
covering 466 distinct source/scope/tag/rate cells. One agreeing pair retains two
observation identities; deduplicate its training weight. All 156 v0.1.0 records
are preserved unchanged after normalizing their implicit 1× rate. Of 311 added
human records, 80 come from the expansion's final review and 231 from earlier
unpublished human accumulation. See the
[review findings](../research/annotation-scale.md#expert-review-and-method-freeze).

The 2,419 machine cells are distinct and have complete method provenance,
current auxiliary evidence and independent supporting audit. The explicit
human-precedence policy excludes 62 otherwise eligible machine rows, including
a supported repair on another handoff that conflicts with an effective human
Trill judgment. No machine label overrides human uncertainty or supplies an
extra human-gold observation. Historical partial methods remain provenance of
some human records; they are not selected machine datasets.

Together the layers cover 332 annotated charts. All 336 source references,
including calibration dependencies, were downloaded and checked against their
original SHA-256: 335 official osu! files and one exact-byte mirror. The publisher
also verified 116 public artifact references before its guarded HF commit.
The seven snapshot files total 5,044,135 bytes, with manifest SHA-256
`d662dc74f6171518707f83186521f57786910569ffaa62fbb0dc568eaac336c3`.
All seven files were downloaded anonymously at the published commit, found
byte-identical to the candidate, and passed snapshot validation. The old
`v0.1.0` tag and its contents remain unchanged.

All judgments in this release use 1×; the separate playback-rate experiment is
not included. Eight human judgments on the same six unavailable historical
source versions remain deferred. The expansion's single fixed-boundary LN cell
also remains excluded; no crop or canonical judgment was changed to admit it.
The complete repository check passed 493 TypeScript and 290 Python tests,
builds, package checks and corpus smokes. These checks and the selected expert
review do not establish population annotation accuracy.

### v0.1.0: first human release

The first human-only release is
[v0.1.0](https://huggingface.co/datasets/sed-i/mania-pattern-annotations/tree/892845970a21861b51d7f2c6797ae2cf5784e729),
published on 2026-09-09 under MIT. Its immutable HF commit is
`892845970a21861b51d7f2c6797ae2cf5784e729`; the `v0.1.0` tag resolves to that commit.
The exporter and public Foundation are pinned to GitHub commit
`ee8db26b8a22b7a6ec89ea5b2b3a777b1a722667`.

It contains 156 human judgments (89 present, 67 explicitly absent) across 117
charts, with 121 source rows including all five required calibration sources.
Every included source reference was downloaded and verified against its original
SHA-256 before publication: 120 official osu! downloads and one osu.direct mirror.
The five published files total 328,104 bytes, including metadata and MIT notice.

Eight judgments on six historical source versions are deferred because none of
the checked public downloads matched the annotated bytes. Their source hashes and
reasons are recorded in the manifest, and the original workspace judgments remain
unchanged. No machine judgment table is included in this release.
