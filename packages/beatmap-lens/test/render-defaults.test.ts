import { describe, expect, it } from "vitest";
import { renderDefaults } from "../src/index.js";

describe("render defaults", () => {
  it("exports the frozen scene and document baseline", () => {
    expect(renderDefaults).toEqual({
      scene: {
        pixelsPerSecond: 240,
        playfield: { widthPx: 640 },
        timeDirection: "bottom-to-top",
        // A tunable default: its value is not part of this contract.
        tailShortenMs: expect.any(Number),
        metrics: {
          paddingPx: { top: 24, right: 16, bottom: 24, left: 16 },
          laneGapPx: 4,
          noteHeightPx: 8,
          noteInsetPx: 5,
          noteRadiusPx: 2,
        },
      },
      animation: {
        viewport: { widthPx: 640, heightPx: 480 },
        scrollSpeed: 20,
        fps: 30,
      },
      document: {
        page: {
          size: { widthPx: 1_600, heightPx: 900 },
          paddingPx: { top: 24, right: 24, bottom: 24, left: 24 },
          gapPx: 12,
          columns: "auto",
        },
        panel: {
          playfield: { laneWidthPx: 48 },
          maxNoteRows: 32,
          maxSourceDurationMs: 10_000,
        },
        scale: { type: "linear", pixelsPerSecond: 240 },
        fit: { preferredPixelsPerSecond: 240, minPixelsPerSecond: 140 },
        rowAware: { basePixelsPerSecond: 240, minRowGapPx: 12, maxEmptyGapPx: 72 },
        timeDirection: "bottom-to-top",
        timeAxis: {
          side: "left",
          widthPx: 32,
          gapPx: 0,
          labels: "major",
          tickStepMs: "auto",
          showCompressionMarks: true,
        },
      },
    });

    expect(allObjects(renderDefaults).every(Object.isFrozen)).toBe(true);
  });
});

function allObjects(value: object): object[] {
  return [
    value,
    ...Object.values(value).flatMap((nested) =>
      typeof nested === "object" && nested !== null ? allObjects(nested) : [],
    ),
  ];
}
