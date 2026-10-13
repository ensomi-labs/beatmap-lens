# Contributing

beatmap-lens reads osu!mania charts the way mappers do, and mappers are the
authority on whether it does. Its dataset, code and
[research conclusions](docs/README.md#research) are open, so that anyone can
use what mappers' readings teach and correct it. What mappers, players and
developers tell us decides what the tools and the dataset improve next and
what we choose to build. Most contributions need no code; short or general
feedback is welcome, in English, Japanese or Chinese.

## Without code

- **Feedback on the tools.** For the Inspector, the chart renderer, the npm
  package or the annotation tools, whether you map, play or develop: a bug,
  something that gets in the way, or a tool you wish existed. Open a
  [tooling feedback report](https://github.com/ensomi-labs/beatmap-lens/issues/new?template=tooling-feedback.yml);
  for a bug, attach the `.osu` file renamed to `.txt`, because GitHub does not
  accept `.osu` attachments.
- **Feedback on the published dataset.** When a pattern label in the
  [dataset](https://huggingface.co/datasets/sed-i/mania-pattern-annotations) or
  in the Inspector does not match how you read the section, a Foundation
  concept reads wrong to you, or the dataset has another problem, open a
  [dataset feedback report](https://github.com/ensomi-labs/beatmap-lens/issues/new?template=dataset-feedback.yml).
  A reading you give is kept as your own judgment, credited to you. It never
  overwrites an existing human record; where readings differ, both stay visible.
- **You would like to annotate.** Mappers who want to label sections in the
  Inspector are welcome. Say so in
  [Discussions](https://github.com/orgs/ensomi-labs/discussions) and we will
  help you set up.
- **Ideas and questions** about what ensomi should become go to Discussions,
  where others can add to them and upvote them.

Reports are public. Dataset feedback is published as an open dataset under
CC BY 4.0, credited by the name each reporter gives. Never attach audio:
songs are copyrighted.

## Code

Describe the real beatmap or development workflow a change serves. Keep changes
focused, preserve the distinction between observed structure and semantic judgment,
and avoid abstractions for hypothetical consumers.

### Product and research boundaries

`packages/beatmap-lens` is the independent npm package. Keep its API curated,
DOM-free, and free of implicit filesystem or network access. Parsing, normalized
charts, analysis, render scenes, and serialization have separate responsibilities.
Key count is chart data: every package stage supports 4K–10K through the same API.
The [package README](packages/beatmap-lens/README.md) owns public API documentation.

The Inspector's current priority is 4K–7K. File handling, media playback, human
review, and the local service belong in `apps/inspector`. Use its
[design guide](apps/inspector/DESIGN.md) for frontend changes. Share scene projection
with the package; keep visual scroll speed separate from audio playback rate.
Intelligent assistance for mappers is a product direction, not a claim that an
editing assistant already exists.

Annotation development combines whole-chart discovery with selected-section
judgments. Put production orchestration in `annotation/pipeline`, deterministic
inspection in `harness`, evaluation in `annotation/evaluation`, and natural-chart
learning in `annotation/learning`. Snapshot publication belongs in
`annotation/release`. Worker instructions live in `annotation/roles`;
repository skills live in `.agents/skills`. `scripts/` is for repository maintenance.
Do not narrow the package's support range to match an annotation campaign.

Paired ensomi development is supported. Pass dataset, checkout, and runtime
locations through the supported configuration or CLI options. Keep ensomi
model execution and training code in that repository. Do not introduce format
adapters without a concrete consumer need.

### Changes and documentation

- Treat valid `.osu` files as the baseline. Add malformed-input handling only for
  an explicit requirement or demonstrated problem.
- Prefer direct data flow, small focused functions, and minimal state.
- Test the supported behavior and meaningful boundary that changed. Performance
  complexity needs measured evidence.
- Keep public documentation in English and self-contained. Put reusable operation
  guides in `docs/annotation`, research findings and limitations in `docs/research`,
  and durable design choices in `docs/decisions`.
- Local datasets, generated runs, and unfinished research notes belong outside
  version control. The [agent-notes skill](.agents/skills/agent-notes/SKILL.md)
  supports local working records; it is not required for every edit.
- Publish useful research conclusions that explain skill iteration. Private run
  links and complete historical execution records are not required public evidence.
- A package behavior change needs a Changeset describing its effect, including a
  breaking change when applicable. Documentation and repository maintenance need
  no Changeset unless they alter the published package. Directory migrations do
  not require old command aliases or compatibility shims.

Do not change approved Foundation semantics or reinterpret a human annotation as
part of directory cleanup, tooling maintenance, or an agent-only conclusion.
Keep the label and its human authority separate from a proposed explanation.

### Verification

`pnpm check` verifies engineering behavior and packaging. Run
`pnpm check:regression` separately for judgment-affecting method changes; its
evidence requirements and reported missing replay remain intact. Engineering
success does not certify a method. The [dataset publication pipeline](docs/annotation/dataset-publication.md)
checks a frozen snapshot under its declared admission policy; an optional machine
method's missing evaluation does not block a valid human-only dataset.

Python dependencies live in the root `pyproject.toml` and `uv.lock`; `.python-version`
selects Python 3.10. Run `uv sync --locked` to prepare `.venv`, and use
`uv run --locked python SCRIPT` for Python tools. Update the project dependency
specification and lockfile together when changing dependencies. ensomi audio
keeps its separate runtime, configurable through `ENSOMI_PYTHON`.

Run the checks relevant to the changed behavior, then the repository check before
merging:

```sh
pnpm check
```

This includes source checks, types, tests, builds, and package validation. The
[annotation regression gate](annotation/evaluation/README.md) separately governs
changes to judgment instructions, roles, and harness behavior. Critical previous
cases must remain correct; broader cases require repeated comparison and explicit
review of regressions. Passing code tests or a shorter skill does not establish
better agent judgment.

## License

Contributions must be compatible with the MIT License.
