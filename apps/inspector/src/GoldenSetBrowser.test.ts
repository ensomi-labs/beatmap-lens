// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import type { GoldenSet } from "./annotation/workflow/golden-set";
import { workflowFixture } from "./annotation/workflow/test-fixtures";
import GoldenSetBrowser from "./GoldenSetBrowser.vue";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

async function fixture() {
  const f = await workflowFixture();
  const version = { revision: 1, sha256: "a".repeat(64) };
  const pin = {
    id: "human",
    observationSha256: "b".repeat(64),
    foundationSha256: "c".repeat(64),
    documentVersion: version,
    comment: "The saved human comparison.",
  };
  const common = {
    sourceSha256: f.inspected.source.sha256,
    source: f.inspected.source,
    scope: f.claim.scope,
    reviewContext: f.claim.reviewContext,
    playbackRate: 1 as const,
  };
  const pool: GoldenSet = {
    checkedAt: "2026-10-08T01:00:00Z",
    cases: [
      {
        ...common,
        caseId: "mixed",
        gold: {
          tech: { presence: "absent" },
          "stream-organization": { presence: "present", salience: "prominent" },
        },
        humans: { tech: [pin], "stream-organization": [pin] },
      },
      {
        ...common,
        caseId: "prominent-tech",
        source: { ...common.source, title: "Tech contrast" },
        gold: { tech: { presence: "present", salience: "prominent" } },
        humans: { tech: [pin] },
      },
    ],
  };
  const source = { document: f.registered, version, sourceBytes: Array.from(f.sourceBytes) };
  const fetcher = vi.fn(async (url: string, _options?: RequestInit) =>
    Response.json(url.endsWith("golden-set") ? pool : source),
  );
  vi.stubGlobal("fetch", fetcher);
  return { pool, source, fetcher };
}

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(GoldenSetBrowser);
  apps.push(app);
  app.mount(container);
  return container;
}

async function select(container: HTMLElement, index: number, value: string) {
  const control = container.querySelectorAll("select")[index];
  if (!control) throw new Error("Missing filter.");
  control.value = value;
  control.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
}

it("filters strength on the selected label and shows protected human evidence without writes", async () => {
  const { fetcher } = await fixture();
  window.history.replaceState({}, "", "/review?view=golden&tag=tech");
  const container = mount();
  await vi.waitFor(() => expect(container.querySelector(".golden-pages svg")).not.toBeNull());
  expect(container.textContent).toContain("3 High-confidence labels · 2 sections");
  expect(container.textContent).toContain("The saved human comparison.");
  expect(container.textContent).toContain("Fixture definition of tech.");
  expect(container.querySelector("select")?.value).toBe("tech");
  await select(container, 1, "prominent");
  expect(container.querySelectorAll(".golden-list button")).toHaveLength(1);
  expect(container.querySelector(".golden-list")?.textContent).toContain("Tech contrast");
  expect(container.querySelector(".golden-list")?.textContent).not.toContain("Workflow fixture");
  expect(fetcher.mock.calls.every((call) => !(call[1] as RequestInit | undefined)?.method)).toBe(
    true,
  );
});

it("withholds stale source evidence and refreshes when a human label leaves the golden set", async () => {
  const { pool, source } = await fixture();
  source.version = { revision: 2, sha256: "d".repeat(64) };
  const container = mount();
  await vi.waitFor(() => expect(container.textContent).toContain("This human reference changed"));
  expect(container.querySelector(".golden-pages")).toBeNull();
  Object.assign(pool, {
    cases: [],
    gateError: "Zero usable current high-confidence human gold cells.",
  });
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Zero usable current high-confidence"),
  );
  expect(container.querySelector(".golden-layout")).toBeNull();
});
