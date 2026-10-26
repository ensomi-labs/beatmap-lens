// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { clampSize, type PaneSpec, readLayout } from "./pane-layout";
import WorkspaceFrame from "./WorkspaceFrame.vue";

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

function mount() {
  app = createApp(() =>
    h(
      WorkspaceFrame,
      { layoutKey: "test", left, right },
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
  playhead.value = 0;
  rightRenders = 0;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.replaceChildren();
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
