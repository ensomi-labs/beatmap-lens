# Beatmap Lens engineering guide

## Owners

- `packages/beatmap-lens/` is the independently published npm toolkit. Keep its APIs
  DOM-free and separate from campaign policy, local storage, and ensomi runtimes.
- `apps/inspector/` owns the human inspection and review experience, including its
  local service. Follow `apps/inspector/DESIGN.md` for interface changes.
- `harness/` exposes read-only source evidence and human examples to workers.
- `annotation/` owns discovery, selection, annotation, independent audit, delivery,
  learning, and evaluation. Whole-chart discovery and selected-section annotation
  have different coverage claims.
- `.agents/skills/` contains maintained agent guidance. Use `agent-notes` for lasting
  working decisions; use `mania-pattern-judgment` for annotation and calibration.

Directory organization does not create another published package. The toolkit and
Inspector may develop toward intelligent mapper assistance independently of the
annotation research workflow.

## Implementation

- Treat valid `.osu` files as baseline input. Design for malformed or unsupported
  input only when requested or supported by actual evidence.
- Prefer direct data flow, small focused functions, clear names, and minimal state.
  Avoid speculative fallbacks, validation layers, abstractions, and invalid-input tests.
- Keep package support at 4K-10K; Inspector prioritizes 4K-7K. Annotation workflows
  document their actual supported key counts separately.
- Keep one implementation of source identity, judgment contracts, and human review
  transitions. Application adapters may consume it without adding a public API.
- Paired ensomi development is supported. Configure repository, dataset, and
  runtime paths explicitly rather than assuming one machine's layout.
- Manage Python tooling with the root `pyproject.toml` and `uv.lock`. Use
  `uv sync --locked` and `uv run --locked python`; keep the project `.venv` local.
  ensomi audio extraction retains its separately configured runtime.
- Breaking repository changes are allowed. Do not add old-path wrappers or preserve
  obsolete controller behavior without a current consumer requirement.
- Preserve real human records and their meanings. Repository cleanup is not authority
  to change Foundation definitions, judgment guidance, or expert assessments.

## Documentation and research

Write project documentation in English. Put reusable operating instructions in
`docs/annotation/`, self-contained research conclusions in `docs/research/`, and
design decisions in `docs/decisions/`. Job roles belong with annotation code.

Public material may include compact source-linked findings such as beatmap identity,
section, and judgment. Explain the reason for a skill iteration and the evidence
needed to assess it; full research histories and historical run reproduction are
not required. Keep required facts in the public document instead of depending on
an unavailable local report. Local input/output path examples are valid.

Use `.local/` for local data, workspaces, runs, caches, and notes. Distinguish valuable
human review records from disposable outputs before cleanup. Do not copy private
corpora or raw logs into public documentation.

## Verification

Run checks for the changed behavior and complete the repository check before the
final milestone. Deterministic tests verify tools and workflow contracts; skill
length checks do not verify annotation quality.

Judgment-affecting skill, role, prompt, or evidence-tool updates must satisfy the
annotation regression gate: automatically collect current High-confidence human
labels from the canonical workspace, freeze one gold suite for both sides, and
keep every selected cell correct across repeated candidate runs. Missing or stale
gold/evidence is not a pass. Do not change human confidence, gold, or its baseline
merely to make a candidate pass.

Verify the actual human Review page after service or workflow migration. Describe
the tested scope and any untested semantic coverage precisely.

## Facts shared with other Ensomi repositories

Some facts this repository states are defined in another Ensomi repository, and
some defined here are stated elsewhere: the released model's files, revision and
licence, versions and pins, protocol messages, generation rules. ensomi-model's
[`docs/ecosystem.md`](https://github.com/ensomi-labs/ensomi-model/blob/main/docs/ecosystem.md)
says where each kind is defined and what a change affects in the other
repositories.
Before such a change, follow ensomi-model's
[`ensomi-cross-repo-changes`](https://github.com/ensomi-labs/ensomi-model/blob/main/.agents/skills/ensomi-cross-repo-changes/SKILL.md)
skill.
