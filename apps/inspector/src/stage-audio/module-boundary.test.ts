import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ensomi from "ensomi";
import {
  computeGridFit,
  createInitialState,
  decomposeRangeToSpans,
  projectRedLines,
  rankInboxSpans,
  ScriptedMockProvider,
  SessionController,
  SNAP_ROLES,
  TRIGGER_LAYERS,
} from "ensomi";
import { describe, expect, it } from "vitest";

const stageAudioDir = fileURLToPath(new URL(".", import.meta.url));
const boundaryTestFile = "module-boundary.test.ts";

function extractModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticImportExport = /(?:from|import)\s+["']([^"']+)["']/g;
  const dynamicImport = /import\(\s*["']([^"']+)["']\s*\)/g;
  const urlConstructor = /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
  for (const pattern of [staticImportExport, dynamicImport, urlConstructor]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

describe("stage-audio module boundary", () => {
  it("keeps stage-audio free of timing, annotation, tempo, draft, and ensomi imports", async () => {
    const entries = (await readdir(stageAudioDir)).filter(
      (name) => name.endsWith(".ts") || name.endsWith(".vue"),
    );
    expect(entries).toEqual(
      expect.arrayContaining([
        "audio-engine.ts",
        "clock.ts",
        "display.ts",
        "edge-auto-scroll.ts",
        "index.ts",
        "input.ts",
        "pcm.ts",
        "playhead-layer.ts",
        "spectrogram.ts",
        "spectrogram.worker.ts",
        "time-view.ts",
        "transport.ts",
        "waveform.ts",
      ]),
    );

    const forbiddenSiblingPattern =
      /(?:^|\/)(?:timing|annotation|tempo|draft)(?:\/|$)|^\.\.\/|^ensomi(?:\/|$)/;

    for (const name of entries) {
      const source = await readFile(join(stageAudioDir, name), "utf8");
      const specifiers = extractModuleSpecifiers(source);

      if (name === boundaryTestFile) {
        // Even this boundary test never reaches into sibling Inspector feature folders.
        for (const specifier of specifiers) {
          expect(specifier, `${name}: ${specifier}`).not.toMatch(
            /(?:^|\/)(?:timing|annotation|tempo|draft)(?:\/|$)|^\.\.\//,
          );
        }
        continue;
      }

      for (const specifier of specifiers) {
        expect(specifier, `${name}: ${specifier}`).not.toMatch(forbiddenSiblingPattern);
        if (!name.endsWith(".test.ts")) {
          // Every non-test stage-audio module only imports local ./stage-audio siblings.
          expect(specifier.startsWith("./"), `${name}: ${specifier}`).toBe(true);
        }
      }
    }
  });

  it("resolves the hardened ensomi tempo contract cleanly in TypeScript and Vitest", () => {
    expect(Object.keys(ensomi)).toHaveLength(65);
    expect(SNAP_ROLES).toEqual(["transient_attack", "p_center", "harmonic_change", "release"]);
    expect(TRIGGER_LAYERS).toEqual(["song_open", "micro_assist", "heavy_recompute"]);

    const controller = new SessionController({
      provider: new ScriptedMockProvider(),
      durationSec: 12,
    });
    expect(controller.getState().durationSec).toBe(12);
    controller.close();

    const scopes = decomposeRangeToSpans(
      [
        {
          id: "seg-1",
          t0: 0,
          t1: 6,
          regime: "auto",
          kept: false,
          source: "draft",
          revision: 1,
        },
        {
          id: "seg-2",
          t0: 6,
          t1: 12,
          regime: "auto",
          kept: false,
          source: "draft",
          revision: 1,
        },
      ],
      { t0: 4, t1: 8 },
    );
    expect(scopes).toEqual([
      { segmentId: "seg-1", t0: 4, t1: 6 },
      { segmentId: "seg-2", t0: 6, t1: 8 },
    ]);

    const fit = computeGridFit(
      [{ id: "s1", timeSec: 0.5, source: "draft", revision: 1 }],
      [
        { id: "b1", timeSec: 0.5, source: "draft", revision: 1 },
        { id: "b2", timeSec: 1.0, source: "draft", revision: 1 },
      ],
    );
    expect(fit[0]?.status).toBe("on_grid");

    const projection = projectRedLines([
      { id: "b1", timeSec: 0.5, source: "draft", revision: 1 },
      { id: "b2", timeSec: 1.0, source: "draft", revision: 1 },
    ]);
    expect(projection.barPolicy).toBe("barlines_not_inferred");
    expect(projection.redLines).toHaveLength(1);

    const ranked = rankInboxSpans(createInitialState({ durationSec: 12 }));
    expect(Array.isArray(ranked)).toBe(true);
  });
});
