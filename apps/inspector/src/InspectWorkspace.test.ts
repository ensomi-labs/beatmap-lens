// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "vue";
import InspectWorkspace from "./InspectWorkspace.vue";
import { renderStaticPreviewSvg } from "./static-preview";

vi.mock("./annotation/session-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./annotation/session-store")>()),
  readTailShortenMs: async () => 37,
}));
vi.mock("./static-preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./static-preview")>();
  return { renderStaticPreviewSvg: vi.fn(actual.renderStaticPreviewSvg) };
});

let app: ReturnType<typeof createApp>;

afterEach(() => {
  app.unmount();
  document.body.replaceChildren();
});

it("draws the static preview with the stored long-note tail setting", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  app = createApp(InspectWorkspace);
  app.mount(container);
  await vi.waitFor(() =>
    expect(renderStaticPreviewSvg).toHaveBeenCalledWith(expect.anything(), 37),
  );
});
