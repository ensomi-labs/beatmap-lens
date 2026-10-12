import { createRenderScene, type ManiaChart, type ManiaNote, serializeSvg } from "beatmap-lens";
import { describe, expect, it } from "vitest";
import { renderStaticPreviewSvg } from "./static-preview";

describe("renderStaticPreviewSvg", () => {
  it("renders the static Inspector policy through a bottom-to-top canonical scene", () => {
    const chart: ManiaChart = {
      keyCount: 4,
      metadata: {},
      notes: [
        note("earlier", 250),
        { ...note("hold", 500), kind: "long", sourceKind: "hold", endMs: 700 },
        note("later", 750),
      ],
      range: { startMs: 0, endMs: 751 },
      diagnostics: [],
    };
    const scene = createRenderScene(chart, {
      range: { startMs: 0, endMs: 1_250 },
      playfield: { widthPx: 640 },
      pixelsPerSecond: 45,
      theme: { tailShortenMs: 100 },
    });

    expect(scene.projection.direction).toBe("bottom-to-top");
    expect(scene.notes.find(({ id }) => id === "later")?.y).toBeLessThan(
      scene.notes.find(({ id }) => id === "earlier")?.y ?? 0,
    );
    const svg = renderStaticPreviewSvg(chart, 100);

    expect(svg).toBe(serializeSvg(scene));
    expect(svg).not.toBe(renderStaticPreviewSvg(chart, 0));
    expect(svg).not.toContain('data-continues-before="false"');
    expect(svg).not.toContain('data-continues-after="false"');
  });
});

function note(id: string, startMs: number): ManiaNote {
  return {
    id,
    kind: "normal",
    sourceKind: "normal",
    column: 0,
    startMs,
    endMs: startMs,
    sourceLine: 1,
    x: 64,
    hitSound: 0,
  };
}
