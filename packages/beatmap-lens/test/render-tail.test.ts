import { describe, expect, it } from "vitest";
import {
  createAnimationScene,
  createRenderAnimation,
  createRenderDocument,
  createRenderScene,
  parseBeatmap,
  projectTime,
  type RenderScene,
  renderDefaults,
  type TimeRange,
} from "../src/index.js";

const chart = parseBeatmap(`osu file format v14
[General]
Mode:3
[Difficulty]
CircleSize:4
[HitObjects]
64,192,1000,128,0,2000:0:0:0:0:
192,192,500,128,0,1005:0:0:0:0:
320,192,1000,128,0,1005:0:0:0:0:
`).chart;
const range = { startMs: 0, endMs: 3000 };

describe("long-note tail shortening", () => {
  it("draws the end tailShortenMs early while the glyph keeps its end time", () => {
    const shortened = tailScene(100);
    expect(longNote(shortened, 1000, 2000)).toMatchObject({ startMs: 1000, endMs: 2000 });
    expect(drawnSpan(shortened, 1000, 2000)).toEqual(projectedSpan(shortened, 1000, 1900));
  });

  it("clamps the drawn end at the start when the shortening exceeds the note", () => {
    const longer = tailScene(5000);
    expect(longNote(longer, 1000, 2000)?.y).toBe(projectTime(longer.projection, 1000));
    expect(drawnSpan(longer, 1000, 2000)).toEqual(drawnSpan(tailScene(1000), 1000, 2000));
  });

  it("leaves long notes unshortened at 0", () => {
    const full = tailScene(0);
    expect(drawnSpan(full, 1000, 2000)).toEqual(projectedSpan(full, 1000, 2000));
  });

  it("defaults to the named render default", () => {
    const defaulted = tailScene();
    expect(drawnSpan(defaulted, 1000, 2000)).toEqual(
      projectedSpan(defaulted, 1000, 2000 - renderDefaults.scene.tailShortenMs),
    );
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (tailShortenMs) => {
    expect(() => tailScene(tailShortenMs)).toThrow(RangeError);
  });

  it("omits a long note whose drawn end is before the range but keeps its true continuation", () => {
    const before = tailScene(20, { startMs: 0, endMs: 1000 });
    const after = tailScene(20, { startMs: 1000, endMs: 3000 });
    expect(longNote(before, 500, 1005)).toMatchObject({ continuesAfter: true });
    expect(drawnSpan(before, 500, 1005)).toEqual(projectedSpan(before, 500, 985));
    expect(longNote(after, 500, 1005)).toBeUndefined();
    // A note shortened to its start still belongs to the range it starts in, as a tap does.
    expect(longNote(after, 1000, 1005)).toBeDefined();
  });

  it("applies to document panels and animation frames", () => {
    const theme = { tailShortenMs: 100 };
    const panel = createRenderDocument(chart, { range, theme }).pages[0]?.panels[0]?.scene;
    const animation = createRenderAnimation(chart, { range, pixelsPerSecond: 240, theme });
    const frame = createAnimationScene(animation, 900);
    if (!panel) throw new Error("No document panel");
    expect(drawnSpan(panel, 1000, 2000)).toEqual(projectedSpan(panel, 1000, 1900));
    expect(drawnSpan(frame, 1000, 2000)).toEqual(projectedSpan(frame, 1000, 1900));
  });
});

/** One pixel per millisecond keeps every projected edge exact. */
function tailScene(tailShortenMs?: number, sceneRange: TimeRange = range): RenderScene {
  return createRenderScene(chart, {
    range: sceneRange,
    pixelsPerSecond: 1000,
    ...(tailShortenMs === undefined ? {} : { theme: { tailShortenMs } }),
  });
}

function longNote(scene: RenderScene, startMs: number, endMs: number) {
  return scene.notes.find(
    (note) => note.kind === "long" && note.startMs === startMs && note.endMs === endMs,
  );
}

function drawnSpan(scene: RenderScene, startMs: number, endMs: number) {
  const note = longNote(scene, startMs, endMs);
  return note && { top: note.y, bottom: note.y + note.height };
}

function projectedSpan(scene: RenderScene, startMs: number, endMs: number) {
  return {
    top: projectTime(scene.projection, endMs),
    bottom: projectTime(scene.projection, startMs),
  };
}
