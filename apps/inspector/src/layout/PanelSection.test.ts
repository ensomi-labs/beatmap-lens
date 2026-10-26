// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import PanelSection from "./PanelSection.vue";

let container: HTMLElement;
let app: ReturnType<typeof createApp> | undefined;
const reveal = ref(false);

interface Section {
  id: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  reveal?: boolean;
}

function mount(sections: Section[]) {
  app = createApp(() =>
    sections.map((props) =>
      h(PanelSection, { key: props.id, title: props.id, ...props }, () =>
        h("p", `${props.id} body`),
      ),
    ),
  );
  app.mount(container);
}

function remount(sections: Section[]) {
  app?.unmount();
  mount(sections);
}

const toggle = (id: string) => container.querySelector<HTMLButtonElement>(`#${id} button`);
const bodyShown = (id: string) =>
  container.querySelector<HTMLElement>(`#${id}-body`)?.style.display !== "none";
const stored = () => JSON.parse(localStorage.getItem("lens-sections") ?? "{}");

beforeEach(() => {
  localStorage.clear();
  reveal.value = false;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.replaceChildren();
});

it("remembers which sections were closed, each on its own", async () => {
  const sections = [{ id: "marks" }, { id: "listening" }, { id: "help", defaultOpen: false }];
  mount(sections);
  expect([bodyShown("marks"), bodyShown("listening"), bodyShown("help")]).toEqual([
    true,
    true,
    false,
  ]);
  expect(toggle("marks")?.getAttribute("aria-expanded")).toBe("true");
  expect(toggle("marks")?.getAttribute("aria-controls")).toBe("marks-body");
  toggle("marks")?.click();
  toggle("help")?.click();
  await nextTick();
  expect(toggle("marks")?.getAttribute("aria-expanded")).toBe("false");
  expect(stored()).toEqual({ marks: false, help: true });
  remount(sections);
  expect([bodyShown("marks"), bodyShown("listening"), bodyShown("help")]).toEqual([
    false,
    true,
    true,
  ]);
  toggle("marks")?.click();
  await nextTick();
  expect(bodyShown("marks")).toBe(true);
  expect(stored()).toEqual({ marks: true, help: true });
});

it("keeps a section a save may need open, whatever was stored", () => {
  localStorage.setItem("lens-sections", JSON.stringify({ save: false }));
  mount([{ id: "save", collapsible: false }]);
  expect(bodyShown("save")).toBe(true);
  expect(toggle("save")).toBeNull();
  expect(container.querySelector("#save h3")?.textContent?.trim()).toBe("save");
});

it("falls back to the defaults when the stored state is unreadable", () => {
  localStorage.setItem("lens-sections", "{not json");
  mount([{ id: "marks" }, { id: "help", defaultOpen: false }]);
  expect([bodyShown("marks"), bodyShown("help")]).toEqual([true, false]);
});

it("opens for a warning inside it without remembering that", async () => {
  localStorage.setItem("lens-sections", JSON.stringify({ sync: false }));
  mount([
    {
      id: "sync",
      get reveal() {
        return reveal.value;
      },
    },
  ]);
  expect(bodyShown("sync")).toBe(false);
  reveal.value = true;
  await nextTick();
  expect(bodyShown("sync")).toBe(true);
  expect(stored()).toEqual({ sync: false });
  // The listener can still close it while the warning lasts.
  toggle("sync")?.click();
  await nextTick();
  expect(bodyShown("sync")).toBe(false);
});
