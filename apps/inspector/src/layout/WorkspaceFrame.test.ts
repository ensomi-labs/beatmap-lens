// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { clampSize, type PaneSpec, readLayout } from "./pane-layout";
import WorkspaceFrame, { type MobilePanel } from "./WorkspaceFrame.vue";

const left: PaneSpec = { id: "test-left", label: "List", defaultSize: 240, min: 160, max: 400 };
const right: PaneSpec = {
  id: "test-right",
  label: "Details",
  defaultSize: 300,
  min: 240,
  max: 480,
};

let container: HTMLElement;
let app: ReturnType<typeof createApp> | undefined;
const playhead = ref(0);
let rightRenders = 0;

const mobilePanel = ref<MobilePanel>("preview");
const frame = ref<InstanceType<typeof WorkspaceFrame>>();

function mount(props: Record<string, unknown> = {}) {
  app = createApp(() =>
    h(
      WorkspaceFrame,
      { ref: frame, layoutKey: "test", left, right, ...props },
      {
        main: () => h("output", { class: "test-playhead" }, String(playhead.value)),
        left: () => h("p", "list"),
        right: () => {
          rightRenders++;
          return h("p", "details");
        },
      },
    ),
  );
  app.mount(container);
}

/** Mounts the frame with its narrow-window view switch bound, as the workspaces do. */
function mountSwitchable() {
  mount({
    get mobilePanel() {
      return mobilePanel.value;
    },
    "onUpdate:mobilePanel": (panel: MobilePanel) => {
      mobilePanel.value = panel;
    },
  });
}

/** The window's width, for the 38 % limit and the narrow-window query. */
function setWindowWidth(width: number) {
  (
    window as unknown as {
      happyDOM: { setViewport(size: { width: number; height: number }): void };
    }
  ).happyDOM.setViewport({ width, height: 900 });
}

function splitter(pane: PaneSpec): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    `[role="separator"][aria-controls="${pane.id}"]`,
  );
  if (!found) throw new Error(`No boundary for ${pane.id}`);
  return found;
}

async function key(target: HTMLElement, name: string, shiftKey = false) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true }));
  await nextTick();
}

beforeEach(() => {
  localStorage.clear();
  setWindowWidth(1440);
  playhead.value = 0;
  rightRenders = 0;
  mobilePanel.value = "preview";
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("clamps stored widths and falls back to the defaults for anything unreadable", () => {
  localStorage.setItem(
    "lens-layout:test",
    JSON.stringify({
      "test-left": { size: 9999, collapsed: true },
      "test-right": { size: "wide" },
    }),
  );
  expect(readLayout("test", [left, right])).toEqual({
    "test-left": { size: 400, collapsed: true },
    "test-right": { size: 300, collapsed: false },
  });
  localStorage.setItem("lens-layout:test", "{not json");
  expect(readLayout("test", [left])).toEqual({ "test-left": { size: 240, collapsed: false } });
  expect(clampSize(left, Number.NaN)).toBe(240);
});

it("resizes a pane from its boundary's keys and keeps the width for the next visit", async () => {
  mount();
  const boundary = splitter(left);
  expect(boundary.getAttribute("aria-valuenow")).toBe("240");
  await key(boundary, "ArrowRight");
  await key(boundary, "ArrowRight", true);
  expect(boundary.getAttribute("aria-valuenow")).toBe("320");
  // The right pane grows to the left.
  await key(splitter(right), "ArrowLeft");
  expect(splitter(right).getAttribute("aria-valuenow")).toBe("316");
  await key(boundary, "End");
  expect(boundary.getAttribute("aria-valuenow")).toBe("400");
  await key(boundary, "Home");
  expect(boundary.getAttribute("aria-valuenow")).toBe("160");
  expect(JSON.parse(localStorage.getItem("lens-layout:test") ?? "{}")).toMatchObject({
    "test-left": { size: 160, collapsed: false },
    "test-right": { size: 316, collapsed: false },
  });
  app?.unmount();
  mount();
  expect(splitter(left).getAttribute("aria-valuenow")).toBe("160");
  expect(splitter(right).getAttribute("aria-valuenow")).toBe("316");
});

it("hides a pane by Enter or its toolbar toggle, and keeps the main view in its own column", async () => {
  mount();
  const pane = () => container.querySelector<HTMLElement>(`#${left.id}`);
  const main = () => container.querySelector<HTMLElement>(".frame-main");
  expect(main()?.style.gridColumn).toBe("3");
  await key(splitter(left), "Enter");
  expect(pane()?.style.display).toBe("none");
  expect(splitter(left).getAttribute("aria-valuetext")).toBe("List hidden");
  expect(main()?.style.gridColumn).toBe("3");
  const toggle = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Show list",
  );
  if (!toggle) throw new Error("No Show list toggle");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.click();
  await nextTick();
  expect(pane()?.style.display).toBe("");
  expect(toggle.textContent?.trim()).toBe("Hide list");
  // Arrow keys stay with the boundary instead of reaching the workspace's shortcuts.
  const reached: string[] = [];
  const listener = (event: KeyboardEvent) => reached.push(event.key);
  window.addEventListener("keydown", listener);
  await key(splitter(left), "ArrowLeft");
  await key(splitter(left), "b");
  window.removeEventListener("keydown", listener);
  expect(reached).toEqual(["b"]);
});

it("re-renders only the region that shows a value changing every frame", async () => {
  mount();
  const before = rightRenders;
  for (let frame = 1; frame <= 5; frame++) {
    playhead.value = frame * 16.7;
    await nextTick();
  }
  expect(container.querySelector(".test-playhead")?.textContent).toBe("83.5");
  expect(rightRenders).toBe(before);
});

it("keeps a pane within 38 % of the window, and its boundary reports the width drawn", async () => {
  setWindowWidth(1000);
  mount();
  const boundary = splitter(right);
  const column = () =>
    container.querySelector<HTMLElement>(".frame-body")?.style.gridTemplateColumns ?? "";
  expect(boundary.getAttribute("aria-valuemax")).toBe("380");
  await key(boundary, "End");
  expect(boundary.getAttribute("aria-valuenow")).toBe("380");
  expect(column()).toContain("380px");
  // No dead zone: the first step back narrows what is drawn.
  await key(boundary, "ArrowRight");
  expect(boundary.getAttribute("aria-valuenow")).toBe("364");
  await key(boundary, "End");
  // A narrower window draws the pane narrower and keeps the stored width for a wider one.
  setWindowWidth(940);
  await nextTick();
  expect(boundary.getAttribute("aria-valuenow")).toBe("357");
  expect(column()).toContain("357px");
  expect(column()).not.toContain("38vw");
  setWindowWidth(1600);
  await nextTick();
  expect(boundary.getAttribute("aria-valuemax")).toBe("480");
  expect(boundary.getAttribute("aria-valuenow")).toBe("380");
});

it("resizes by dragging at most once a frame, hides past the narrowest width, and resets", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  mount();
  const boundary = splitter(left);
  const pointer = (type: string, clientX: number) =>
    boundary.dispatchEvent(
      new PointerEvent(type, { clientX, pointerId: 7, button: 0, bubbles: true, cancelable: true }),
    );
  // A mouse press does not take keyboard focus, so the workspace keeps its shortcuts.
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  boundary.dispatchEvent(press);
  expect(press.defaultPrevented).toBe(true);
  pointer("pointerdown", 500);
  pointer("pointermove", 520);
  pointer("pointermove", 560);
  expect(frames).toHaveLength(1);
  frames.shift()?.(0);
  await nextTick();
  expect(boundary.getAttribute("aria-valuenow")).toBe("300");
  expect(boundary.classList).toContain("is-dragging");
  // Past the narrowest width it stops there, and 56 px further it hides the pane.
  pointer("pointermove", 380);
  frames.shift()?.(0);
  await nextTick();
  expect(boundary.getAttribute("aria-valuenow")).toBe("160");
  pointer("pointermove", 340);
  frames.shift()?.(0);
  await nextTick();
  expect(boundary.getAttribute("aria-valuetext")).toBe("List hidden");
  expect(container.querySelector<HTMLElement>(`#${left.id}`)?.style.display).toBe("none");
  // Dragging back out shows it again.
  pointer("pointermove", 440);
  frames.shift()?.(0);
  await nextTick();
  expect(boundary.getAttribute("aria-valuetext")).toBe("List 180 pixels wide");
  pointer("pointerup", 440);
  await nextTick();
  expect(boundary.classList).not.toContain("is-dragging");
  // Moves after the release do nothing.
  pointer("pointermove", 600);
  expect(frames).toHaveLength(0);
  boundary.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await nextTick();
  expect(boundary.getAttribute("aria-valuenow")).toBe("240");
  expect(JSON.parse(localStorage.getItem("lens-layout:test") ?? "{}")).toMatchObject({
    "test-left": { size: 240, collapsed: false },
  });
});

it("shows one region at a time in a narrow window, chosen by the view switch", async () => {
  setWindowWidth(800);
  mountSwitchable();
  const shown = (selector: string) =>
    container.querySelector<HTMLElement>(selector)?.style.display !== "none";
  const switchButton = (name: string) => {
    const found = [...container.querySelectorAll(".frame-view-switch button")].find(
      (button) => button.textContent?.trim() === name,
    );
    if (!found) throw new Error(`No ${name} view`);
    return found as HTMLButtonElement;
  };
  expect(container.querySelector('[role="separator"]')).toBeNull();
  expect(container.querySelector(".pane-toggles")).toBeNull();
  expect(container.querySelector(".frame-body")?.getAttribute("style")).toContain("minmax(0, 1fr)");
  expect([shown(`#${left.id}`), shown(".frame-main"), shown(`#${right.id}`)]).toEqual([
    false,
    true,
    false,
  ]);
  expect(switchButton("Preview").getAttribute("aria-pressed")).toBe("true");
  switchButton("Details").click();
  await nextTick();
  expect([shown(`#${left.id}`), shown(".frame-main"), shown(`#${right.id}`)]).toEqual([
    false,
    false,
    true,
  ]);
  // A control in another region that must take focus switches to that region.
  expect(frame.value?.showPane("left")).toBe(true);
  await nextTick();
  expect(mobilePanel.value).toBe("source");
  expect(shown(`#${left.id}`)).toBe(true);
  expect(frame.value?.showPane("left")).toBe(false);
  // Wider than 920 px the panes are side by side again, with their boundaries. (happy-dom's media
  // query reports a change only after it has once seen the query match while listening.)
  setWindowWidth(700);
  setWindowWidth(1440);
  await nextTick();
  expect(container.querySelector(".frame-view-switch")).toBeNull();
  expect(container.querySelectorAll('[role="separator"]')).toHaveLength(2);
  expect([shown(`#${left.id}`), shown(".frame-main"), shown(`#${right.id}`)]).toEqual([
    true,
    true,
    true,
  ]);
});

it("shows a hidden pane for a control inside it that must take focus", async () => {
  mount();
  await key(splitter(right), "Enter");
  expect(container.querySelector<HTMLElement>(`#${right.id}`)?.style.display).toBe("none");
  expect(frame.value?.showPane("right")).toBe(true);
  await nextTick();
  expect(container.querySelector<HTMLElement>(`#${right.id}`)?.style.display).toBe("");
  expect(frame.value?.showPane("right")).toBe(false);
});
