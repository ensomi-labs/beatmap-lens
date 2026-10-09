// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, shallowRef } from "vue";
import { AudioPlaybackController } from "./annotation/audio-playback";
import type { PlaybackRate } from "./annotation/playback-rate";
import type { SessionPreferences } from "./annotation/session-store";
import { FakeDirectoryHandle } from "./annotation/test-helpers";
import type { ClaimV2, FoundationV2 } from "./annotation/workflow/contracts";
import { WorkflowDirectoryV2 } from "./annotation/workflow/directory";
import {
  addHumanObservationV2,
  reviewDocumentVersionV2,
  sealAuditV2,
  sealHandoffV2,
} from "./annotation/workflow/domain";
import type { RemoteSourceV2 } from "./annotation/workflow/remote-workspace";
import { historicalAcceptance, NOW, workflowFixture } from "./annotation/workflow/test-fixtures";
import ReviewWorkspace from "./ReviewWorkspace.vue";

const picker = vi.hoisted(() => vi.fn());
vi.mock("./annotation/file-system-access", () => ({ pickDatasetDirectory: picker }));
const preferences = vi.hoisted(() => ({ value: undefined as SessionPreferences | undefined }));
vi.mock("./annotation/session-store", () => ({
  IndexedDbSessionStore: class {
    async getPreferences() {
      return preferences.value;
    }
    async setPreferences(value: SessionPreferences) {
      preferences.value = value;
    }
  },
}));
const apps: ReturnType<typeof createApp>[] = [];
const appErrors: unknown[] = [];

beforeEach(() => {
  localStorage.clear();
  preferences.value = undefined;
});

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.replaceChildren();
  localStorage.clear();
  picker.mockReset();
  vi.unstubAllGlobals();
  expect(appErrors.splice(0)).toEqual([]);
});

describe("ReviewWorkspace mounted workflow", () => {
  it("keeps confidence drafts separate when changing selected labels on the same chart", async () => {
    const f = await workspaceFixture(false, false, undefined, 5);
    const initial = await f.read();
    if (!initial) throw new Error("Missing fixture.");
    const stored = await f.directory.addObservations(f.sourceBytes, initial.version, {
      humanId: "historical-human",
      claims: [f.claim, { ...f.claim, id: "claim-b", tagId: "synthetic-b" }],
    });
    const first = stored.document.observations[0];
    const second = stored.document.observations[1];
    if (!first || !second) throw new Error("Missing observations.");
    const selected = shallowRef<readonly string[]>([first.id]);
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp({
      render: () =>
        h(ReviewWorkspace, {
          remoteSource: { ...stored, sourceBytes: Array.from(f.sourceBytes) },
          openHumanObservationIds: selected.value,
        }),
    });
    app.config.errorHandler = (error) => appErrors.push(error);
    apps.push(app);
    app.mount(container);
    await vi.waitFor(() =>
      expect(container.querySelectorAll('.section-sliders input[type="range"]')).toHaveLength(1),
    );
    await setConfidence(container, "a", true);
    selected.value = [second.id];
    await nextTick();
    expect(slider(container, "synthetic-b")).toBeDefined();
    expect(confidenceControl(container, "b").checked).toBe(false);
    selected.value = [first.id];
    await nextTick();
    expect(confidenceControl(container, "a").checked).toBe(true);
    expect((await f.read())?.document).toEqual(stored.document);
  });

  it.each(["agent", "direct"])(
    "reviews selected %s human labels without filling other labels or changing evidence",
    async (origin) => {
      const f = await workspaceFixture(true, false, undefined, 5);
      let stored = await f.read();
      if (!stored || !f.handoff) throw new Error("Missing fixture.");
      const handoffId = f.handoff.handoffId;
      if (origin === "agent") {
        stored = (await f.directory.importHandoff(f.sourceBytes, stored.version, f.handoff)).stored;
        stored = await f.directory.decideSection(f.sourceBytes, stored.version, {
          humanId: "historical-human",
          decisions: ["claim-a", "claim-b"].map((claimId) => ({
            handoffId,
            claimId,
            disposition: "accepted",
          })),
        });
      } else {
        stored = await f.directory.addObservations(f.sourceBytes, stored.version, {
          humanId: "historical-human",
          claims: [f.claim, { ...f.claim, id: "claim-b", tagId: "synthetic-b" }],
        });
      }
      const before = stored;
      const target = stored.document.observations[0];
      if (!target) throw new Error("Missing selected observation.");
      const { container } = mountRemote(f, stored, undefined, [target.id]);
      await vi.waitFor(() =>
        expect(container.querySelectorAll('.section-sliders input[type="range"]')).toHaveLength(1),
      );
      expect(container.textContent).toContain("Selected labels · confidence review");
      const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
        const body = JSON.parse(String(options?.body));
        return Response.json(
          String(url).endsWith("decideSection")
            ? await f.directory.decideSection(f.sourceBytes, body.expectedBase, body.input)
            : await f.directory.addObservations(f.sourceBytes, body.expectedBase, body.input),
        );
      });
      try {
        const saveLabel = origin === "agent" ? "Submit section review" : "Save revised section";
        await click(container, saveLabel);
        expect(request).not.toHaveBeenCalled();
        await click(container, "Record Low");
        await click(container, saveLabel);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        await vi.waitFor(() =>
          expect(container.textContent).toContain("Section judgments saved together."),
        );
        const saved = await f.read();
        expect(saved?.document.observations).toHaveLength(3);
        expect(saved?.document.observations.slice(0, 2)).toEqual(before.document.observations);
        expect(saved?.document.observations.at(-1)).toMatchObject({
          confidence: "low",
          claim: target.claim,
        });
        expect(saved?.document.observations[1]).not.toHaveProperty("confidence");
        await click(container, saveLabel);
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        request.mockRestore();
      }
    },
  );

  it("saves per-label confidence together and revises confidence without changing the claim", async () => {
    const f = await workspaceFixture(false, false, undefined, 5);
    const { container } = await openWorkspace(f);
    await setValue(control(container, "Human reviewer"), "human-ui", "input");
    await click(container, "New section at playhead");
    for (const tag of ["a", "b", "c", "d", "e"]) {
      await setSlider(container, `synthetic-${tag}`, "1");
      expect(confidenceControl(container, tag).checked).toBe(false);
    }
    for (const tag of ["a", "b", "c", "d", "e"]) await setConfidence(container, tag, true);
    await setConfidence(container, "c", false);
    await click(container, "Save section judgments");
    const first = await f.read();
    expect(first?.document.observations.map((entry) => entry.confidence)).toEqual([
      "high",
      "high",
      "low",
      "high",
      "high",
    ]);
    expect(first?.document.observations.every((entry) => !("confidence" in entry.claim))).toBe(
      true,
    );
    const a = first?.document.observations[0];
    if (!a) throw new Error("Missing first human label.");
    await openHumanObservation(container, 0);
    await setConfidence(container, "a", false);
    await click(container, "Save revised section");
    const revised = await f.read();
    expect(revised?.document.observations).toHaveLength(6);
    expect(revised?.document.observations.at(-1)).toMatchObject({
      confidence: "low",
      claim: a.claim,
      supersedesObservationId: a.id,
    });
    expect(revised?.document.observations.slice(0, 5)).toEqual(first?.document.observations);
    await click(container, "Save revised section");
    expect((await f.read())?.document).toEqual(revised?.document);
    await setConfidence(container, "a", true);
    await setSlider(container, "synthetic-a", "2");
    expect(confidenceControl(container, "a").checked).toBe(false);
    expect(confidenceControl(container, "b").checked).toBe(true);
  });

  it("keeps historical confidence unset until an explicit confidence-only human revision", async () => {
    const f = await workspaceFixture(false, false, undefined, 5);
    const initial = await f.read();
    if (!initial) throw new Error("Missing workspace.");
    const historical = await f.directory.addObservations(f.sourceBytes, initial.version, {
      humanId: "historical-human",
      claims: [f.claim],
    });
    const { container } = await openWorkspace(f);
    await openHumanObservation(container, 0);
    await setValue(control(container, "Human reviewer"), "human-ui", "input");
    expect(confidenceControl(container, "a").checked).toBe(false);
    expect(container.textContent).toContain("Confidence not specified");
    await click(container, "Save revised section");
    expect((await f.read())?.document).toEqual(historical.document);
    await setConfidence(container, "a", true);
    await click(container, "Save revised section");
    const saved = await f.read();
    expect(saved?.document.observations).toHaveLength(2);
    expect(saved?.document.observations[0]).not.toHaveProperty("confidence");
    expect(saved?.document.observations[1]).toMatchObject({
      confidence: "high",
      claim: historical.document.observations[0]?.claim,
      supersedesObservationId: historical.document.observations[0]?.id,
    });
  });

  it("resets only scope-normalized High judgments when reopening legacy section cuts", async () => {
    const f = await workspaceFixture(true, false, undefined, 5);
    const initial = await f.read();
    if (!initial || !f.handoff) throw new Error("Missing fixture handoff.");
    const imported = await f.directory.importHandoff(f.sourceBytes, initial.version, f.handoff);
    const first = await f.directory.decide(f.sourceBytes, imported.stored.version, {
      handoffId: f.handoff.handoffId,
      claimId: "claim-b",
      disposition: "accepted",
      humanId: "fixture-human",
      confidence: "high",
    });
    const { transition: _transition, ...claim } = f.claim;
    const before = await f.directory.decide(f.sourceBytes, first.version, {
      handoffId: f.handoff.handoffId,
      claimId: "claim-a",
      disposition: "modified",
      humanId: "fixture-human",
      confidence: "high",
      modifiedClaim: {
        ...claim,
        scope: { startMs: 1100, endMs: 1750 },
        evidence: {
          ...claim.evidence,
          noteRefs: claim.evidence.noteRefs.filter((note) => note.endMs >= 1100),
        },
      },
    });
    const { container } = await openWorkspace(f);
    await setValue(control(container, "Human reviewer"), "human-ui", "input");
    await chooseProposal(container, "synthetic-a");
    expect(confidenceControl(container, "a").checked).toBe(true);
    expect(confidenceControl(container, "b").checked).toBe(false);
    await settleUnratedDimensions(container);
    await click(container, "Submit section review");
    const after = await f.read();
    expect(after?.document.observations.slice(0, before.document.observations.length)).toEqual(
      before.document.observations,
    );
    const b = after?.document.observations
      .filter((entry) => entry.claim.tagId === "synthetic-b")
      .at(-1);
    expect(b).toMatchObject({
      confidence: "low",
      claim: { scope: { startMs: 1100, endMs: 1750 } },
    });
    expect(
      after?.document.observations.filter((entry) => entry.claim.tagId === "synthetic-a"),
    ).toHaveLength(1);
  });

  it("records selection actions through normal section saves without explanation or extra review steps", async () => {
    const f = await workspaceFixture(false, false, undefined, 5);
    const { container } = await openWorkspace(f);
    await setValue(control(container, "Human reviewer"), "human-ui", "input");
    await setValue(control(container, "Source time"), "1000", "input");
    await click(container, "New section at playhead");
    for (const tag of ["a", "b", "c", "d", "e"])
      await setSlider(container, `synthetic-${tag}`, "1");
    await chooseAssessment(container, "synthetic-a");
    await click(container, "Use arrangement in claim scope");
    await setValue(control(container, "Click notes to toggle"), "contextNoteRefs");
    await toggleWitness(container, 1);
    expect(container.textContent).not.toContain("I reviewed selected and unselected notes");
    expect(container.textContent).not.toContain("I reviewed the explanation");
    expect(container.textContent).not.toContain("Save evidence review for this judgment");
    expect(control(container, "Evidence / judgment rationale").value).toBe("");
    await click(container, "Save section judgments");
    const saved = await f.read();
    expect(saved?.document.observations).toHaveLength(5);
    const a = saved?.document.observations.find((entry) => entry.claim.tagId === "synthetic-a");
    expect(a?.evidenceReview).toEqual({
      selectionOrigin: "new-human",
      operations: [
        { kind: "auto-scope-fill", target: "witness" },
        { kind: "explicit-scope-selection", target: "witness" },
        { kind: "manual-note-edit", target: "context" },
      ],
    });
    if (!a) throw new Error("Missing saved observation.");
    await openHumanObservation(container, 0);
    expect(container.textContent).toContain("Selection source: Previous human observation");
    const removeWitness = container.querySelector<HTMLButtonElement>(
      '.claim-fields button[aria-label^="Remove witness"]',
    );
    if (!removeWitness) throw new Error("Missing selected witness.");
    removeWitness.click();
    await nextTick();
    await click(container, "Save revised section");
    const revised = await f.read();
    expect(revised?.document.observations).toHaveLength(6);
    expect(revised?.document.observations.at(-1)).toMatchObject({
      claim: { assessment: a.claim.assessment, evidence: { rationale: "" } },
      supersedesObservationId: a.id,
      evidenceReview: {
        selectionOrigin: "inherited-human",
        sourceObservationId: a.id,
        operations: [{ kind: "manual-note-edit", target: "witness" }],
      },
    });
    expect(revised?.document.observations.at(-1)?.evidenceReview).not.toHaveProperty(
      "selectionReviewed",
    );
    expect(revised?.document.observations.at(-1)?.evidenceReview).not.toHaveProperty(
      "rationaleReviewed",
    );
    expect(revised?.document.observations.slice(0, 5)).toEqual(saved?.document.observations);
    await openHumanObservation(container, 5);
    await click(container, "Save revised section");
    expect((await f.read())?.document).toEqual(revised?.document);
  });

  it("clears old optional prose on note and linked range edits without creating review obligations", async () => {
    const f = await workspaceFixture(false, false, undefined, 5);
    const { container } = await openWorkspace(f);
    await setValue(control(container, "Source time"), "1000", "input");
    await click(container, "New section at playhead");
    await setSlider(container, "synthetic-a", "1");
    await setValue(
      control(container, "Evidence / judgment rationale"),
      "Before witness edit.",
      "input",
    );
    const removeWitness = container.querySelector<HTMLButtonElement>(
      '.claim-fields button[aria-label^="Remove witness"]',
    );
    removeWitness?.click();
    await nextTick();
    expect(control(container, "Evidence / judgment rationale").value).toBe("");
    expect(container.textContent).toContain("Edited witnesses");
    await setValue(
      control(container, "Evidence / judgment rationale"),
      "Before range edit.",
      "input",
    );
    await setSlider(container, "synthetic-b", "1");
    await setValue(
      control(container, "Evidence / judgment rationale"),
      "Sibling before range edit.",
      "input",
    );
    const ranges = container.querySelectorAll<HTMLInputElement>(
      '.claim-fields input[type="number"]',
    );
    await setValue(ranges[0], "1100");
    expect(control(container, "Evidence / judgment rationale").value).toBe("");
    await chooseAssessment(container, "synthetic-a");
    expect(control(container, "Evidence / judgment rationale").value).toBe("");
  });

  it.each([undefined, 0.5, 1.5] as const)(
    "shows calibration rate %s and played duration while keeping source coordinates",
    async (rate) => {
      const f = await workspaceFixture(false, false, rate);
      const before = await f.read();
      const { container } = await openWorkspace(f);
      const duration = ((f.claim.scope.endMs - f.claim.scope.startMs) / (rate ?? 1) / 1000).toFixed(
        3,
      );
      const contextDuration = (
        (f.claim.reviewContext.endMs - f.claim.reviewContext.startMs) /
        (rate ?? 1) /
        1000
      ).toFixed(3);
      const listed = container.querySelector(".review-calibration-example");
      expect(listed?.textContent).toContain(`${rate ?? 1}×`);
      expect(listed?.textContent).toContain(
        `${f.claim.scope.startMs}–${f.claim.scope.endMs} source ms`,
      );
      expect(listed?.textContent).toContain(`Claim duration ${duration} s`);
      await click(container, "View exact source evidence");
      const focused = container.querySelector(".review-calibration");
      expect(focused?.querySelector("h2")?.textContent).toContain(`${rate ?? 1}×`);
      expect(focused?.textContent).toContain(
        `Claim ${f.claim.scope.startMs}–${f.claim.scope.endMs} source ms`,
      );
      expect(focused?.textContent).toContain(
        `claim duration ${duration} s · context duration ${contextDuration} s`,
      );
      expect(focused?.textContent).toContain(
        "Static source evidence; playback is unavailable in this view.",
      );
      expect(control(container, "Playback rate").value).toBe(String(rate ?? 1));
      expect(control(container, "Playback rate").disabled).toBe(true);
      await click(container, "Return to difficulty review");
      expect(control(container, "Playback rate").value).toBe("1");
      expect(await f.read()).toEqual(before);
    },
  );

  it("creates separate judgments at every supported rate and revises only the selected rate", async () => {
    const f = await workspaceFixture();
    const initial = await f.read();
    if (!initial) throw new Error("Missing review.");
    const first = await f.directory.addObservations(f.sourceBytes, initial.version, {
      claims: [{ ...f.claim, assessment: { presence: "absent" } }],
      humanId: "fixture-human",
    });
    const original = first.document.observations[0];
    const { container } = await openWorkspace(f);
    await setValue(control(container, "Human reviewer"), "fixture-human", "input");
    const observations = () =>
      [...container.querySelectorAll(".review-source details")].find((entry) =>
        entry.querySelector("summary")?.textContent?.startsWith("Human observations"),
      );
    for (const rate of [0.5, 0.75, 1.25, 1.5]) {
      observations()?.querySelector<HTMLButtonElement>("button")?.click();
      await nextTick();
      expect(control(container, "Playback rate").value).toBe("1");
      await setValue(control(container, "Playback rate"), String(rate));
      expect(control(container, "Assessment").disabled).toBe(true);
      expect(button(container, "Save revised section").disabled).toBe(true);
      expect(container.textContent).toContain(`Playing ${rate}× · this judgment is for 1×`);
      await click(container, `Create judgment at ${rate}×`);
      expect(control(container, "Assessment").value).toBe("unreviewed");
      await setValue(control(container, "Assessment"), "present");
      await setValue(
        control(container, "Evidence / judgment rationale"),
        `Observed at ${rate}x`,
        "input",
      );
      await click(container, "Save section judgments");
      const saved = await f.read();
      const observation = saved?.document.observations.at(-1);
      expect(observation?.claim.playbackRate).toBe(rate);
      expect(observation?.claim.scope).toEqual(f.claim.scope);
      expect(observation?.claim.reviewContext).toEqual(f.claim.reviewContext);
      expect(observation?.claim.id).not.toBe(f.claim.id);
      expect(observation?.supersedesObservationId).toBeUndefined();
      await setValue(control(container, "Salience"), "supporting");
      await click(container, "Save revised section");
      const revised = (await f.read())?.document.observations.at(-1);
      expect(revised?.claim.playbackRate).toBe(rate);
      expect(revised?.supersedesObservationId).toBe(observation?.id);
      expect((await f.read())?.document.observations[0]).toEqual(original);
    }
    expect((await f.read())?.document.observations).toHaveLength(9);
    expect((await f.read())?.document.decisions).toHaveLength(0);
  });

  it("opens complete section drafts at the proposal rate and blocks review at a different audition rate", async () => {
    const f = await workspaceFixture(true);
    if (!f.task || !f.handoff) throw new Error("Missing task.");
    const handoff = await sealHandoffV2(f.task, {
      handoffId: "rate-handoff",
      createdAt: NOW,
      agent: f.handoff.agent,
      proposals: [
        { ...f.claim, sectionId: "same-section", playbackRate: 1.25 },
        {
          ...f.claim,
          id: "same-rate",
          tagId: "synthetic-b",
          sectionId: "same-section",
          playbackRate: 1.25,
        },
        {
          ...f.claim,
          id: "other-rate",
          tagId: "synthetic-b",
          sectionId: "same-section",
          playbackRate: 0.5,
        },
      ],
      audit: [],
      questions: [],
    });
    const current = await f.read();
    if (!current) throw new Error("Missing review.");
    const imported = await f.directory.importHandoff(f.sourceBytes, current.version, handoff);
    const { container } = mountRemote(f, imported.stored, {
      handoffId: handoff.handoffId,
      claimId: f.claim.id,
    });
    await vi.waitFor(() =>
      expect(container.querySelectorAll('.section-sliders input[type="range"]')).toHaveLength(9),
    );
    await setValue(control(container, "Human reviewer"), "fixture-human", "input");
    expect(control(container, "Playback rate").value).toBe("1.25");
    expect(slider(container, "synthetic-a").getAttribute("aria-valuetext")).toBe("Prominent");
    expect(slider(container, "synthetic-b").getAttribute("aria-valuetext")).toBe("Prominent");
    await settleUnratedDimensions(container);
    expect(button(container, "Submit section review").disabled).toBe(false);
    await setValue(control(container, "Playback rate"), "0.5");
    expect(button(container, "Submit section review").disabled).toBe(true);
    expect(
      [...container.querySelectorAll<HTMLInputElement>(".section-sliders input")].every(
        (input) => input.disabled,
      ),
    ).toBe(true);
    await click(container, "Return to judgment rate");
    expect(control(container, "Playback rate").value).toBe("1.25");
    expect(button(container, "Submit section review").disabled).toBe(false);
    await chooseAssessment(container, "synthetic-b");
    expect(control(container, "Playback rate").value).toBe("1.25");
    expect((await f.read())?.document.decisions).toEqual([]);
  });

  it("changes source spacing with rate while preserving the chosen visual scroll speed", async () => {
    const f = await workspaceFixture();
    const { container } = await openWorkspace(f);
    const noteSpread = () => {
      const positions = [...container.querySelectorAll(".falling-note")].map((note) =>
        Number(note.getAttribute("y")),
      );
      return Math.max(...positions) - Math.min(...positions);
    };
    const originalSpacing = noteSpread();
    expect(originalSpacing).toBeGreaterThan(0);
    await setValue(control(container, "Playback rate"), "0.5");
    expect(noteSpread()).toBeCloseTo(originalSpacing * 2);
    expect(control(container, "Visual speed").value).toBe("240");
    await setValue(control(container, "Playback rate"), "1.5");
    expect(noteSpread()).toBeCloseTo(originalSpacing / 1.5);
    expect(control(container, "Visual speed").value).toBe("240");
  });

  it("retains drafts separately when comparing rates", async () => {
    const f = await workspaceFixture();
    const { container } = await openWorkspace(f);
    await click(container, "New section at playhead");
    await setValue(
      control(container, "Evidence / judgment rationale"),
      "Original rate draft",
      "input",
    );
    await setValue(control(container, "Playback rate"), "0.5");
    await click(container, "Create judgment at 0.5×");
    await setValue(control(container, "Evidence / judgment rationale"), "Half-rate draft", "input");
    await setValue(control(container, "Playback rate"), "0.75");
    await click(container, "Create judgment at 0.75×");
    await setValue(control(container, "Playback rate"), "0.5");
    await click(container, "Restore section draft");
    expect(control(container, "Evidence / judgment rationale").value).toBe("Half-rate draft");
    expect(control(container, "Playback rate").value).toBe("0.5");
    await setValue(control(container, "Playback rate"), "1");
    await click(container, "Restore section draft");
    expect(control(container, "Evidence / judgment rationale").value).toBe("Original rate draft");
    expect(control(container, "Playback rate").value).toBe("1");
  });

  it("shows remote evidence context separately and permits human review without an agent reread", async () => {
    const f = await workspaceFixture(true);
    if (!f.handoff) throw new Error("Missing handoff.");
    const initial = await f.read();
    if (!initial) throw new Error("Missing review.");
    const imported = await f.directory.importHandoff(f.sourceBytes, initial.version, f.handoff);
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(ReviewWorkspace, {
      remoteSource: {
        ...imported.stored,
        sourceBytes: Array.from(f.sourceBytes),
        handoffTrust: {
          [f.handoff.handoffId]: {
            source: "current",
            foundation: "current",
            humanContext: "changed",
          },
        },
      },
      openClaim: { handoffId: f.handoff.handoffId, claimId: "claim-a" },
    });
    app.config.errorHandler = (error) => appErrors.push(error);
    apps.push(app);
    app.mount(container);
    await vi.waitFor(() => expect(container.textContent).toContain("Human examples changed"));
    await setValue(control(container, "Human reviewer"), "fixture-human", "input");
    expect(control(container, "Assessment").disabled).toBe(false);
    expect(button(container, "Submit section review").disabled).toBe(true);
    await settleUnratedDimensions(container);
    expect(button(container, "Submit section review").disabled).toBe(false);
    const golden = container.querySelector<HTMLAnchorElement>(".review-golden-link");
    expect(golden?.getAttribute("href")).toBe("/review?view=golden&tag=synthetic-i");
    expect(golden?.target).toBe("_blank");
    expect(golden?.rel).toContain("noopener");
    expect((await f.read())?.document.decisions).toEqual([]);
  });

  it("reopens the latest saved proposal judgment and appends a human revision", async () => {
    const f = await workspaceFixture(true);
    if (!f.handoff) throw new Error("Missing handoff.");
    const initial = await f.read();
    if (!initial) throw new Error("Missing review.");
    const imported = await f.directory.importHandoff(f.sourceBytes, initial.version, f.handoff);
    const { transition: _transition, ...revisedClaim } = f.claim;
    const first = await f.directory.decide(f.sourceBytes, imported.stored.version, {
      handoffId: f.handoff.handoffId,
      claimId: "claim-a",
      disposition: "modified",
      humanId: "fixture-human",
      modifiedClaim: {
        ...revisedClaim,
        assessment: { presence: "absent" },
        scope: { startMs: 1100, endMs: 1750 },
        reviewContext: { startMs: 200, endMs: 1801 },
        evidence: {
          ...f.claim.evidence,
          noteRefs: f.claim.evidence.noteRefs.filter((note) => note.endMs >= 1100),
        },
      },
      rationale: "First synthetic revision.",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(ReviewWorkspace, {
      remoteSource: { ...first, sourceBytes: Array.from(f.sourceBytes) },
      openClaim: { handoffId: f.handoff.handoffId, claimId: "claim-a" },
    });
    app.config.errorHandler = (error) => appErrors.push(error);
    apps.push(app);
    app.mount(container);
    await vi.waitFor(() =>
      expect(container.querySelectorAll('.section-sliders input[type="range"]')).toHaveLength(9),
    );
    await setValue(control(container, "Human reviewer"), "fixture-human", "input");
    expect(control(container, "Source time").value).toBe("200");
    expect(control(container, "Assessment").value).toBe("absent");
    expect(rangeValues(container)).toEqual(["1100", "1750", "200", "1801"]);
    expect(
      container.querySelectorAll('.claim-fields button[aria-label^="Remove witness"]'),
    ).toHaveLength(2);
    expect(control(container, "Assessment").disabled).toBe(false);
    await setSlider(container, "synthetic-a", "1");
    await settleUnratedDimensions(container);
    await chooseAssessment(container, "synthetic-a");
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      expect(String(url)).toContain("/decideSection");
      const body = JSON.parse(String(options?.body));
      return Response.json(
        await f.directory.decideSection(f.sourceBytes, body.expectedBase, body.input),
      );
    });
    try {
      await click(container, "Submit section review");
      await vi.waitFor(() => expect(container.textContent).toContain("Human decision history · 2"));
      const final = await f.read();
      expect(final?.document.decisions[0]).toEqual(first.document.decisions[0]);
      expect(final?.document.observations[0]).toEqual(first.document.observations[0]);
      expect(
        final?.document.observations.filter((entry) => entry.claim.id === "claim-a").at(-1)?.claim
          .assessment,
      ).toEqual({ presence: "present", salience: "supporting" });
      expect(final?.document.handoffs).toEqual(first.document.handoffs);
      const observationList = [...container.querySelectorAll(".review-source details")].find(
        (entry) => entry.querySelector("summary")?.textContent?.startsWith("Human observations"),
      );
      observationList?.querySelector<HTMLButtonElement>("button")?.click();
      await nextTick();
      expect(container.textContent).toContain("Historical human judgment");
      expect(control(container, "Assessment").value).toBe("absent");
      expect(control(container, "Assessment").disabled).toBe(true);
      await click(container, "View current judgment");
      expect(control(container, "Assessment").value).toBe("present");
      expect(control(container, "Salience").value).toBe("supporting");
      expect(button(container, "Submit section review").disabled).toBe(false);
      observationList?.querySelector<HTMLButtonElement>("button")?.click();
      await nextTick();
      await click(container, "Revise current judgment using this version");
      expect(control(container, "Assessment").value).toBe("absent");
      expect(control(container, "Assessment").disabled).toBe(false);
      await click(container, "Submit section review");
      const restored = await f.read();
      expect(restored?.document.decisions).toHaveLength(
        (final?.document.decisions.length ?? 0) + 1,
      );
      expect(restored?.document.observations.at(-1)?.claim.assessment).toEqual({
        presence: "absent",
      });
      expect(restored?.document.observations.slice(0, -1)).toEqual(final?.document.observations);
    } finally {
      request.mockRestore();
    }
  });

  it("revises direct saved gold append-only and retains its observation history", async () => {
    const f = await workspaceFixture();
    const initial = await f.read();
    if (!initial) throw new Error("Missing review.");
    const first = await f.directory.addObservations(f.sourceBytes, initial.version, {
      claims: [{ ...f.claim, assessment: { presence: "absent" } }],
      humanId: "fixture-human",
    });
    const { container } = await openWorkspace(f);
    await setValue(control(container, "Human reviewer"), "fixture-human", "input");
    await click(container, "New section at playhead");
    await setValue(
      control(container, "Evidence / judgment rationale"),
      "Unrelated direct draft stays saved.",
      "input",
    );
    const observations = [...container.querySelectorAll(".review-source details")].find((entry) =>
      entry.querySelector("summary")?.textContent?.startsWith("Human observations"),
    );
    observations?.querySelector<HTMLButtonElement>("button")?.click();
    await nextTick();
    expect(control(container, "Assessment").value).toBe("absent");
    expect(control(container, "Assessment").disabled).toBe(false);
    await setValue(control(container, "Assessment"), "present");
    await setValue(control(container, "Salience"), "supporting");
    await click(container, "Save revised section");
    const final = await f.read();
    expect(final?.document.observations).toHaveLength(2);
    expect(final?.document.observations[0]).toEqual(first.document.observations[0]);
    expect(final?.document.observations[1]?.supersedesObservationId).toBe(
      first.document.observations[0]?.id,
    );
    expect(final?.document.observations[1]?.claim.assessment).toEqual({
      presence: "present",
      salience: "supporting",
    });
    expect(container.querySelector(".review-observation-history")?.textContent).toContain(
      "Human observation history · 2",
    );
    observations?.querySelector<HTMLButtonElement>("button")?.click();
    await nextTick();
    expect(container.textContent).toContain("Historical human judgment");
    expect(control(container, "Assessment").value).toBe("absent");
    await click(container, "View current judgment");
    expect(control(container, "Assessment").value).toBe("present");
    expect(control(container, "Salience").value).toBe("supporting");
    observations?.querySelector<HTMLButtonElement>("button")?.click();
    await nextTick();
    await click(container, "Revise current judgment using this version");
    expect(control(container, "Assessment").value).toBe("absent");
    await click(container, "Save revised section");
    const restored = await f.read();
    expect(restored?.document.observations).toHaveLength(3);
    expect(restored?.document.observations.at(-1)?.supersedesObservationId).toBe(
      final?.document.observations[1]?.id,
    );
    expect(restored?.document.observations.slice(0, 2)).toEqual(final?.document.observations);
    await click(container, "Restore section draft");
    expect(control(container, "Evidence / judgment rationale").value).toBe(
      "Unrelated direct draft stays saved.",
    );
  });

  it("keeps saved judgments and drafts separate when frozen versions reuse claim IDs", async () => {
    const f = await workspaceFixture(true);
    if (!f.task) throw new Error("Missing task.");
    let current = await f.read();
    if (!current) throw new Error("Missing review.");
    for (const hash of ["a", "b"]) {
      const handoff = await sealHandoffV2(f.task, {
        handoffId: `version-${hash}`,
        createdAt: NOW,
        agent: {
          role: "labeler",
          producerId: `labeler-${hash}`,
          skill: { name: "judgment", version: "same-name", sha256: hash.repeat(64) },
        },
        proposals: [
          { ...f.claim, assessment: hash === "a" ? { presence: "absent" } : f.claim.assessment },
        ],
        audit: [],
        questions: [],
      });
      current = (await f.directory.importHandoff(f.sourceBytes, current.version, handoff)).stored;
    }
    current = await f.directory.decide(f.sourceBytes, current.version, {
      handoffId: "version-a",
      claimId: f.claim.id,
      disposition: "accepted",
      humanId: "fixture-human",
      rationale: "Saved earlier version A.",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(ReviewWorkspace, {
      remoteSource: { ...current, sourceBytes: Array.from(f.sourceBytes) },
      openClaim: { handoffId: "version-b", claimId: f.claim.id },
    });
    app.config.errorHandler = (error) => appErrors.push(error);
    apps.push(app);
    app.mount(container);
    await vi.waitFor(() =>
      expect(container.querySelector(".review-audit-result")?.textContent).toContain(
        "same-name · bbbbbbbb",
      ),
    );
    expect(slider(container, "synthetic-a").getAttribute("aria-valuetext")).toBe("Prominent");
    await setSlider(container, "synthetic-a", "1");
    expect(container.querySelector(".review-related-history")?.textContent).toContain(
      "same-name · aaaaaaaa",
    );
    (container.querySelector(".review-related-history button") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(container.querySelector(".review-audit-result details > p")?.textContent).toContain(
        "Labeler judgment · same-name · aaaaaaaa",
      ),
    );
    expect(slider(container, "synthetic-a").getAttribute("aria-valuetext")).toBe("Absent");
    await setSlider(container, "synthetic-a", "2");
    (container.querySelector(".review-related-history button") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(container.querySelector(".review-audit-result")?.textContent).toContain(
        "same-name · bbbbbbbb",
      ),
    );
    expect(slider(container, "synthetic-a").getAttribute("aria-valuetext")).toBe("Supporting");
    (container.querySelector(".review-related-history button") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(container.querySelector(".review-audit-result")?.textContent).toContain(
        "same-name · aaaaaaaa",
      ),
    );
    expect(slider(container, "synthetic-a").getAttribute("aria-valuetext")).toBe("Prominent");
    expect((await f.read())?.document).toEqual(current.document);
    expect((await f.read())?.version).toEqual(current.version);
  });

  it("uses Inspector audio preferences, saves offset changes, and loads the source audio URL", async () => {
    preferences.value = {
      annotatorId: "inspector-user",
      visualSpeed: 360,
      musicEnabled: true,
      audioOffsetMs: 45,
    };
    const loadAudio = vi
      .spyOn(AudioPlaybackController.prototype, "loadAudioUrl")
      .mockResolvedValue();
    const f = await workspaceFixture();
    const current = await f.read();
    if (!current) throw new Error("Missing review.");
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(ReviewWorkspace, {
      remoteSource: {
        ...current,
        sourceBytes: Array.from(f.sourceBytes),
        audio: { url: "/api/review/audio/fixture", filename: "song.mp3" },
      },
    });
    app.config.errorHandler = (error) => appErrors.push(error);
    apps.push(app);
    app.mount(container);
    await vi.waitFor(() => expect(loadAudio).toHaveBeenCalledWith("/api/review/audio/fixture"));
    expect(control(container, "Global audio offset").value).toBe("45");
    expect(control(container, "Volume").value).toBe("80");
    const setVolume = vi.spyOn(AudioPlaybackController.prototype, "setAudioVolume");
    await setValue(control(container, "Volume"), "35", "input");
    expect(setVolume).toHaveBeenLastCalledWith(0.35);
    expect(control(container, "Visual speed").value).toBe("360");
    expect(
      container.querySelector('.review-transport button[aria-pressed="true"]')?.textContent,
    ).toBe("Music on");
    await click(container, "+10 ms");
    await click(container, "Music on");
    await setValue(control(container, "Visual speed"), "480");
    await vi.waitFor(() =>
      expect(preferences.value).toEqual({
        annotatorId: "inspector-user",
        visualSpeed: 480,
        musicEnabled: false,
        audioOffsetMs: 55,
        audioVolume: 0.35,
      }),
    );
    let finishEnable: (() => void) | undefined;
    const enabling = new Promise<void>((resolve) => {
      finishEnable = resolve;
    });
    const setMusic = AudioPlaybackController.prototype.setMusicEnabled;
    vi.spyOn(AudioPlaybackController.prototype, "setMusicEnabled").mockImplementation(
      async function (this: AudioPlaybackController, enabled) {
        await setMusic.call(this, enabled);
        if (enabled) await enabling;
      },
    );
    await click(container, "Music off");
    await click(container, "Music on");
    finishEnable?.();
    await vi.waitFor(() => expect(preferences.value?.musicEnabled).toBe(false));
    expect((await f.read())?.document).toEqual(current.document);
  });

  it("opens the next review at its marked section and starts music there", async () => {
    const media: ReviewTestAudio[] = [];
    vi.stubGlobal(
      "Audio",
      class extends ReviewTestAudio {
        constructor() {
          super();
          media.push(this);
        }
      },
    );
    preferences.value = {
      annotatorId: "inspector-user",
      visualSpeed: 240,
      musicEnabled: true,
      audioOffsetMs: 45,
    };
    const f = await workspaceFixture();
    const initial = await f.read();
    if (!initial) throw new Error("Missing review.");
    const remote = shallowRef<RemoteSourceV2>({
      ...initial,
      sourceBytes: Array.from(f.sourceBytes),
      audio: { url: "/api/review/audio/first", filename: "first.mp3" },
    });
    const openClaim = shallowRef<{ handoffId: string; claimId: string }>();
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp({
      render: () =>
        h(ReviewWorkspace, {
          remoteSource: remote.value,
          ...(openClaim.value ? { openClaim: openClaim.value } : {}),
        }),
    });
    app.config.errorHandler = (error) => appErrors.push(error);
    apps.push(app);
    app.mount(container);
    await vi.waitFor(() => expect(media).toHaveLength(1));
    await setValue(control(container, "Source time"), "1400", "input");
    expect(media[0]?.currentTime).toBe(1.445);
    const bytes = new TextEncoder().encode(
      new TextDecoder()
        .decode(f.sourceBytes)
        .replace("Title: Workflow fixture", "Title: Next difficulty"),
    );
    const next = await f.directory.initialize(bytes, {
      ...initial.document.foundation,
      approval: { status: "proposed" },
    });
    const approved = await f.directory.approveFoundation(bytes, next.version, "fixture-human");
    const exported = await f.directory.exportTask(bytes, approved.version);
    const handoff = await sealHandoffV2(exported.task, {
      handoffId: "next-handoff",
      createdAt: NOW,
      agent: { producerId: "fixture-labeler", role: "labeler" },
      proposals: [{ ...f.claim, reviewContext: { startMs: 800, endMs: 1801 } }],
      audit: [],
      questions: [],
    });
    const imported = await f.directory.importHandoff(bytes, exported.stored.version, handoff);
    openClaim.value = { handoffId: handoff.handoffId, claimId: f.claim.id };
    remote.value = {
      ...imported.stored,
      sourceBytes: Array.from(bytes),
      audio: { url: "/api/review/audio/next", filename: "next.mp3" },
    };
    await vi.waitFor(() => expect(media).toHaveLength(2));
    expect(control(container, "Source time").value).toBe("800");
    expect(media[1]?.currentTime).toBe(0.845);
    expect(media[0]?.paused).toBe(true);
    expect(
      button(container.querySelector(".review-transport") as Element, "Play Space").disabled,
    ).toBe(false);
    await click(container.querySelector(".review-transport") as Element, "Play Space");
    expect(media[1]?.currentTime).toBe(0.845);
  });

  it("plays the exact claim once, loops it, and pauses when returning to the inbox", async () => {
    const f = await workspaceFixture(true);
    const initial = await f.read();
    if (!initial || !f.handoff) throw new Error("Missing review.");
    const imported = await f.directory.importHandoff(f.sourceBytes, initial.version, f.handoff);
    const active = shallowRef(true);
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp({
      render: () =>
        h(ReviewWorkspace, {
          active: active.value,
          remoteSource: { ...imported.stored, sourceBytes: Array.from(f.sourceBytes) },
          openClaim: { handoffId: "synthetic-handoff", claimId: "claim-a" },
        }),
    });
    app.config.errorHandler = (error) => appErrors.push(error);
    apps.push(app);
    app.mount(container);
    await vi.waitFor(() =>
      expect(
        container.querySelector<HTMLButtonElement>(".review-transport .review-primary")?.disabled,
      ).toBe(false),
    );
    const transport = container.querySelector(".review-transport") as HTMLElement;
    await click(transport, "Selection ⇧Space");
    expect(Number(control(container, "Source time").value)).toBeGreaterThanOrEqual(1000);
    await vi.waitFor(
      () => expect(transport.querySelector(".review-primary")?.textContent).toBe("Play Space"),
      { timeout: 1800 },
    );
    expect(control(container, "Source time").value).toBe("1800");
    await click(transport, "Loop L");
    expect(button(transport, "Loop L").getAttribute("aria-pressed")).toBe("true");
    expect(Number(control(container, "Source time").value)).toBeLessThan(1800);
    active.value = false;
    await nextTick();
    expect(button(transport, "Play Space").disabled).toBe(true);
    expect(button(transport, "Loop L").getAttribute("aria-pressed")).toBe("false");
    active.value = true;
    await nextTick();
    const viewport = container.querySelector(".falling-note-viewport") as Element;
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await nextTick();
    expect(transport.querySelector(".review-primary")?.textContent).toBe("Pause Space");
    await setValue(control(container, "Source time"), "400", "input");
    await click(transport, "Pause Space");
    expect(Number(control(container, "Source time").value)).toBeLessThan(500);
    control(container, "Source time").dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    await nextTick();
    expect(transport.querySelector(".review-primary")?.textContent).toBe("Play Space");
    expect((await f.read())?.document).toEqual(imported.stored.document);
  });

  it("zooms the timeline around the playhead and restores its full extent without moving the claim", async () => {
    const f = await workspaceFixture();
    const { container } = await openWorkspace(f);
    const description = () =>
      container.querySelector("#annotation-timeline-description")?.textContent;
    const initial = description();
    const range = rangeValues(container);
    const playhead = control(container, "Source time").value;
    await click(container, "Zoom in");
    expect(description()).not.toBe(initial);
    await click(container, "Zoom out");
    expect(description()).toBe(initial);
    button(container, "Zoom in").dispatchEvent(
      new KeyboardEvent("keydown", { key: "+", bubbles: true }),
    );
    await nextTick();
    expect(description()).not.toBe(initial);
    await click(container, "Fit");
    expect(description()).toBe(initial);
    expect(rangeValues(container)).toEqual(range);
    expect(control(container, "Source time").value).toBe(playhead);
  });

  it.each([false, true])(
    "retains drafts and submits despite failed saves (storage full: %s)",
    async (storageFull) => {
      const f = await workspaceFixture(true);
      if (!f.handoff) throw new Error("Missing handoff.");
      const current = await f.read();
      if (!current) throw new Error("Missing review.");
      const imported = await f.directory.importHandoff(f.sourceBytes, current.version, f.handoff);
      const { container } = mountRemote(f, imported.stored, {
        handoffId: f.handoff.handoffId,
        claimId: "claim-a",
      });
      await vi.waitFor(() =>
        expect(container.querySelectorAll('.section-sliders input[type="range"]')).toHaveLength(9),
      );
      await setValue(control(container, "Human reviewer"), "fixture-human", "input");
      await settleUnratedDimensions(container);
      await setSlider(container, "synthetic-b", "1");
      await setValue(
        control(container, "Evidence / judgment rationale"),
        "B remains supporting.",
        "input",
      );
      const storageWrite = storageFull
        ? vi.spyOn(localStorage, "setItem").mockImplementation(() => {
            throw new DOMException("Full", "QuotaExceededError");
          })
        : undefined;
      await setConfidence(container, "b", true);
      if (storageFull)
        expect(container.textContent).toContain("Browser draft storage is unavailable");
      const beforeSave = sectionAssessments(container);
      const playhead = control(container, "Source time").value;
      const range = rangeValues(container);
      let fail = true;
      let releaseSave: () => void = () => {};
      let saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
        expect(String(url)).toContain("/decideSection");
        const body = JSON.parse(String(options?.body));
        expect(body.input.decisions).toHaveLength(3);
        expect(body.input.observations).toHaveLength(6);
        await saveGate;
        if (fail) return Response.json({ error: "Save interrupted" }, { status: 500 });
        return Response.json(
          await f.directory.decideSection(f.sourceBytes, body.expectedBase, body.input),
        );
      });
      try {
        button(container, "Submit section review").click();
        await nextTick();
        expect(container.textContent).toContain("Saving section…");
        expect(sectionAssessments(container)).toEqual(beforeSave);
        expect(control(container, "Evidence / judgment rationale").value).toBe(
          "B remains supporting.",
        );
        expect(container.querySelector(".claim-fields legend")?.textContent).toBe("Synthetic B");
        expect(button(container, "Submit section review").disabled).toBe(true);
        button(container, "Submit section review").click();
        expect(request).toHaveBeenCalledTimes(1);
        expect(
          [...container.querySelectorAll<HTMLInputElement>(".section-sliders input")].every(
            (input) => !input.disabled,
          ),
        ).toBe(true);
        await setSlider(container, "synthetic-a", "0");
        const newerDraft = sectionAssessments(container);
        expect(control(container, "Source time").value).toBe(playhead);
        expect(rangeValues(container)).toEqual(range);
        expect((await f.read())?.document.decisions).toHaveLength(0);
        releaseSave();
        await vi.waitFor(() => expect(container.textContent).toContain("Save interrupted"));
        expect(sectionAssessments(container)).toEqual(newerDraft);
        expect((await f.read())?.document.observations).toHaveLength(0);
        expect(button(container, "Submit section review").disabled).toBe(false);
        fail = false;
        saveGate = Promise.resolve();
        await click(container, "Submit section review");
        expect(request).toHaveBeenCalledTimes(2);
        expect(sectionAssessments(container)).toEqual(newerDraft);
        expect(container.querySelector(".claim-fields legend")?.textContent).toBe("Synthetic A");
        expect(container.querySelector(".review-section-complete")?.textContent).toBe(
          "Section judgments saved together.",
        );
        const saved = await f.read();
        expect(saved?.document.revision).toBe(imported.stored.document.revision + 1);
        expect(
          saved?.document.decisions.map((decision) => [decision.claimId, decision.disposition]),
        ).toEqual([
          ["claim-a", "modified"],
          ["claim-b", "modified"],
          ["claim-c", "modified"],
        ]);
        expect(saved?.document.observations).toHaveLength(9);
        expect(
          saved?.document.observations.find((entry) => entry.claim.id === "claim-a")?.claim
            .assessment,
        ).toEqual({ presence: "absent" });
        expect(
          saved?.document.observations.find((entry) => entry.claim.id === "claim-b")?.claim.evidence
            .rationale,
        ).toBe("B remains supporting.");
        expect(
          saved?.document.observations.find((entry) => entry.claim.id === "claim-b")?.confidence,
        ).toBe("high");
        expect(
          Object.keys(localStorage).filter((key) => key.startsWith("beatmap-lens-review-draft:")),
        ).toHaveLength(0);
        expect(saved?.document.handoffs[0]?.handoff).toEqual(f.handoff);
        await click(container, "Submit section review");
        expect(request).toHaveBeenCalledTimes(2);
        expect((await f.read())?.document).toEqual(saved?.document);
      } finally {
        request.mockRestore();
        storageWrite?.mockRestore();
      }
    },
  );

  it("submits five sliders in one write and keeps edits made while a successful save is pending", async () => {
    const f = await workspaceFixture(true, false, undefined, 5);
    if (!f.task || !f.handoff) throw new Error("Missing task.");
    const handoff = await sealHandoffV2(f.task, {
      handoffId: "five-style-section",
      createdAt: NOW,
      agent: f.handoff.agent,
      proposals: f.task.foundation.tags.map((tag, index) => ({
        ...f.claim,
        id: `claim-${index}`,
        tagId: tag.id,
        assessment:
          index % 2 ? { presence: "present", salience: "supporting" } : { presence: "absent" },
      })),
      audit: [],
      questions: [],
    });
    const initial = await f.read();
    if (!initial) throw new Error("Missing review.");
    const imported = await f.directory.importHandoff(f.sourceBytes, initial.version, handoff);
    const { container } = mountRemote(f, imported.stored, {
      handoffId: handoff.handoffId,
      claimId: "claim-0",
    });
    await vi.waitFor(() =>
      expect(container.querySelectorAll('.section-sliders input[type="range"]')).toHaveLength(5),
    );
    expect(sectionAssessments(container)).toEqual([
      "Absent",
      "Supporting",
      "Absent",
      "Supporting",
      "Absent",
    ]);
    await setSlider(container, "synthetic-a", "2");
    let releaseSave: () => void = () => {};
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      expect(String(url)).toContain("/decideSection");
      const body = JSON.parse(String(options?.body));
      await saveGate;
      return Response.json(
        await f.directory.decideSection(f.sourceBytes, body.expectedBase, body.input),
      );
    });
    try {
      button(container, "Submit section review").click();
      await nextTick();
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).input.decisions).toHaveLength(5);
      await setSlider(container, "synthetic-b", "2");
      await setConfidence(container, "b", true);
      const newest = sectionAssessments(container);
      releaseSave();
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Your newer edits are ready to submit."),
      );
      expect(sectionAssessments(container)).toEqual(newest);
      expect(container.querySelector(".claim-fields legend")?.textContent).toBe("Synthetic B");
      expect(button(container, "Submit section review").disabled).toBe(false);
      const first = await f.read();
      expect(first?.document.decisions).toHaveLength(5);
      expect(first?.document.observations).toHaveLength(5);
      expect(
        first?.document.observations.find((entry) => entry.claim.tagId === "synthetic-b")?.claim
          .assessment,
      ).toEqual({ presence: "present", salience: "supporting" });
      await click(container, "Submit section review");
      expect(request).toHaveBeenCalledTimes(2);
      const retry = JSON.parse(String(request.mock.calls[1]?.[1]?.body));
      expect(retry.input.decisions).toHaveLength(1);
      expect(retry.input.decisions[0]).toMatchObject({
        claimId: "claim-1",
        disposition: "modified",
        confidence: "high",
      });
      const saved = await f.read();
      expect(saved?.document.observations.slice(0, 5)).toEqual(first?.document.observations);
      expect(saved?.document.observations.at(-1)?.claim.assessment).toEqual({
        presence: "present",
        salience: "prominent",
      });
      expect(saved?.document.observations.at(-1)?.confidence).toBe("high");
      expect(saved?.document.decisions.slice(0, 5)).toEqual(first?.document.decisions);
      expect(saved?.document.revision).toBe(imported.stored.document.revision + 2);
      expect(saved?.document.handoffs[0]?.handoff).toEqual(handoff);
      expect(sectionAssessments(container)).toEqual(newest);
    } finally {
      request.mockRestore();
    }
  });

  it("requires explicit judgments for unresolved and missing dimensions before a single section submission", async () => {
    const f = await workspaceFixture(true);
    if (!f.handoff) throw new Error("Missing handoff.");
    const current = await f.read();
    if (!current) throw new Error("Missing review.");
    const imported = await f.directory.importHandoff(f.sourceBytes, current.version, f.handoff);
    const { container } = mountRemote(f, imported.stored, {
      handoffId: f.handoff.handoffId,
      claimId: "claim-c",
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Unresolved proposals need an explicit judgment."),
    );
    expect(slider(container, "synthetic-c").getAttribute("aria-valuetext")).toBe("Unresolved");
    expect(slider(container, "synthetic-d").getAttribute("aria-valuetext")).toBe("Unreviewed");
    expect(button(container, "Submit section review").disabled).toBe(true);
    expect(control(container, "Human decision rationale").value).toBe("");
    await setSlider(container, "synthetic-c", "1");
    expect(button(container, "Submit section review").disabled).toBe(true);
    await settleUnratedDimensions(container);
    expect(button(container, "Submit section review").disabled).toBe(false);
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      expect(String(url)).toContain("/decideSection");
      const body = JSON.parse(String(options?.body));
      return Response.json(
        await f.directory.decideSection(f.sourceBytes, body.expectedBase, body.input),
      );
    });
    try {
      await click(container, "Submit section review");
      expect(request).toHaveBeenCalledTimes(1);
      const saved = await f.read();
      expect(
        saved?.document.decisions.map((decision) => [decision.claimId, decision.disposition]),
      ).toEqual([
        ["claim-a", "accepted"],
        ["claim-b", "accepted"],
        ["claim-c", "modified"],
      ]);
      expect(
        saved?.document.observations.find((entry) => entry.claim.id === "claim-c")?.claim
          .assessment,
      ).toEqual({ presence: "present", salience: "supporting" });
      expect(
        saved?.document.observations.filter((entry) => entry.origin.kind === "direct-human"),
      ).toHaveLength(6);
      expect(
        saved?.document.observations.every((entry) =>
          ["present", "absent"].includes(entry.claim.assessment.presence),
        ),
      ).toBe(true);
      expect(saved?.document.handoffs[0]?.handoff).toEqual(f.handoff);
    } finally {
      request.mockRestore();
    }
  });

  it("distinguishes a historical uncertain acceptance from its later direct human clarification", async () => {
    const f = await workspaceFixture(true);
    if (!f.handoff) throw new Error("Missing handoff.");
    const current = await f.read();
    if (!current) throw new Error("Missing review.");
    const imported = await f.directory.importHandoff(f.sourceBytes, current.version, f.handoff);
    const historical = historicalAcceptance(
      imported.stored.document,
      f.handoff.handoffId,
      "claim-c",
    );
    const original = historical.observations[0]?.claim;
    if (!original) throw new Error("Missing historical claim.");
    const clarified = await addHumanObservationV2(
      historical,
      {
        claim: { ...original, assessment: { presence: "present", salience: "supporting" } },
        humanId: "fixture-human",
        now: () => "2026-09-05T01:00:00.000Z",
      },
      f.sourceBytes,
    );
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(ReviewWorkspace, {
      remoteSource: {
        document: clarified,
        version: await reviewDocumentVersionV2(clarified),
        sourceBytes: Array.from(f.sourceBytes),
      },
      openClaim: { handoffId: f.handoff.handoffId, claimId: "claim-c" },
    });
    app.config.errorHandler = (error) => appErrors.push(error);
    apps.push(app);
    app.mount(container);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("This historical acceptance kept unresolved"),
    );
    expect(container.textContent).toContain("Later direct human judgment: present · supporting");
    await vi.waitFor(() => expect(container.textContent).toContain("accepted · unresolved"));
    expect(button(container, "Submit section review").disabled).toBe(true);
    await click(container, "View human clarification");
    expect(control(container, "Assessment").value).toBe("present");
    expect(control(container, "Salience").value).toBe("supporting");
    expect(control(container, "Assessment").disabled).toBe(false);
  });

  it("preserves a human draft when an independent audit arrives through the connected inbox", async () => {
    const f = await workspaceFixture(true);
    if (!f.task || !f.handoff) throw new Error("Fixture needs a task.");
    const initial = await f.read();
    if (!initial) throw new Error("Fixture needs a workspace.");
    const imported = await f.directory.importHandoff(f.sourceBytes, initial.version, f.handoff);
    const remote = shallowRef<RemoteSourceV2>({
      ...imported.stored,
      sourceBytes: Array.from(f.sourceBytes),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp({ render: () => h(ReviewWorkspace, { remoteSource: remote.value }) });
    app.config.errorHandler = (error) => appErrors.push(error);
    apps.push(app);
    app.mount(container);
    await vi.waitFor(() =>
      expect(container.querySelector(".claim-fields legend")?.textContent).toBe("Synthetic A"),
    );
    expect(container.textContent).not.toContain("Choose workspace folder");
    expect(container.textContent).not.toContain("Import agent handoff");
    await setValue(control(container, "Human reviewer"), "human-ui", "input");
    await setValue(
      control(container, "Evidence / judgment rationale"),
      "Keep my draft while the agent works.",
      "input",
    );
    await setValue(control(container, "Source time"), "1200", "input");
    const audit = await sealAuditV2(f.task, f.handoff, {
      auditId: "arriving-audit",
      createdAt: NOW,
      agent: { producerId: "parallel-auditor", role: "auditor" },
      claims: f.handoff.proposals.map((claim) =>
        claim.assessment.presence === "unresolved"
          ? {
              claimId: claim.id,
              outcome: "needs-expert",
              rationale: "Unresolved synthetic rule.",
              expertReason: "semantic-boundary",
              question: "Which interpretation applies?",
            }
          : { claimId: claim.id, outcome: "supported", rationale: "Source reviewed." },
      ),
      questions: [
        {
          questionId: "synthetic-question",
          disposition: "needs-expert",
          rationale: "Expert rule needed.",
        },
      ],
    });
    const arrived = await f.directory.importAudit(f.sourceBytes, imported.stored.version, audit);
    remote.value = { ...arrived.stored, sourceBytes: remote.value.sourceBytes };
    await nextTick();
    expect(control(container, "Evidence / judgment rationale").value).toBe(
      "Keep my draft while the agent works.",
    );
    expect(control(container, "Source time").value).toBe("1200");
    expect(container.textContent).not.toContain("earlier saved human review");
    expect(button(container, "Save section judgments").disabled).toBe(false);
    expect(arrived.stored.document.observations).toEqual([]);
  });

  it("keeps routine independent review separate from the focused expert queue and human decisions", async () => {
    const f = await workspaceFixture(true);
    if (!f.task || !f.handoff) throw new Error("Fixture needs a frozen task.");
    const audit = await sealAuditV2(f.task, f.handoff, {
      auditId: "independent-ui-audit",
      createdAt: NOW,
      agent: { producerId: "independent-reviewer", role: "auditor" },
      claims: [
        { claimId: "claim-a", outcome: "supported", rationale: "Source witnesses support A." },
        {
          claimId: "claim-b",
          outcome: "supported",
          rationale: "Source witnesses independently support B.",
        },
        {
          claimId: "claim-c",
          outcome: "needs-expert",
          rationale: "The frozen rule does not resolve this synthetic distinction.",
          expertReason: "semantic-boundary",
          question: "Which synthetic interpretation should remain unresolved?",
        },
      ],
      questions: [
        {
          questionId: "synthetic-question",
          disposition: "needs-expert",
          rationale: "The expert must settle this distinction.",
        },
      ],
    });
    const { container, app } = await openWorkspace(f);
    await upload(container, "Import agent handoff", jsonFile(f.handoff, "handoff.json"));
    await upload(container, "Import independent audit", jsonFile(audit, "audit.json"));
    await vi.waitFor(() => expect(container.textContent).toContain("Expert review · 1"));
    expect(container.textContent).toContain("2 agent-reviewed");
    expect(container.querySelector(".claim-fields legend")?.textContent).toBe("Synthetic C");
    expect(container.querySelector(".review-audit-result")?.textContent).toContain(
      audit.claims[2]?.rationale,
    );
    expect(container.querySelector<HTMLDetailsElement>(".review-all-agent-work")?.open).toBe(false);
    const reviewed = await f.read();
    expect(reviewed?.document.decisions).toEqual([]);
    expect(reviewed?.document.observations).toEqual([]);
    await setValue(control(container, "Human reviewer"), "human-ui", "input");
    await setValue(
      control(container, "Human decision rationale"),
      "Leave this specific question open.",
      "input",
    );
    const beforeDeferral = await f.read();
    if (!beforeDeferral || !f.handoff) throw new Error("Missing review.");
    await f.directory.decide(f.sourceBytes, beforeDeferral.version, {
      handoffId: f.handoff.handoffId,
      claimId: "claim-c",
      disposition: "deferred",
      humanId: "human-ui",
      rationale: control(container, "Human decision rationale").value,
    });
    await click(container, "Reload saved workspace");
    await vi.waitFor(() => expect(container.textContent).toContain("Expert review · 0"));
    await upload(container, "Import independent audit", jsonFile(audit, "audit-again.json"));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("duplicate");
    expect((await f.read())?.document.decisions).toHaveLength(1);
    expect((await f.read())?.document.observations).toEqual([]);
    unmount(app);
    const reopened = await openWorkspace(f);
    await vi.waitFor(() => expect(reopened.container.textContent).toContain("2 agent-reviewed"));
    expect(reopened.container.textContent).toContain("Expert review · 0");
  });

  it("renders undeclared, empty, multiple and legacy community correspondences without treating them as section labels", async () => {
    const f = await workspaceFixture(false, true);
    const { container } = await openWorkspace(f);
    const definition = (name: string) => {
      const element = [...container.querySelectorAll(".review-definition")].find(
        (entry) => entry.querySelector("strong")?.textContent === name,
      );
      if (!element) throw new Error(`Missing definition: ${name}`);
      return element;
    };
    for (const name of ["Synthetic A", "Synthetic B"]) {
      expect(definition(name).querySelectorAll("a")).toHaveLength(0);
      expect(definition(name).textContent).toContain("No community correspondence declared.");
    }
    expect(
      [...definition("Synthetic C").querySelectorAll("a")].map((link) => link.textContent),
    ).toEqual(["synthetic/c", "synthetic/other-community-target"]);
    expect(definition("Synthetic C").textContent).toContain(
      "A separately scoped second correspondence.",
    );
    expect(definition("Synthetic D").querySelector("a")?.textContent).toBe("synthetic/d");
    expect(container.textContent).toContain(
      "Community correspondences do not establish training equivalence.",
    );
    expect(container.querySelectorAll('.section-sliders input[type="range"]')).toHaveLength(9);
    expect((await f.read())?.document.observations).toEqual([]);
  });

  it("saves explicitly assessed dimensions together with multiple prominent positives and per-claim noncontiguous evidence", async () => {
    const f = await workspaceFixture();
    const { container, app } = await openWorkspace(f);
    await setValue(control(container, "Human reviewer"), "human-ui", "input");
    await setValue(control(container, "Source time"), "1000", "input");
    await click(container, "New section at playhead");
    expect(container.querySelectorAll('.section-sliders input[type="range"]')).toHaveLength(9);

    await setValue(control(container, "Assessment"), "present");
    await setValue(
      control(container, "Evidence / judgment rationale"),
      "Synthetic A reviewed with separate source witnesses.",
      "input",
    );
    for (const index of [0, 2, 4]) await toggleWitness(container, index);
    await setValue(control(container, "Click notes to toggle"), "contextNoteRefs");
    await toggleWitness(container, 1);
    await setValue(control(container, "Click notes to toggle"), "noteRefs");

    await chooseAssessment(container, "synthetic-b");
    await setValue(control(container, "Assessment"), "present");
    await setValue(
      control(container, "Evidence / judgment rationale"),
      "Independent synthetic B judgment.",
      "input",
    );
    await toggleWitness(container, 3);
    await chooseAssessment(container, "synthetic-c");
    await setValue(control(container, "Assessment"), "absent");
    await setValue(
      control(container, "Evidence / judgment rationale"),
      "This dimension was checked and is absent.",
      "input",
    );
    await chooseAssessment(container, "synthetic-d");
    await setValue(control(container, "Assessment"), "unresolved");
    await setValue(
      control(container, "Evidence / judgment rationale"),
      "This checked dimension remains uncertain.",
      "input",
    );

    expect((await f.read())?.document.observations).toEqual([]);
    await click(container, "Save section judgments");
    const saved = await f.read();
    const claims = saved?.document.observations.map((observation) => observation.claim) ?? [];
    expect(claims).toHaveLength(4);
    expect(sectionAssessments(container)).toEqual([
      "Prominent",
      "Prominent",
      "Absent",
      "Unresolved",
      ...Array.from({ length: 5 }, () => "Unreviewed"),
    ]);
    expect(claims.map((claim) => claim.assessment)).toEqual([
      { presence: "present", salience: "prominent" },
      { presence: "present", salience: "prominent" },
      { presence: "absent" },
      { presence: "unresolved" },
    ]);
    expect(new Set(claims.map((claim) => claim.sectionId)).size).toBe(1);
    expect(claims[0]?.evidence.noteRefs.map((ref) => ref.startMs)).toEqual([200, 1000, 1500]);
    expect(claims[0]?.evidence.contextNoteRefs.map((ref) => ref.startMs)).toEqual([800]);
    expect(claims[1]?.evidence.noteRefs.map((ref) => ref.startMs)).toEqual([1200]);
    expect(claims[0]?.scope.startMs).toBe(1000);
    expect(claims[0]?.evidence.noteRefs[0]).toMatchObject({
      startMs: 200,
      endMs: 1300,
      kind: "long",
    });

    unmount(app);
    const reopened = await openWorkspace(f);
    expect(reopened.container.textContent).toContain("Human observations · 4");
    expect((await f.read())?.document.observations).toEqual(saved?.document.observations);
  });

  it("saves and reopens five direct slider judgments with source witnesses and empty optional rationales", async () => {
    const f = await workspaceFixture(false, false, undefined, 5);
    const { container, app } = await openWorkspace(f);
    await setValue(control(container, "Human reviewer"), "human-ui", "input");
    await setValue(control(container, "Source time"), "1000", "input");
    await click(container, "New section at playhead");
    for (const [tag, value] of [
      ["a", "2"],
      ["b", "1"],
      ["c", "0"],
      ["d", "2"],
      ["e", "0"],
    ] as const) {
      await setSlider(container, `synthetic-${tag}`, value);
    }
    const expected = ["Prominent", "Supporting", "Absent", "Prominent", "Absent"];
    expect(sectionAssessments(container)).toEqual(expected);
    const initial = await f.read();
    await click(container, "Save section judgments");
    const saved = await f.read();
    expect(saved?.document.revision).toBe((initial?.document.revision ?? 0) + 1);
    expect(saved?.document.observations).toHaveLength(5);
    expect(saved?.document.decisions).toHaveLength(0);
    expect(
      saved?.document.observations.every((entry) => entry.claim.evidence.rationale === ""),
    ).toBe(true);
    expect(
      saved?.document.observations.every((entry) => entry.claim.evidence.noteRefs.length > 0),
    ).toBe(true);
    expect(new Set(saved?.document.observations.map((entry) => entry.claim.sectionId)).size).toBe(
      1,
    );
    expect(new Set(saved?.document.observations.map((entry) => entry.confirmedAt)).size).toBe(1);
    unmount(app);
    const reopened = await openWorkspace(f);
    await openHumanObservation(reopened.container, 2);
    expect(sectionAssessments(reopened.container)).toEqual(expected);
    expect(
      reopened.container.querySelector(".section-sliders .slider-row.active strong")?.textContent,
    ).toBe("Synthetic C");
    expect(reopened.container.querySelector(".claim-fields legend")?.textContent).toBe(
      "Synthetic C",
    );
    expect(control(reopened.container, "Evidence / judgment rationale").value).toBe("");
    expect(control(reopened.container, "Assessment").disabled).toBe(false);
    await click(reopened.container, "Save revised section");
    expect((await f.read())?.document).toEqual(saved?.document);
  });

  it("reopens each handoff's own completed section from its human observation even when section and claim IDs match", async () => {
    const f = await workspaceFixture(true, false, undefined, 5);
    if (!f.task || !f.handoff) throw new Error("Missing task.");
    const secondHandoff = await sealHandoffV2(f.task, {
      handoffId: "other-partial-handoff",
      createdAt: NOW,
      agent: { role: "labeler", producerId: "other-producer" },
      proposals: f.handoff.proposals.map((claim) => ({
        ...claim,
        assessment:
          claim.tagId === "synthetic-a"
            ? { presence: "absent" }
            : claim.tagId === "synthetic-b"
              ? { presence: "present", salience: "supporting" }
              : { presence: "unresolved" },
      })),
      audit: [],
      questions: [],
    });
    const { container } = await openWorkspace(f);
    await setValue(control(container, "Human reviewer"), "human-ui", "input");
    await upload(container, "Import agent handoff", jsonFile(f.handoff, "first-partial.json"));
    await settleUnratedDimensions(container);
    await click(container, "Submit section review");
    const first = await f.read();
    if (!first) throw new Error("Missing first section review.");
    const firstCompletion = first.document.observations.find(
      (entry) => entry.origin.kind === "direct-human" && entry.claim.tagId === "synthetic-d",
    );
    if (!firstCompletion) throw new Error("Missing first completion.");
    const firstAssessments = ["Prominent", "Prominent", "Absent", "Absent", "Absent"];
    expect(sectionAssessments(container)).toEqual(firstAssessments);

    await upload(container, "Import agent handoff", jsonFile(secondHandoff, "second-partial.json"));
    expect(sectionAssessments(container)).toEqual([
      "Absent",
      "Supporting",
      "Unresolved",
      "Unreviewed",
      "Unreviewed",
    ]);
    await setSlider(container, "synthetic-c", "1");
    await setSlider(container, "synthetic-d", "2");
    await setSlider(container, "synthetic-e", "1");
    await click(container, "Submit section review");
    const saved = await f.read();
    if (!saved) throw new Error("Missing second section review.");
    const secondCompletion = saved.document.observations.find(
      (entry) =>
        entry.origin.kind === "direct-human" &&
        entry.claim.tagId === "synthetic-d" &&
        entry.id !== firstCompletion.id,
    );
    if (!secondCompletion) throw new Error("Missing second completion.");
    expect(secondCompletion.claim.sectionId).toBe(firstCompletion.claim.sectionId);
    expect(secondCompletion.claim.playbackRate).toBe(firstCompletion.claim.playbackRate);
    expect(secondCompletion.claim.id).not.toBe(firstCompletion.claim.id);
    expect(saved.document.observations.slice(0, first.document.observations.length)).toEqual(
      first.document.observations,
    );
    expect(saved.document.decisions.slice(0, first.document.decisions.length)).toEqual(
      first.document.decisions,
    );
    const secondAssessments = ["Absent", "Supporting", "Supporting", "Prominent", "Supporting"];
    const openCompletion = async (observationId: string, assessments: string[]) => {
      await openHumanObservation(
        container,
        saved.document.observations.findIndex((entry) => entry.id === observationId),
      );
      expect(sectionAssessments(container)).toEqual(assessments);
      expect(
        container.querySelector(".section-sliders .slider-row.active strong")?.textContent,
      ).toBe("Synthetic D");
      expect(container.querySelector(".claim-fields legend")?.textContent).toBe("Synthetic D");
      expect(container.querySelector(".review-claim-evidence summary")?.textContent).toContain(
        "Synthetic D",
      );
      expect(control(container, "Assessment").disabled).toBe(false);
      expect(button(container, "Submit section review").disabled).toBe(false);
    };
    await openCompletion(firstCompletion.id, firstAssessments);
    await openCompletion(secondCompletion.id, secondAssessments);
    await click(container, "Submit section review");
    expect((await f.read())?.document).toEqual(saved.document);
    await openCompletion(firstCompletion.id, firstAssessments);
    expect((await f.read())?.document).toEqual(saved.document);
  });

  it("recognizes prior partial decisions and submits the remaining section without rewriting accepted history", async () => {
    const f = await workspaceFixture(true);
    if (!f.handoff) throw new Error("Missing handoff.");
    const { container } = await openWorkspace(f);
    await setValue(control(container, "Human reviewer"), "human-ui", "input");
    await upload(container, "Import agent handoff", jsonFile(f.handoff, "handoff.json"));
    expect((await f.read())?.document.decisions).toEqual([]);
    expect(container.querySelector(".claim-fields legend")?.textContent).toBe("Synthetic A");
    expect(
      container.querySelectorAll('.claim-fields button[aria-label^="Remove witness"]'),
    ).toHaveLength(3);
    expect(container.textContent).toContain("200–1300 ms");
    const initial = await f.read();
    if (!initial) throw new Error("Missing review.");
    const accepted = await f.directory.decide(f.sourceBytes, initial.version, {
      handoffId: f.handoff.handoffId,
      claimId: "claim-a",
      disposition: "accepted",
      humanId: "human-ui",
      rationale: "Previously confirmed A.",
    });
    const partial = await f.directory.decide(f.sourceBytes, accepted.version, {
      handoffId: f.handoff.handoffId,
      claimId: "claim-c",
      disposition: "deferred",
      humanId: "human-ui",
      rationale: "Previously deferred C.",
    });
    await click(container, "Reload saved workspace");
    await chooseProposal(container, "synthetic-a");
    expect(slider(container, "synthetic-a").getAttribute("aria-valuetext")).toBe("Prominent");
    expect(button(container, "Submit section review").disabled).toBe(true);
    await settleUnratedDimensions(container);
    await click(container, "Submit section review");
    const decided = await f.read();
    expect(decided?.document.decisions.slice(0, 2)).toEqual(partial.document.decisions);
    expect(decided?.document.observations[0]).toEqual(partial.document.observations[0]);
    expect(
      decided?.document.decisions
        .slice(2)
        .map((decision) => [decision.claimId, decision.disposition]),
    ).toEqual([
      ["claim-b", "accepted"],
      ["claim-c", "modified"],
    ]);
    expect(decided?.document.observations).toHaveLength(9);
    expect(decided?.document.handoffs[0]?.handoff).toEqual(f.handoff);
    await upload(container, "Import agent handoff", jsonFile(f.handoff, "handoff-again.json"));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("duplicate");
    expect((await f.read())?.document).toEqual(decided?.document);
    expect(container.querySelectorAll(".review-handoff")).toHaveLength(1);
  });

  it("restores separate direct and proposal drafts after viewing an observation and rolls back a cancelled range gesture", async () => {
    const f = await workspaceFixture(true);
    const { container } = await openWorkspace(f);
    await setValue(control(container, "Human reviewer"), "human-ui", "input");
    await setSlider(container, "synthetic-a", "1");
    await setConfidence(container, "a", true);
    await setValue(
      control(container, "Evidence / judgment rationale"),
      "Unsaved direct draft.",
      "input",
    );
    await upload(container, "Import agent handoff", jsonFile(f.handoff, "handoff.json"));
    await setValue(
      control(container, "Human decision rationale"),
      "Confirmed original A.",
      "input",
    );
    const imported = await f.read();
    if (!imported || !f.handoff) throw new Error("Missing review.");
    await f.directory.decide(f.sourceBytes, imported.version, {
      handoffId: f.handoff.handoffId,
      claimId: "claim-a",
      disposition: "accepted",
      humanId: "human-ui",
      rationale: "Confirmed original A.",
    });
    await click(container, "Reload saved workspace");
    await chooseProposal(container, "synthetic-b");
    await setValue(
      control(container, "Evidence / judgment rationale"),
      "Unsaved B modification.",
      "input",
    );
    await setValue(
      control(container, "Human decision rationale"),
      "Separate draft decision rationale.",
      "input",
    );
    const numberInputs = container.querySelectorAll<HTMLInputElement>(
      '.claim-fields input[type="number"]',
    );
    await setValue(numberInputs[0], "1100");
    expect(control(container, "Evidence / judgment rationale").value).toBe("");
    await setValue(
      control(container, "Evidence / judgment rationale"),
      "Unsaved B modification.",
      "input",
    );
    const observationSection = [...container.querySelectorAll(".review-source details")].find(
      (section) => section.querySelector("summary")?.textContent?.startsWith("Human observations"),
    );
    observationSection?.querySelector<HTMLButtonElement>("button")?.click();
    await nextTick();
    expect(control(container, "Assessment").disabled).toBe(false);
    await chooseProposal(container, "synthetic-b");
    expect(control(container, "Evidence / judgment rationale").value).toBe(
      "Unsaved B modification.",
    );
    expect(control(container, "Human decision rationale").value).toBe(
      "Separate draft decision rationale.",
    );
    expect(
      container.querySelector<HTMLInputElement>('.claim-fields input[type="number"]')?.value,
    ).toBe("1100");
    await click(container, "Restore section draft");
    expect(control(container, "Evidence / judgment rationale").value).toBe("Unsaved direct draft.");

    const beforeRange = rangeValues(container);
    const svg = container.querySelector<SVGSVGElement>(".falling-note-viewport");
    if (!svg) throw new Error("Mounted evidence viewport is missing.");
    Object.defineProperty(svg, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 640,
        bottom: 900,
        width: 640,
        height: 900,
        toJSON: () => ({}),
      }),
    });
    pointer(svg, "pointerdown", 780);
    pointer(svg, "pointermove", 700);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await nextTick();
    expect(rangeValues(container)).not.toEqual(beforeRange);
    expect(confidenceControl(container, "a").checked).toBe(false);
    pointer(svg, "pointercancel", 700);
    await nextTick();
    expect(rangeValues(container)).toEqual(beforeRange);
    expect(confidenceControl(container, "a").checked).toBe(true);
    expect(control(container, "Evidence / judgment rationale").value).toBe("Unsaved direct draft.");
    expect((await f.read())?.document.observations).toHaveLength(1);
    await click(container, "I reviewed this draft against the current revision");
    await click(container, "Save section judgments");
    expect((await f.read())?.document.observations.at(-1)?.confidence).toBe("high");
  });

  it("keeps a foreign task's claimed Foundation approval out of a newly chosen canonical workspace", async () => {
    const foreign = await workspaceFixture(true);
    const root = new FakeDirectoryHandle("new-workspace");
    picker.mockResolvedValue(root);
    const { container } = mountWorkspace();
    await upload(container, "Open frozen task", jsonFile(foreign.task, "foreign-task.json"));
    await click(container, "Choose workspace folder");
    const fresh = await new WorkflowDirectoryV2(root).read(
      foreign.source.sha256,
      foreign.sourceBytes,
    );
    expect(fresh?.document.foundation.approval).toEqual({ status: "proposed" });
    expect(fresh?.document.decisions).toEqual([]);
    expect(fresh?.document.observations).toEqual([]);
    await upload(
      container,
      "Import agent handoff",
      jsonFile(foreign.handoff, "foreign-handoff.json"),
    );
    await setValue(control(container, "Human reviewer"), "human-ui", "input");
    await setValue(
      control(container, "Human decision rationale"),
      "This imported task has no local human approval.",
      "input",
    );
    await settleUnratedDimensions(container);
    expect(button(container, "Submit section review").disabled).toBe(true);
    expect(container.querySelector(".review-handoff")?.textContent).toContain("Task base: stale");
  });
});

class ReviewTestAudio extends EventTarget {
  currentTime = 0;
  duration = 10;
  paused = true;
  async play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
}

async function workspaceFixture(
  withTask = false,
  mixedCorrespondences = false,
  calibrationPlaybackRate?: PlaybackRate,
  tagCount = 9,
) {
  const f = await workflowFixture();
  const claim: ClaimV2 = { ...f.claim, id: "claim-a", tagId: "synthetic-a" };
  const foundation: FoundationV2 = {
    ...f.foundation,
    foundationId: "synthetic-ui-test",
    tags: Array.from({ length: tagCount }, (_, index) => {
      const letter = String.fromCharCode(97 + index);
      const alignment = {
        catalogueUrl: "https://example.com/synthetic-catalogue",
        externalTagId: `synthetic/${letter}`,
        relation: "related" as const,
        scope: "A test identity, not a real style alignment.",
      };
      return {
        id: `synthetic-${letter}`,
        displayName: `Synthetic ${letter.toUpperCase()}`,
        definition: "Neutral synthetic concept for workflow persistence testing only.",
        inclusionCues: ["Synthetic test evidence."],
        exclusionCues: [],
        ...(mixedCorrespondences && index === 0
          ? {}
          : mixedCorrespondences && index < 3
            ? {
                communityAlignments:
                  index === 1
                    ? []
                    : [
                        alignment,
                        {
                          ...alignment,
                          externalTagId: "synthetic/other-community-target",
                          scope: "A separately scoped second correspondence.",
                        },
                      ],
              }
            : { communityAlignment: alignment }),
      };
    }),
    calibrationExamples: [
      {
        id: "synthetic-example",
        source: f.inspected.source,
        sourceBytes: Array.from(f.sourceBytes),
        claim: {
          ...claim,
          ...(calibrationPlaybackRate === undefined
            ? {}
            : { playbackRate: calibrationPlaybackRate }),
        },
        explanation: "Synthetic fixture approval; no real style semantics are calibrated here.",
      },
    ],
  };
  const root = new FakeDirectoryHandle("test-workspace");
  const directory = new WorkflowDirectoryV2(root);
  const initial = await directory.initialize(f.sourceBytes, foundation);
  const approved = await directory.approveFoundation(
    f.sourceBytes,
    initial.version,
    "fixture-human",
  );
  const exported = withTask
    ? await directory.exportTask(f.sourceBytes, approved.version)
    : undefined;
  const handoff = exported
    ? await sealHandoffV2(exported.task, {
        handoffId: "synthetic-handoff",
        createdAt: NOW,
        agent: { producerId: "synthetic-producer", role: "labeler" },
        proposals: [
          claim,
          { ...claim, id: "claim-b", tagId: "synthetic-b" },
          { ...claim, id: "claim-c", tagId: "synthetic-c", assessment: { presence: "unresolved" } },
        ],
        audit: [
          {
            id: "synthetic-audit",
            claimIds: [claim.id],
            finding: "The referenced hold crosses the declared scope start.",
          },
        ],
        questions: [
          {
            id: "synthetic-question",
            claimIds: ["claim-c"],
            text: "Which synthetic interpretation should remain unresolved?",
          },
        ],
      })
    : undefined;
  return {
    root,
    directory,
    source: f.inspected.source,
    sourceBytes: f.sourceBytes,
    claim,
    task: exported?.task,
    handoff,
    read: () => directory.read(f.inspected.source.sha256, f.sourceBytes),
  };
}

async function openWorkspace(fixture: Awaited<ReturnType<typeof workspaceFixture>>) {
  picker.mockResolvedValue(fixture.root);
  const mounted = mountWorkspace();
  await upload(
    mounted.container,
    "Open .osu difficulties",
    new File([Uint8Array.from(fixture.sourceBytes).buffer], "synthetic.osu"),
  );
  await click(mounted.container, "Choose workspace folder");
  return mounted;
}

function mountWorkspace() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({ render: () => h(ReviewWorkspace) });
  app.config.errorHandler = (error) => appErrors.push(error);
  apps.push(app);
  app.mount(container);
  return { container, app };
}

function mountRemote(
  fixture: Awaited<ReturnType<typeof workspaceFixture>>,
  stored: Awaited<ReturnType<WorkflowDirectoryV2["initialize"]>>,
  openClaim?: { handoffId: string; claimId: string },
  openHumanObservationIds?: readonly string[],
) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(ReviewWorkspace, {
    remoteSource: { ...stored, sourceBytes: Array.from(fixture.sourceBytes) },
    ...(openClaim ? { openClaim } : {}),
    ...(openHumanObservationIds ? { openHumanObservationIds } : {}),
  });
  app.config.errorHandler = (error) => appErrors.push(error);
  apps.push(app);
  app.mount(container);
  return { container, app };
}

function syntheticName(tagId: string): string {
  return `Synthetic ${tagId.slice(-1).toUpperCase()}`;
}

function slider(container: Element, tagId: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    `.section-sliders input[aria-label="${syntheticName(tagId)} assessment"]`,
  );
  if (!input) throw new Error(`Missing section slider: ${tagId}`);
  return input;
}

async function setSlider(container: Element, tagId: string, value: string): Promise<void> {
  expect(slider(container, tagId).disabled).toBe(false);
  await setValue(slider(container, tagId), value, "input");
}

function confidenceControl(container: Element, letter: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    `input[aria-label="Synthetic ${letter.toUpperCase()} high confidence"]`,
  );
  if (!input) throw new Error("Missing confidence control.");
  return input;
}

async function setConfidence(container: Element, letter: string, high: boolean): Promise<void> {
  const input = confidenceControl(container, letter);
  expect(input.disabled).toBe(false);
  if (input.checked !== high) input.click();
  await nextTick();
}

function sectionAssessments(container: Element): string[] {
  return [...container.querySelectorAll('.section-sliders input[type="range"]')].map(
    (input) => input.getAttribute("aria-valuetext") ?? "",
  );
}

/** Explicit synthetic human judgments, never an implicit missing-to-absent conversion. */
async function settleUnratedDimensions(container: Element): Promise<void> {
  for (const input of container.querySelectorAll<HTMLInputElement>(
    '.section-sliders input[type="range"]',
  )) {
    if (["Unreviewed", "Unresolved"].includes(input.getAttribute("aria-valuetext") ?? "")) {
      expect(input.disabled).toBe(false);
      await setValue(input, "0", "input");
    }
  }
}

function unmount(app: ReturnType<typeof createApp>): void {
  app.unmount();
  apps.splice(apps.indexOf(app), 1);
}

function control(
  container: Element,
  text: string,
): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const label = [...container.querySelectorAll("label")].find((label) =>
    label.textContent?.trim().startsWith(text),
  );
  const input = label?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    "input, select, textarea",
  );
  if (!input) throw new Error(`Missing workspace control: ${text}`);
  return input;
}

function button(container: Element, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing workspace button: ${text}`);
  return found;
}

async function click(container: Element, text: string): Promise<void> {
  const target = button(container, text);
  expect(target.disabled, text).toBe(false);
  target.click();
  await idle(container);
}

async function setValue(
  input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | undefined,
  value: string,
  event = "change",
): Promise<void> {
  if (!input) throw new Error("Missing workspace input.");
  input.value = value;
  input.dispatchEvent(new Event(event, { bubbles: true }));
  await nextTick();
}

async function upload(container: Element, label: string, file: File): Promise<void> {
  const input = control(container, label);
  expect(input).toBeInstanceOf(HTMLInputElement);
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await idle(container);
}

async function idle(container: Element): Promise<void> {
  await nextTick();
  await vi.waitFor(
    () =>
      expect(container.querySelector(".review-status")?.textContent ?? "").not.toMatch(
        /Working…|Saving judgment|Saving section/,
      ),
    { interval: 5 },
  );
  await nextTick();
  expect(container.querySelector('[role="alert"]')?.textContent).toBeUndefined();
}

async function toggleWitness(container: Element, index: number): Promise<void> {
  const input = container.querySelectorAll<HTMLInputElement>(
    '.review-note-list input[type="checkbox"]',
  )[index];
  if (!input) throw new Error(`Missing source note ${index}.`);
  input.click();
  await nextTick();
}

async function openHumanObservation(container: Element, index: number): Promise<void> {
  const list = [...container.querySelectorAll(".review-source details")].find((entry) =>
    entry.querySelector("summary")?.textContent?.startsWith("Human observations"),
  );
  const target = list?.querySelectorAll<HTMLButtonElement>("button")[index];
  if (!target) throw new Error(`Missing human observation ${index}.`);
  target.click();
  await idle(container);
}

async function chooseAssessment(container: Element, tagId: string): Promise<void> {
  const target = [
    ...container.querySelectorAll<HTMLButtonElement>(".section-sliders .slider-label"),
  ].find((button) => button.getAttribute("aria-label") === `${syntheticName(tagId)} evidence`);
  if (!target) throw new Error(`Missing assessment ${tagId}.`);
  target.click();
  await nextTick();
}

async function chooseProposal(container: Element, tagId: string): Promise<void> {
  const target = [
    ...container.querySelectorAll<HTMLButtonElement>(".review-handoff .review-list-row"),
  ].find((button) => button.textContent?.startsWith(tagId));
  if (!target) throw new Error(`Missing proposal ${tagId}.`);
  target.click();
  await nextTick();
}

function rangeValues(container: Element): string[] {
  return [
    ...container.querySelectorAll<HTMLInputElement>('.claim-fields input[type="number"]'),
  ].map((input) => input.value);
}

function pointer(target: Element, type: string, clientY: number): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientY, pointerId: 1 }));
}

function jsonFile(value: unknown, name: string): File {
  return new File([JSON.stringify(value)], name, { type: "application/json" });
}
