// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import TimingWorkspace from "./TimingWorkspace.vue";
import { timingJson, timingRequest } from "./timing/client";
import { type BlindPassageRow, type OpenTiming, staleSessionError } from "./timing/contracts";

vi.mock("./timing/client", () => ({ timingJson: vi.fn(), timingRequest: vi.fn() }));
const engine = vi.hoisted(() => ({ plays: 0, loudness: [] as number[] }));
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
    async play() {
      engine.plays++;
      this.playing = true;
    }
    stop() {
      this.playing = false;
      return undefined;
    }
    position() {
      return undefined;
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
  saves: [] as Record<string, unknown>[],
}));

function row(id: string, saved: boolean): BlindPassageRow {
  return {
    id,
    title: id,
    start_ms: 100.25,
    end_ms: 900,
    context_before_ms: 2000,
    context_after_ms: 2000,
    hint: "",
    flags: [],
    loudness_gain_db: -6,
    audio: { handle: "a1", format: "f32le-interleaved", sample_rate: 44_100, channels: 2, frames },
    saved,
    revealed: false,
  };
}

let app: ReturnType<typeof createApp>;
let container: HTMLElement;

beforeEach(() => {
  Object.assign(server, { live: new Set(), opens: 0, colours: [3, 5], saves: [] });
  Object.assign(engine, { plays: 0, loudness: [] });
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
        passages: [row("passage-01", true), row("passage-02", false)],
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
  expect(server.saves).toHaveLength(0);
  key("Enter");
  await vi.waitFor(() => expect(status()).toBe("Saved"));
  expect(server.saves[0]).toMatchObject({ session_id: "s2", marks: [{ time_ms: 100.25 }] });
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
