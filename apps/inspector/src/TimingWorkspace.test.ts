// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import TimingWorkspace from "./TimingWorkspace.vue";
import { timingJson, timingRequest } from "./timing/client";
import { type BlindPassageRow, type OpenTiming, staleSessionError } from "./timing/contracts";

vi.mock("./timing/client", () => ({ timingJson: vi.fn(), timingRequest: vi.fn() }));
const engine = vi.hoisted(() => ({
  plays: 0,
  loudness: [] as number[],
  positionMs: undefined as number | undefined,
  offsets: [] as number[],
}));
vi.mock("./timing/audio-engine", () => ({
  TimingAudioEngine: class {
    readonly sampleRate: number;
    playing = false;
    constructor(sampleRate: number) {
      this.sampleRate = sampleRate;
    }
    load(channels: Float32Array[], frames: number) {
      return {
        numberOfChannels: channels.length,
        sampleRate: this.sampleRate,
        length: frames,
        getChannelData: (channel: number) => channels[channel],
      };
    }
    starting = false;
    async play() {
      engine.plays++;
      this.playing = true;
      return true;
    }
    stop() {
      this.playing = false;
      return undefined;
    }
    position(offsetMs: number) {
      engine.offsets.push(offsetMs);
      return engine.positionMs;
    }
    setVolume() {}
    setLoudnessDb(db: number) {
      engine.loudness.push(db);
    }
    latencies() {
      return { base_latency_ms: null, output_latency_ms: null };
    }
    async close() {}
  },
}));
vi.mock("./TimingStage.vue", () => ({
  default: defineComponent({
    setup(_, { expose }) {
      expose({ cancelDrag: () => false });
      return () => h("div", { class: "stage-stub" });
    },
  }),
}));

const frames = 44_100;
const server = vi.hoisted(() => ({
  live: new Set<string>(),
  opens: 0,
  colours: [3, 5],
  rates: [44_100, 44_100],
  saves: [] as Record<string, unknown>[],
}));

function row(id: string, saved: boolean, sample_rate: number, loudness = -6): BlindPassageRow {
  return {
    id,
    title: id,
    start_ms: 100.25,
    end_ms: 900,
    context_before_ms: 2000,
    context_after_ms: 2000,
    hint: "",
    flags: [],
    loudness_gain_db: loudness,
    audio: {
      handle: `a${sample_rate}`,
      format: "f32le-interleaved",
      sample_rate,
      channels: 2,
      frames,
    },
    saved,
    revealed: false,
  };
}

let app: ReturnType<typeof createApp>;
let container: HTMLElement;

beforeEach(() => {
  Object.assign(server, {
    live: new Set(),
    opens: 0,
    colours: [3, 5],
    rates: [44_100, 44_100],
    saves: [],
  });
  Object.assign(engine, { plays: 0, loudness: [], positionMs: undefined, offsets: [] });
  localStorage.setItem(
    "lens-timing-preferences",
    JSON.stringify({ setup: "DT 270 PRO · 44.1 kHz device", deviceRateHz: 44_100 }),
  );
  window.history.replaceState({}, "", "/timing?session=/s/session-01.timing.json");
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.mocked(timingJson).mockImplementation(async (operation, body) => {
    const request = body as Record<string, unknown>;
    if (operation === "open") {
      const session_id = `s${++server.opens}`;
      server.live.add(session_id);
      const opened: OpenTiming = {
        session_id,
        id: "session-01",
        clock: "osu",
        marks_path: "/s/session-01.timing.marks.jsonl",
        passages: [
          row("passage-01", true, server.rates[0] as number, -4.2),
          row("passage-02", false, server.rates[1] as number, -12.9),
        ],
      };
      return opened;
    }
    if (!server.live.has(request.session_id as string))
      throw Object.assign(new Error("Reopen the session to reconnect the local service."), {
        name: staleSessionError,
      });
    if (operation === "passage")
      return {
        proposals: server.colours.map((colour_index, index) => ({
          key: `p${index + 1}`,
          colour_index,
          beats_ms: [],
        })),
        saved: null,
      };
    if (operation === "save") {
      server.saves.push(request);
      return { save_id: `save-${server.saves.length}`, time: "2026-10-25T01:00:00.000Z" };
    }
    if (operation === "reveal")
      return {
        names: [
          { key: "p1", name: "model-a" },
          { key: "p2", name: "model-b" },
        ],
      };
    throw new Error(operation);
  });
  vi.mocked(timingRequest).mockImplementation(
    async () => new Response(new ArrayBuffer(frames * 2 * 4)),
  );
  container = document.createElement("div");
  document.body.append(container);
  app = createApp(TimingWorkspace);
  app.mount(container);
});

afterEach(() => {
  app.unmount();
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function hud(): string {
  return container.querySelector(".timing-hud")?.textContent?.replace(/\s+/g, " ") ?? "";
}

function status(): string {
  return container.querySelectorAll(".timing-hud .health-status")[1]?.textContent?.trim() ?? "";
}

function key(name: string, target: EventTarget = document.activeElement ?? document.body) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === text,
  );
  if (!found) throw new Error(`No button ${text}`);
  return found;
}

/** Holds every `operation` request until the returned function is called. */
function hold(operation: string): () => void {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = vi.mocked(timingJson).getMockImplementation();
  vi.mocked(timingJson).mockImplementation(async (name, body) => {
    if (name === operation) await held;
    return answer?.(name, body);
  });
  return release;
}

function passageKey(code: "BracketLeft" | "BracketRight") {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: code, code, shiftKey: true }));
}

async function mount(preferences: object, rates = [44_100, 44_100]) {
  app.unmount();
  server.rates = rates;
  localStorage.setItem("lens-timing-preferences", JSON.stringify(preferences));
  app = createApp(TimingWorkspace);
  app.mount(container);
  await opened();
}

async function opened() {
  await vi.waitFor(() => expect(container.querySelector(".stage-stub")).not.toBeNull());
}

it("opens on the first unsaved passage", async () => {
  await opened();
  expect(hud()).toContain("Passage 02 of 2");
});

it("keeps unsaved marks across a service restart and saves them on the reopened session", async () => {
  await opened();
  key("b");
  await nextTick();
  expect(status()).toBe("Unsaved · 1 marks");

  server.live.clear();
  key("Enter");
  await vi.waitFor(() => expect(status()).toBe("Saved"));
  expect(server.saves).toHaveLength(1);
  expect(server.saves[0]).toMatchObject({
    session_id: "s2",
    passage_index: 1,
    marks: [{ kind: "beat", time_ms: 100.25, blind: true }],
  });
  expect(container.textContent).toContain("Reconnected to the restarted service");
  expect(vi.mocked(timingJson).mock.calls.map(([operation]) => operation)).not.toContain("reveal");
});

it("does not retry a save when the restarted service changed the legend the listener saw", async () => {
  await opened();
  key("b");
  await nextTick();
  server.live.clear();
  server.colours = [6, 1];
  key("Enter");
  await vi.waitFor(() => expect(container.textContent).toContain("new proposal colours"));
  // The explanation is in the stage header, which is always in view, not below the fold of the rail.
  expect(hud()).toContain("gave passage 02 new proposal colours. Check them, then save again.");
  expect(server.saves).toHaveLength(0);
  key("Enter");
  await vi.waitFor(() => expect(status()).toBe("Saved"));
  expect(server.saves[0]).toMatchObject({ session_id: "s2", marks: [{ time_ms: 100.25 }] });
});

it("retries a save after a service restart on the passage and playback it was made with", async () => {
  await opened();
  key("b");
  await nextTick();
  const release = hold("save");
  key("Enter");
  passageKey("BracketLeft");
  await vi.waitFor(() => expect(hud()).toContain("Passage 01 of 2"));
  await opened();

  server.live.clear();
  release();
  await vi.waitFor(() => expect(server.saves).toHaveLength(1));
  expect(server.saves[0]).toMatchObject({
    session_id: "s2",
    passage_index: 1,
    marks: [{ time_ms: 100.25 }],
    playback: { loudness_gain_db: -12.9 },
  });
  await vi.waitFor(() => expect(button("Save marks").disabled).toBe(false));
  expect(hud()).toContain("Passage 01 of 2");
  expect(status()).toBe("No marks saved");

  passageKey("BracketRight");
  await vi.waitFor(() => expect(hud()).toContain("Passage 02 of 2"));
  await opened();
  expect(status()).toBe("Saved");
});

it("shows revealed names only beside the passage they were revealed for", async () => {
  await opened();
  key("b");
  await nextTick();
  key("Enter");
  await vi.waitFor(() => expect(status()).toBe("Saved"));

  const release = hold("reveal");
  button("Reveal names").click();
  passageKey("BracketLeft");
  await vi.waitFor(() => expect(hud()).toContain("Passage 01 of 2"));
  await opened();
  const { mock } = vi.mocked(timingJson);
  const reveal = mock.calls.findIndex(([operation]) => operation === "reveal");
  release();
  await vi.waitFor(() => expect(mock.settledResults[reveal]?.type).toBe("fulfilled"));
  await nextTick();
  expect(hud()).toMatch(/Passage 01 of 2 .* Blind/);
  expect(container.querySelector(".timing-legend")?.textContent).not.toContain("model-a");

  // The service recorded the reveal, so the passage it was for reads as revealed.
  passageKey("BracketRight");
  await vi.waitFor(() => expect(hud()).toContain("Passage 02 of 2"));
  await opened();
  expect(hud()).toMatch(/Passage 02 of 2 .* Revealed/);
});

it("brings unsaved marks back when the same session is opened again", async () => {
  await opened();
  key("b");
  await nextTick();
  vi.stubGlobal("confirm", () => true);
  button("Open another session").click();
  await nextTick();
  expect(container.textContent).toContain("Unsaved marks in 1 passage(s) are kept");
  container.querySelector("form")?.dispatchEvent(new Event("submit"));
  await opened();
  expect(hud()).toContain("Passage 02 of 2");
  expect(status()).toBe("Unsaved · 1 marks");
});

it("gives the keyboard back to the shortcuts after a rail control is used with the mouse", async () => {
  await opened();
  const plus = button("+1");
  plus.focus();
  plus.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  plus.click();
  expect(document.activeElement).not.toBe(plus);
  key(" ");
  await vi.waitFor(() => expect(engine.plays).toBe(1));
  expect(container.querySelector<HTMLInputElement>(".timing-offset-editor input")?.value).toBe("1");

  // From the keyboard the control keeps focus and Space stays with it.
  const follow = button("On");
  follow.focus();
  follow.click();
  expect(document.activeElement).toBe(follow);
  key(" ");
  await nextTick();
  expect(engine.plays).toBe(1);

  for (const selector of ["input[type='range']", "select"]) {
    const control = container.querySelector<HTMLElement>(`.timing-details ${selector}`);
    if (!control) throw new Error(`No ${selector}`);
    control.focus();
    control.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.activeElement).not.toBe(control);
  }
  key("b");
  await nextTick();
  expect(status()).toBe("Unsaved · 1 marks");

  // Typing in a field never reaches the shortcuts.
  const setup = container.querySelector<HTMLInputElement>("#timing-setup");
  setup?.focus();
  key("n", setup ?? undefined);
  await nextTick();
  expect(status()).toBe("Unsaved · 1 marks");
});

it("asks for the output device rate before the first save", async () => {
  await mount({ setup: "DT 270 PRO", deviceRateHz: null });
  expect(hud()).toContain("Output device rate not stated");
  key("b");
  key("Enter");
  await nextTick();
  expect(container.textContent).toContain("Choose the output device rate before saving.");
  expect(server.saves).toHaveLength(0);
  const rate = container.querySelector<HTMLSelectElement>("#timing-device-rate");
  if (!rate) throw new Error("No device rate field");
  expect(document.activeElement).toBe(rate);
  rate.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  rate.value = "44100";
  rate.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
  expect(hud()).toContain("Reopen audio before listening");
  key("Enter");
  await vi.waitFor(() => expect(status()).toBe("Saved"));
  expect(server.saves[0]).toMatchObject({ playback: { device_rate_hz: 44_100 } });
});

it("warns in the HUD when the device rate differs from the recording or the recording rate changes", async () => {
  await mount({ setup: "DT 270 PRO", deviceRateHz: 44_100 }, [44_100, 48_000]);
  expect(hud()).toContain("Passage 02 of 2");
  expect(hud()).toContain("output device is at 44,100 Hz and this recording at 48,000 Hz");
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "{", code: "BracketLeft", shiftKey: true }),
  );
  await vi.waitFor(() => expect(hud()).toContain("Passage 01 of 2"));
  await vi.waitFor(() => expect(hud()).toContain("The recording rate changed to 44,100 Hz"));
  button("Reopen audio after a device change").click();
  await vi.waitFor(() => expect(container.querySelector(".timing-hud-warning")).toBeNull());
});

it("applies each passage's loudness gain when consecutive passages share a recording", async () => {
  await opened();
  const toggle = container.querySelector<HTMLInputElement>(".timing-check input");
  if (!toggle) throw new Error("No loudness toggle");
  toggle.click();
  await vi.waitFor(() => expect(engine.loudness.at(-1)).toBe(-12.9));
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "{", code: "BracketLeft", shiftKey: true }),
  );
  await vi.waitFor(() => expect(hud()).toContain("Passage 01 of 2"));
  await vi.waitFor(() => expect(engine.loudness.at(-1)).toBe(-4.2));
});

it("lists mark times to 0.001 ms with the sample index, so a one-sample nudge shows", async () => {
  await opened();
  key("b");
  await nextTick();
  const row = () => container.querySelector(".timing-mark-list button")?.textContent ?? "";
  expect(row()).toContain("00:00.100250");
  expect(row()).toContain("n 4421");
  button(row().trim()).click();
  key(".");
  await nextTick();
  expect(row()).toContain("00:00.100273");
  expect(row()).toContain("n 4422");
});

it("keeps digits typed into the offset and pre-roll fields while playback redraws every frame", async () => {
  await opened();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  key(" ");
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  const redraw = async (positionMs: number) => {
    engine.positionMs = positionMs;
    frames.shift()?.(0);
    await nextTick();
    expect(hud()).toContain(`00:00.${positionMs}`);
  };

  const fields = container.querySelectorAll<HTMLInputElement>(
    ".timing-details input[type='number']",
  );
  const [offset, preroll] = fields;
  if (!offset || !preroll) throw new Error("No number fields");
  offset.focus();
  for (const [index, text] of ["1", "10", "100"].entries()) {
    offset.value = text;
    offset.dispatchEvent(new Event("input", { bubbles: true }));
    await redraw(200 + index * 100);
    expect(offset.value).toBe(text);
  }
  // Tab: the field commits on change, then blurs.
  offset.dispatchEvent(new Event("change", { bubbles: true }));
  offset.blur();
  await redraw(500);
  expect(offset.value).toBe("100");
  expect(engine.offsets.at(-1)).toBe(100);
  expect(JSON.parse(localStorage.getItem("lens-timing-preferences") ?? "{}")).toMatchObject({
    playheadOffsetMs: 100,
  });

  // Enter commits and keeps focus; a pre-roll under the minimum shows the minimum.
  preroll.focus();
  preroll.value = "50";
  preroll.dispatchEvent(new Event("input", { bubbles: true }));
  await redraw(600);
  expect(preroll.value).toBe("50");
  preroll.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await redraw(700);
  expect(preroll.value).toBe("120");
  expect(document.activeElement).toBe(preroll);
  expect(engine.plays).toBe(1);

  // The buttons still step the stored value.
  button("+1").click();
  await nextTick();
  expect(offset.value).toBe("101");
});

it("visits a passage asked for by key while another passage is loading", async () => {
  await opened();
  expect(hud()).toContain("Passage 02 of 2");
  passageKey("BracketLeft");
  await nextTick();
  expect(hud()).toContain("Passage 01 of 2");
  passageKey("BracketRight");
  await vi.waitFor(() => expect(hud()).toContain("Passage 02 of 2"));
  await opened();
  const visited = vi
    .mocked(timingJson)
    .mock.calls.filter(([operation]) => operation === "passage")
    .map(([, body]) => (body as { passage_index: number }).passage_index);
  expect(visited).toEqual([1, 0, 1]);
});
