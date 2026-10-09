import { parseOsu, toManiaChart } from "beatmap-lens";
import { describe, expect, it } from "vitest";
import { proposeExcerpts } from "./excerpts";

function chart(times: number[], column = 64, hold = false) {
  return toManiaChart(
    parseOsu(`osu file format v14
[General]
Mode:3
[Difficulty]
CircleSize:4
[HitObjects]
${times.map((time) => `${column},192,${time},${hold ? 128 : 1},0,${hold ? `${time + 2000}:0:0:0:0:` : "0:0:0:0:"}`).join("\n")}
`),
  );
}

describe("comparison excerpts", () => {
  it("prioritizes the largest placement difference and offers at most five non-overlapping windows", () => {
    const a = chart([0, 90_000]);
    const b = chart([
      0,
      90_000,
      ...Array.from({ length: 100 }, (_, i) => 31_000 + i * 100),
      ...Array.from({ length: 20 }, (_, i) => 60_000 + i * 100),
    ]);
    const excerpts = proposeExcerpts(a, b);
    expect(excerpts.length).toBe(2);
    expect(excerpts[0]?.start_ms).toBeLessThanOrEqual(31_000);
    expect(excerpts[0]?.end_ms).toBeGreaterThan(40_000);
    for (const excerpt of excerpts) {
      expect(excerpt.end_ms - excerpt.start_ms).toBe(15_000);
      expect(
        excerpts.filter(
          (other) => other.start_ms < excerpt.end_ms && other.end_ms > excerpt.start_ms,
        ),
      ).toEqual([excerpt]);
    }
  });

  it("counts lane placement and hold-end changes, while tolerating 20 ms head jitter", () => {
    const a = chart([1000, 3000, 5000]);
    expect(proposeExcerpts(a, chart([1010, 3010, 5010]))[0]?.hint).toContain("Same note placement");
    expect(proposeExcerpts(a, chart([1000, 3000, 5000], 192))[0]?.hint).toContain(
      "extra or missing",
    );
    expect(proposeExcerpts(a, chart([1000, 3000, 5000], 64, true))[0]?.hint).toContain(
      "extra or missing",
    );
  });

  it("keeps a playable ten-second comparison for an identical short chart", () => {
    const a = chart([1000]);
    expect(proposeExcerpts(a, a)).toEqual([
      {
        id: "diff-0",
        start_ms: 0,
        end_ms: 10_000,
        hint: "Same note placement within 20 ms. Listen for any felt difference.",
      },
    ]);
  });
});
