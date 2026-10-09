# Documentation

The [package README](../packages/beatmap-lens/README.md) owns the npm API. The
[Inspector design guide](../apps/inspector/DESIGN.md) owns its visual and interaction
conventions. This directory explains reusable annotation work, research conclusions,
and design choices.

## Inspector

- [Inspector guide](../apps/inspector/README.md): running Inspector, its workspaces,
  and judging two charts in Compare.
- [Model comparison packets](inspector/model-comparison.md): the manifest and verdict
  format for blind two-model listening, how excerpts are proposed, and the limits of
  the energy strip.

## Annotation

- [Discovery and section annotation](annotation/corpus-annotation.md): the main
  workflow and production entry points.
- [Agent–human review](annotation/agent-workflow.md): claims, independent audits,
  delivery, and human decisions.
- [Harness](annotation/annotation-harness.md): inspectable source facts and human
  examples, rendering, and evaluation exclusions.
- [Section selection](annotation/annotation-selection.md): coverage, repair targets,
  exploration, and the limits of ranking heuristics.
- [Fine annotation](annotation/fine-annotation.md): bounded section jobs and batches.
- [Playback rates](annotation/playback-rate.md): rate-specific judgments, agent
  evidence, human Review, and source-time coordinates.
- [Natural-chart learning](annotation/beatmap-learning.md): explore arrangements and
  revise interpretations without creating human labels.
- [Regression gate](../annotation/evaluation/README.md): checks for candidate skill
  and workflow updates.
- [Dataset publication](annotation/dataset-publication.md): collect, configure,
  build, validate, preview, and publish compact Hugging Face snapshots.

Worker prompts live in [annotation/roles](../annotation/roles/), and reading guidance
lives in the [judgment skill](../.agents/skills/mania-pattern-judgment/SKILL.md).

## Research

- [Reading beatmap organization](research/beatmap-reading-framework.md): conclusions,
  counterexamples, and unresolved distinctions behind the reading workflow.
- [Annotation performance](research/annotation-performance.md): measured resource
  behavior and its limits.
- [Annotation context control](research/annotation-context-control.md): observed
  worker isolation, repeated inputs, and the missing comparison of judgment quality.
- [Scaling section annotation](research/annotation-scale.md): coverage, independent
  audit outcomes, and limitations of the 500-section expansion.
- [Annotation balance](research/annotation-balance.md): human-supervision gaps,
  difficulty coverage, and section-boundary selection biases.
- [Style across playback rates](research/rate-style-response.md): fixed-section
  experiment results and the distinction between intended and constrained execution.

Research documents should explain the question, finding, and limitation on their
own. Small source/section/tag finding tables are useful when they clarify a result.
Raw charts, intermediate runs, campaign status, and working notes may remain local;
public documentation does not promise to reconstruct every historical experiment.
The current published snapshot is
[mania-pattern-annotations v4](https://huggingface.co/datasets/sed-i/mania-pattern-annotations/tree/102d63c485b38e7fb23af3eca64198dc607d3b6c):
2,860 complete five-dimension sections, 600 human records and 16,402 independently
audited machine judgments. Human labels and opt-in machine methods remain separate,
with exact human precedence and all v3 records preserved. Original source metadata
and hashes remain published when retrieval is unavailable; consumers must verify
original chart bytes before using the labels. The
[publication record](annotation/dataset-publication.md#published-snapshots) includes
immutable version identities, method provenance, retrieval observations and limits.

## Decisions

[Design decisions](decisions/) preserve accepted or proposed choices and their
consequences. Their status and date matter: a past proposal does not become current
semantic authority merely because it is documented. Completed execution logs do
not belong in a design specification.
