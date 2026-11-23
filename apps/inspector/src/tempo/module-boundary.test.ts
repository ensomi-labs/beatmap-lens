import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tempoRoot = fileURLToPath(new URL(".", import.meta.url));

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (ext === ".ts" || ext === ".vue") {
        results.push(full);
      }
    }
  }
  return results.sort();
}

describe("Tempo frontend module boundary and zero-leak discipline", () => {
  const files = collectSourceFiles(tempoRoot);

  it("discovers Tempo TypeScript and Vue modules", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it("never imports from ../timing, ../annotation, or ../draft", () => {
    const forbiddenPrefixes = [
      ["..", "timing"].join("/"),
      ["..", "annotation"].join("/"),
      ["..", "draft"].join("/"),
    ];
    const importRegex = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const rel = relative(tempoRoot, file);
      for (const match of text.matchAll(importRegex)) {
        const spec = match[1] ?? "";
        for (const forbidden of forbiddenPrefixes) {
          expect(spec.startsWith(forbidden), `${rel} imported forbidden path "${spec}"`).toBe(
            false,
          );
        }
      }
    }
  });

  it("contains zero forbidden dev, mock, or internal disclaimer tokens", () => {
    const forbiddenTokens = [
      ["honesty", "badge"].join("-"),
      ["rule", "mock"].join(" "),
      ["reserved for", "N1"].join(" "),
      ["BeatThis", "does not"].join(" "),
      ["experimental", "/", "draft"].join(" "),
    ];

    for (const file of files) {
      const text = readFileSync(file, "utf8").toLowerCase();
      const rel = relative(tempoRoot, file);
      for (const token of forbiddenTokens) {
        expect(
          text.includes(token.toLowerCase()),
          `${rel} contained forbidden token "${token}"`,
        ).toBe(false);
      }
    }
  });
});
