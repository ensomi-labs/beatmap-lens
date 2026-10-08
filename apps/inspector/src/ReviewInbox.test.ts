// @vitest-environment happy-dom

import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import type {
  InboxClaimV2,
  InboxSourceV2,
  ReviewInboxV2,
} from "./annotation/workflow/remote-workspace";
import { reviewVersionOptions, skillKey } from "./annotation/workflow/review-provenance";
import {
  drawReviewSample,
  sampleCandidates,
  sampleKey,
} from "./annotation/workflow/review-sampling";
import { workflowFixture } from "./annotation/workflow/test-fixtures";
import ReviewInbox from "./ReviewInbox.vue";

vi.mock("./ReviewWorkspace.vue", () => ({
  default: defineComponent({
    props: ["openClaim", "remoteSource", "openHumanObservationIds"],
    emits: ["saved", "back-to-inbox"],
    setup:
      (props, { emit }) =>
      () =>
        h("div", { class: "test-review" }, [
          h("output", JSON.stringify(props.openClaim)),
          h(
            "output",
            { class: "test-human-targets" },
            JSON.stringify(props.openHumanObservationIds),
          ),
          h("output", { class: "test-trust" }, JSON.stringify(props.remoteSource?.handoffTrust)),
          h("button", { onClick: () => emit("saved") }, "Save test judgment"),
        ]),
  }),
}));

const apps: ReturnType<typeof createApp>[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

it("opens the golden-set entrypoint independently of saved samples and machine versions", async () => {
  const { fetcher } = await fixture();
  localStorage.setItem(
    "beatmap-lens-review-sample:/review-fixture",
    JSON.stringify({
      createdAt: "2026-10-08T00:00:00Z",
      tagId: "tech",
      strength: "all",
      claims: [],
    }),
  );
  window.history.replaceState({}, "", "/review?view=golden&tag=tech");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("golden-set")
        ? Response.json({
            checkedAt: "2026-10-08T00:00:00Z",
            cases: [],
            gateError: "No current High references.",
          })
        : fetcher(url),
    ),
  );
  const { container } = mount();
  await vi.waitFor(() => expect(container.textContent).toContain("No current High references."));
  expect(container.querySelector("h1")?.textContent).toBe("Golden set");
  expect(container.querySelector(".inbox-version-filters")).toBeNull();
  expect(container.querySelector<HTMLSelectElement>(".golden-filters select")?.value).toBe("tech");
  await click(container, "Browse review history");
  expect(container.querySelector(".inbox-version-filters")).not.toBeNull();
});

it("opens a persistent human confidence queue and advances using saved confidence", async () => {
  const { source, inbox, fetcher } = await fixture();
  const first = {
    id: "human-one",
    previousIds: [],
    tagId: "tech",
    assessment: { presence: "absent" as const },
    scope: { startMs: 1000, endMs: 1800 },
    playbackRate: 1 as const,
  };
  const second = { ...first, id: "human-two" };
  Object.assign(inbox, { sources: [{ ...source, humanObservations: [first, second] }] });
  const plan = {
    version: 1,
    id: "balanced",
    title: "Balanced confidence review",
    items: [first, second].map((target, index) => ({
      id: String(index),
      sourceSha256: source.source.sha256,
      observationIds: [target.id],
    })),
  };
  window.history.replaceState({}, "", "/review?confidencePlan=/confidence.json");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => (url === "/confidence.json" ? Response.json(plan) : fetcher(url))),
  );
  const { container } = mount();
  await vi.waitFor(() =>
    expect(
      container.querySelectorAll(".confidence-review-queue .inbox-sample-list button"),
    ).toHaveLength(2),
  );
  expect(container.querySelector(".confidence-review-queue")?.textContent).toContain("0/2 labels");
  await click(container, "Continue confidence review");
  await vi.waitFor(() =>
    expect(container.querySelector(".test-human-targets")?.textContent).toBe('["human-one"]'),
  );
  Object.assign(inbox, {
    sources: [
      {
        ...source,
        humanObservations: [
          { ...first, id: "human-revised", previousIds: [first.id], confidence: "low" },
          second,
        ],
      },
    ],
  });
  await click(container, "Save test judgment");
  await vi.waitFor(() =>
    expect(container.querySelector(".inbox-navigation")?.textContent).toContain("Confidence · 1/2"),
  );
  await click(container, "Next confidence section");
  await vi.waitFor(() =>
    expect(container.querySelector(".test-human-targets")?.textContent).toBe('["human-two"]'),
  );
});

async function fixture() {
  const f = await workflowFixture();
  const claim = (claimId: string, changes: Partial<InboxClaimV2> = {}): InboxClaimV2 => ({
    handoffId: "handoff",
    claimId,
    tagId: "tech",
    scope: { startMs: 1000, endMs: 1800 },
    status: "agent-reviewed",
    rationale: "Reviewed evidence",
    assessment: { presence: "present", salience: "prominent" },
    ...changes,
  });
  const source: InboxSourceV2 = {
    source: f.inspected.source,
    version: { revision: 1, sha256: "a".repeat(64) },
    counts: { "agent-reviewed": 3, total: 3 },
    requests: [],
    expertQueue: [],
    reviews: [
      claim("one"),
      claim("two", { scope: { startMs: 800, endMs: 1500 } }),
      claim("negative", { assessment: { presence: "absent" } }),
    ],
  };
  const inbox: ReviewInboxV2 = { workspace: "/review-fixture", sources: [source], receipts: [] };
  const fetcher = vi.fn(async (input: string) =>
    Response.json(
      input.endsWith("inbox")
        ? inbox
        : {
            document: { source: source.source },
            version: source.version,
          },
    ),
  );
  return { claim, source, inbox, fetcher };
}

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(ReviewInbox);
  apps.push(app);
  app.mount(container);
  return { app, container };
}

async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.includes(label) || button.getAttribute("aria-label") === label,
  );
  expect(button).toBeDefined();
  button?.click();
  await nextTick();
}

async function change(control: HTMLInputElement | HTMLSelectElement, value: string) {
  control.value = value;
  control.dispatchEvent(
    new Event(control.tagName === "INPUT" ? "input" : "change", { bubbles: true }),
  );
  await nextTick();
}

describe("machine review sampling", () => {
  it("shows judgment rates in requests, samples and history", async () => {
    const f = await fixture();
    const slow = f.claim("slow", { playbackRate: 0.5 });
    const fast = f.claim("fast", { playbackRate: 1.5 });
    Object.assign(f.source, {
      reviews: [
        slow,
        fast,
        f.claim("historical"),
        { ...slow, claimId: "slow-request" },
        { ...fast, claimId: "fast-request" },
      ],
      requests: [
        {
          requestId: "rate-review",
          handoffId: "handoff",
          claimIds: ["slow-request", "fast-request"],
          pendingClaimIds: ["slow-request", "fast-request"],
          reason: "Review rates",
          question: "Compare these rates.",
        },
      ],
    });
    vi.stubGlobal("fetch", f.fetcher);
    const { container } = mount();
    await vi.waitFor(() =>
      expect(container.querySelector(".inbox-claims")?.textContent).toContain("0.5×"),
    );
    expect(container.querySelector(".inbox-claims")?.textContent).toContain("1.5×");
    await click(container, "Browse review history");
    expect(container.querySelector(".inbox-history-list")?.textContent).toContain("0.5×");
    expect(container.querySelector(".inbox-history-list")?.textContent).toContain("1.5×");
    expect(container.querySelector(".inbox-history-list")?.textContent).toContain("1×");
    await click(container, "Sample machine-reviewed sections");
    await click(container, "Draw sample");
    expect(container.querySelector(".inbox-sample-list")?.textContent).toContain("0.5×");
    expect(container.querySelector(".inbox-sample-list")?.textContent).toContain("1.5×");
  });

  it("refreshes active and cached evidence context without reloading unchanged chart bytes", async () => {
    const { source, inbox } = await fixture();
    const trust = { source: "current", foundation: "current", humanContext: "current" } as const;
    Object.assign(source.reviews[0] ?? {}, { trust });
    const fetcher = vi.fn(async (url: string) =>
      Response.json(
        url.endsWith("inbox")
          ? inbox
          : {
              document: { source: source.source },
              version: source.version,
              handoffTrust: { handoff: trust },
            },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const { container } = mount();
    await vi.waitFor(() =>
      expect(
        container.querySelector("#review-history > .inbox-history-list button"),
      ).not.toBeNull(),
    );
    (
      container.querySelector("#review-history > .inbox-history-list button") as HTMLButtonElement
    ).click();
    await vi.waitFor(() =>
      expect(container.querySelector(".test-trust")?.textContent).toContain(
        '"humanContext":"current"',
      ),
    );
    Object.assign(source.reviews[0] ?? {}, { trust: { ...trust, humanContext: "changed" } });
    await click(container, "Save test judgment");
    await vi.waitFor(() =>
      expect(container.querySelector(".test-trust")?.textContent).toContain(
        '"humanContext":"changed"',
      ),
    );
    expect(fetcher.mock.calls.filter(([url]) => !url.endsWith("inbox"))).toHaveLength(1);
    await click(container, "Inbox ·");
    (
      container.querySelector("#review-history > .inbox-history-list button") as HTMLButtonElement
    ).click();
    await vi.waitFor(() =>
      expect(container.querySelector(".test-trust")?.textContent).toContain(
        '"humanContext":"changed"',
      ),
    );
    expect(fetcher.mock.calls.filter(([url]) => !url.endsWith("inbox"))).toHaveLength(1);
  });

  it("opens charts containing human judgments without agent proposals", async () => {
    const { source, inbox, fetcher } = await fixture();
    Object.assign(source, {
      reviews: [],
      humanAssessmentCounts: { settled: 1, unresolved: 0, unreviewed: 0 },
    });
    vi.stubGlobal("fetch", fetcher);
    const { container } = mount();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Charts and human judgments · 1"),
    );
    await click(container, "Open chart");
    await vi.waitFor(() => expect(container.querySelector(".test-review")).not.toBeNull());
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(source.source.sha256),
      expect.anything(),
    );
    expect(inbox.sources[0]?.reviews).toEqual([]);
  });

  it.each(["stale", "superseded", "awaiting-audit", "needs-revision"] as const)(
    "opens a saved sample with %s status",
    async (status) => {
      const { source, inbox, fetcher } = await fixture();
      assert(source.reviews[0]);
      Object.assign(source.reviews[0], {
        status,
        trust: { source: "current", foundation: "current", humanContext: "changed" },
      });
      localStorage.setItem(
        `beatmap-lens-review-sample:${inbox.workspace}`,
        JSON.stringify({
          createdAt: "2026-09-09",
          tagId: "",
          strength: "all",
          claims: [{ sourceSha256: source.source.sha256, handoffId: "handoff", claimId: "one" }],
        }),
      );
      vi.stubGlobal("fetch", fetcher);
      const { container } = mount();
      await vi.waitFor(() =>
        expect(container.querySelector(".inbox-sample-list button")).not.toBeNull(),
      );
      const row = container.querySelector<HTMLButtonElement>(".inbox-sample-list button");
      assert(row);
      expect(row.disabled).toBe(false);
      expect(row.textContent).toContain("human examples changed");
      expect(container.textContent).not.toContain("Awaiting agent reread");
      row.click();
      await vi.waitFor(() =>
        expect(container.querySelector("output")?.textContent).toContain('"claimId":"one"'),
      );
    },
  );

  it("samples work with changed human examples independently of its work status", async () => {
    const { source, claim } = await fixture();
    const reviews = ["stale", "awaiting-audit", "needs-revision", "agent-reviewed"].map(
      (status, index) =>
        claim(`pending-${index}`, {
          status: status as InboxClaimV2["status"],
          scope: { startMs: index * 100, endMs: 1800 },
          trust: { source: "current", foundation: "current", humanContext: "changed" },
        }),
    );
    expect(
      sampleCandidates([{ ...source, reviews }], "", "all").map((item) => item.claim.claimId),
    ).toEqual(reviews.map((item) => item.claimId));
  });

  it("prefetches the next sample, reuses recent sources, and invalidates changed versions", async () => {
    const { inbox, source, claim } = await fixture();
    const second: InboxSourceV2 = {
      ...source,
      source: { ...source.source, sha256: "f".repeat(64) },
      reviews: [claim("second")],
    };
    Object.assign(inbox, { sources: [source, second] });
    localStorage.setItem(
      `beatmap-lens-review-sample:${inbox.workspace}`,
      JSON.stringify({
        createdAt: "2026-09-08",
        tagId: "",
        strength: "all",
        claims: [
          { sourceSha256: source.source.sha256, handoffId: "handoff", claimId: "one" },
          { sourceSha256: second.source.sha256, handoffId: "handoff", claimId: "second" },
        ],
      }),
    );
    const reads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("inbox")) return Response.json(inbox);
        const selected = url.endsWith(second.source.sha256) ? second : source;
        reads.push(selected.source.sha256);
        return Response.json({ document: { source: selected.source }, version: selected.version });
      }),
    );
    const { container } = mount();
    await vi.waitFor(() => expect(container.textContent).toContain("Continue review"));
    await click(container, "Continue review");
    await vi.waitFor(() => expect(reads).toEqual([source.source.sha256, second.source.sha256]));
    await click(container, "Next sample");
    await vi.waitFor(() =>
      expect(container.querySelector("output")?.textContent).toContain("second"),
    );
    await click(container, "Next sample");
    await vi.waitFor(() => expect(container.querySelector("output")?.textContent).toContain("one"));
    expect(reads).toHaveLength(2);
    await click(container, "Next sample");
    await vi.waitFor(() =>
      expect(container.querySelector("output")?.textContent).toContain("second"),
    );
    Object.assign(source, { version: { revision: 2, sha256: "b".repeat(64) } });
    await click(container, "Save test judgment");
    await vi.waitFor(() =>
      expect(reads.filter((sha) => sha === source.source.sha256)).toHaveLength(2),
    );
  });

  it("keeps equal labels from different skill hashes and auditor versions distinct", async () => {
    const { source, claim } = await fixture();
    const agent = (hash: string) => ({
      producerId: hash,
      role: "labeler" as const,
      skill: { name: "judgment", version: "same-version-name", sha256: hash.repeat(64) },
    });
    const audit = (hash: string) => ({
      auditId: hash,
      agent: { ...agent(hash), role: "auditor" as const },
      createdAt: "2026-09-07T10:00:00Z",
      outcome: "supported" as const,
    });
    const input = {
      ...source,
      reviews: [
        claim("old", { agent: agent("a"), audits: [audit("a")] }),
        claim("new", { agent: agent("b"), audits: [audit("a")] }),
        claim("reaudited", { agent: agent("a"), audits: [audit("b")] }),
        claim("same-cohort", { agent: agent("a"), audits: [audit("a")] }),
      ],
    };
    expect(sampleCandidates([input], "", "all").map((x) => x.claim.claimId)).toEqual([
      "old",
      "new",
      "reaudited",
    ]);
    expect(
      sampleCandidates([input], "", "all", { labelerVersion: skillKey(agent("b")) }).map(
        (x) => x.claim.claimId,
      ),
    ).toEqual(["new"]);
    expect(
      sampleCandidates([input], "", "all", { auditorVersion: skillKey(agent("b")) }).map(
        (x) => x.claim.claimId,
      ),
    ).toEqual(["reaudited"]);
    expect(reviewVersionOptions(input.reviews, "labeler").map((x) => x.label)).toEqual([
      "judgment · same-version-name · aaaaaaaa",
      "judgment · same-version-name · bbbbbbbb",
    ]);
  });

  it("filters history and sampling by exact versions and opens superseded records", async () => {
    const { source, inbox, fetcher, claim } = await fixture();
    const agent = (hash: string) => ({
      producerId: `producer-${hash}`,
      role: "labeler" as const,
      skill: { name: "judgment", version: "same-name", sha256: hash.repeat(64) },
    });
    const history = claim("historical", {
      agent: agent("a"),
      status: "superseded",
      submittedAt: "2026-09-06T10:00:00Z",
    });
    const input = {
      ...inbox,
      sources: [
        {
          ...source,
          reviews: [
            history,
            claim("latest", { agent: agent("b"), submittedAt: "2026-09-07T10:00:00Z" }),
            claim("human", { agent: agent("a"), status: "modified" }),
          ],
        },
      ],
    };
    fetcher.mockImplementation(async (url) =>
      Response.json(
        url.endsWith("inbox")
          ? input
          : { document: { source: source.source }, version: source.version },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const { container } = mount();
    await vi.waitFor(() =>
      expect(container.querySelector('select[name="labelerVersion"]')?.children).toHaveLength(3),
    );
    await click(container, "Browse review history");
    await change(
      container.querySelector('select[name="labelerVersion"]') as HTMLSelectElement,
      skillKey(agent("a")),
    );
    expect(container.querySelectorAll("#review-history > .inbox-history-list button")).toHaveLength(
      2,
    );
    await change(
      container.querySelector('select[name="historyStatus"]') as HTMLSelectElement,
      "superseded",
    );
    const button = container.querySelector(".inbox-history-list button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("version judgment · same-name · aaaaaaaa");
    expect(button.textContent).not.toContain("Labeler");
    await click(container, "Show provenance");
    expect(button.textContent).toContain("same-name · aaaaaaaa");
    button.click();
    await vi.waitFor(() =>
      expect(container.querySelector("output")?.textContent).toContain('"claimId":"historical"'),
    );
    await click(container, "Inbox");
    await change(
      container.querySelector('select[name="labelerVersion"]') as HTMLSelectElement,
      skillKey(agent("b")),
    );
    await click(container, "Sample machine-reviewed sections");
    expect(container.querySelector("#review-history")).toBeNull();
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await nextTick();
    const saved = JSON.parse(
      localStorage.getItem(`beatmap-lens-review-sample:${inbox.workspace}`) ?? "{}",
    );
    expect(saved.labelerVersion).toBe(skillKey(agent("b")));
    expect(saved.claims.map((x: { claimId: string }) => x.claimId)).toEqual(["latest"]);
    await change(
      container.querySelector('select[name="labelerVersion"]') as HTMLSelectElement,
      skillKey(agent("a")),
    );
    expect(container.querySelector(".inbox-sampler")?.textContent).toContain(
      "labeler judgment · same-name · bbbbbbbb",
    );
  });

  it("shows and filters named revisions that share the same skill content", async () => {
    const { source, claim, fetcher } = await fixture();
    const reviews = ["fine-harness-v1", "fine-harness-v2", "fine-harness-v3"].map((version) => {
      const skill = { name: "judgment", version, sha256: "a".repeat(64) };
      return claim(version, {
        agent: { producerId: version, role: "labeler", skill },
        audits: [
          {
            auditId: version,
            agent: { producerId: `audit-${version}`, role: "auditor", skill },
            createdAt: "2026-09-09T10:00:00Z",
            outcome: "supported",
          },
        ],
      });
    });
    Object.assign(source, { reviews });
    expect(sampleCandidates([source], "", "all").map((item) => item.claim.claimId)).toEqual(
      reviews.map((item) => item.claimId),
    );
    vi.stubGlobal("fetch", fetcher);
    const { container } = mount();
    await vi.waitFor(() =>
      expect(
        container.querySelectorAll("#review-history > .inbox-history-list button"),
      ).toHaveLength(3),
    );
    for (const role of ["labeler", "auditor"] as const) {
      const select = container.querySelector<HTMLSelectElement>(`select[name="${role}Version"]`);
      assert(select);
      expect(select.options).toHaveLength(4);
      expect([...select.options].slice(1).map((option) => option.textContent)).toEqual(
        reviews.map((item) => `judgment · ${item.claimId} · aaaaaaaa · 1 claims`),
      );
      await change(select, skillKey(reviews[1]?.agent));
      const rows = container.querySelectorAll("#review-history > .inbox-history-list button");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toContain("fine-harness-v2");
      await change(select, "");
    }
  });

  it("restores saved content-hash filters without hiding their matching revisions", async () => {
    const { source, inbox, claim, fetcher } = await fixture();
    const contentHash = "a".repeat(64);
    const reviews = ["v1", "v2"].map((version) =>
      claim(version, {
        agent: {
          producerId: version,
          role: "labeler",
          skill: { name: "judgment", version, sha256: contentHash },
        },
      }),
    );
    Object.assign(source, { reviews });
    localStorage.setItem(
      `beatmap-lens-review-sample:${inbox.workspace}`,
      JSON.stringify({
        createdAt: "2026-09-08",
        tagId: "",
        strength: "all",
        labelerVersion: contentHash,
        claims: reviews.map((item) => ({
          sourceSha256: source.source.sha256,
          handoffId: item.handoffId,
          claimId: item.claimId,
        })),
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { container } = mount();
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".inbox-sample-list button")).toHaveLength(2),
    );
    const select = container.querySelector<HTMLSelectElement>('select[name="labelerVersion"]');
    assert(select);
    expect(select.value).toBe(contentHash);
    expect(select.selectedOptions[0]?.textContent).toBe(
      "Saved content aaaaaaaa · all matching versions",
    );
    expect(container.querySelector(".inbox-sampler")?.textContent).toContain("2 matching sections");
    expect(container.querySelector(".inbox-sampler")?.textContent).toContain(
      "Sample versions: labeler Saved content aaaaaaaa · all matching versions",
    );
    await change(select, skillKey(reviews[0]?.agent));
    expect(container.querySelector(".inbox-sampler")?.textContent).toContain("1 matching sections");
    expect(container.querySelectorAll(".inbox-sample-list button")).toHaveLength(2);
  });

  it("visits unsaved samples in order and reports failed cross-chart loads in the active view", async () => {
    const { inbox, source, fetcher } = await fixture();
    const sources = source.reviews.map((claim, index) => ({
      ...source,
      source: { ...source.source, sha256: `${index}`.repeat(64) },
      reviews: [claim],
    }));
    const input = { ...inbox, sources };
    let failedSource = "";
    fetcher.mockImplementation(async (url) => {
      if (url.endsWith("inbox")) return Response.json(input);
      if (url.endsWith(failedSource) && failedSource) throw new Error("Could not load next chart");
      const current = sources.find((item) => url.endsWith(item.source.sha256));
      assert(current);
      return Response.json({ document: { source: current.source }, version: current.version });
    });
    vi.stubGlobal("fetch", fetcher);
    const { container } = mount();
    await vi.waitFor(() => expect(container.textContent).toContain("9 machine-reviewed"));
    await click(container, "Sample machine-reviewed sections");
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await nextTick();
    const saved = localStorage.getItem(`beatmap-lens-review-sample:${inbox.workspace}`);
    assert(saved);
    const batch = JSON.parse(saved);
    failedSource = batch.claims[2].sourceSha256;
    (container.querySelector(".inbox-sample-list button") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(container.querySelector("output")?.textContent).toContain(batch.claims[0].claimId),
    );
    await click(container, "Next sample");
    await vi.waitFor(() =>
      expect(container.querySelector("output")?.textContent).toContain(batch.claims[1].claimId),
    );
    await click(container, "Next sample");
    await vi.waitFor(() =>
      expect(container.querySelector(".inbox-active [role='alert']")?.textContent).toContain(
        "Could not load next chart",
      ),
    );
    expect(container.querySelector("output")?.textContent).toContain(batch.claims[1].claimId);
    failedSource = "";
    await click(container, "Next sample");
    await vi.waitFor(() =>
      expect(container.querySelector("output")?.textContent).toContain(batch.claims[2].claimId),
    );
    expect(container.querySelector(".inbox-active [role='alert']")).toBeNull();
  });

  it("filters by tag and strength and excludes human, superseded and already requested work", async () => {
    const { source, claim } = await fixture();
    const input = {
      ...source,
      reviews: [
        ...source.reviews,
        claim("ln", { tagId: "ln-coordination" }),
        claim("human", { status: "modified" }),
        claim("old", { status: "superseded" }),
        claim("stale", { status: "stale" }),
        claim("requested"),
        claim("repeated", { handoffId: "second-submission" }),
        claim("different-strength", {
          assessment: { presence: "present", salience: "supporting" },
        }),
      ],
      requests: [
        {
          requestId: "request",
          handoffId: "handoff",
          claimIds: ["requested"],
          pendingClaimIds: ["requested"],
          reason: "spot-check",
          question: "Review",
        },
      ],
    };
    expect(
      sampleCandidates([input], "tech", "prominent").map((item) => item.claim.claimId),
    ).toEqual(["one", "two"]);
    expect(sampleCandidates([input], "tech", "absent").map((item) => item.claim.claimId)).toEqual([
      "negative",
    ]);
    const candidates = sampleCandidates([input], "", "all");
    const sample = drawReviewSample(candidates, 3, () => 0.5);
    expect(sample).toHaveLength(3);
    expect(new Set(sample.map(sampleKey)).size).toBe(3);
    expect(drawReviewSample(candidates, 100)).toHaveLength(5);
  });

  it("retains a bounded batch across reload, opens exact claims, and reads human changes before advancing", async () => {
    const { inbox, source, fetcher } = await fixture();
    vi.stubGlobal("fetch", fetcher);
    let { app, container } = mount();
    await vi.waitFor(() => expect(container.textContent).toContain("3 machine-reviewed"));
    await click(container, "Sample machine-reviewed sections");
    const selects = container.querySelectorAll("form select");
    await change(selects[0] as HTMLSelectElement, "tech");
    await change(selects[1] as HTMLSelectElement, "prominent");
    await change(container.querySelector("form input") as HTMLInputElement, "2");
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(container.querySelectorAll(".inbox-sample-list button")).toHaveLength(2);
    expect(fetcher.mock.calls.every(([url]) => url.endsWith("inbox"))).toBe(true);
    const saved = localStorage.getItem(`beatmap-lens-review-sample:${inbox.workspace}`);
    assert(saved);
    const batch = JSON.parse(saved);
    app.unmount();
    apps.splice(apps.indexOf(app), 1);
    container.remove();
    ({ app, container } = mount());
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".inbox-sample-list button")).toHaveLength(2),
    );
    (container.querySelector(".inbox-sample-list button") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(container.querySelector("output")?.textContent).toContain(batch.claims[0].claimId),
    );
    const modified = source.reviews.find((claim) => claim.claimId === batch.claims[0].claimId);
    assert(modified);
    Object.assign(modified, {
      status: "modified",
      assessment: { presence: "present", salience: "supporting" },
    });
    await click(container, "Save test judgment");
    await vi.waitFor(() => expect(container.textContent).toContain("Sample · 1/2"));
    await click(container, "Next sample");
    await vi.waitFor(() =>
      expect(container.querySelector("output")?.textContent).toContain(batch.claims[1].claimId),
    );
    const stale = source.reviews.find((claim) => claim.claimId === batch.claims[1].claimId);
    assert(stale);
    Object.assign(stale, { status: "stale" });
    await click(container, "Save test judgment");
    await vi.waitFor(() =>
      expect(container.querySelector(".inbox-sample-list")?.textContent).toContain("stale"),
    );
    expect(
      (container.querySelectorAll(".inbox-sample-list button")[1] as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
