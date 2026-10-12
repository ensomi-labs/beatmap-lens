---
"beatmap-lens": minor
---

Draw long notes ending `theme.tailShortenMs` before their end time, never before their start, as shortened-tail skins do. The default `renderDefaults.scene.tailShortenMs` is 10 ms, so default scenes, documents and animations draw long notes slightly shorter; pass `theme: { tailShortenMs: 0 }` for full-length notes. Glyph `startMs`, `endMs` and `continuesAfter` keep the chart's times, and a long note whose drawn end falls before a range is no longer drawn in it. A long note drawn shorter than the note height is drawn at note height inside the lane in both time directions, so a short or fully shortened note at a range edge no longer shrinks or disappears.
