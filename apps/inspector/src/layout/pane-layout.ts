import { type Ref, ref } from "vue";

/** A side pane of a workspace frame: its element id, name and allowed widths in CSS pixels. */
export interface PaneSpec {
  id: string;
  label: string;
  defaultSize: number;
  min: number;
  max: number;
}

export interface PaneState {
  size: number;
  collapsed: boolean;
}

export type LayoutState = Record<string, PaneState>;

const storagePrefix = "lens-layout:";

export function clampSize(spec: PaneSpec, size: number): number {
  if (!Number.isFinite(size)) return spec.defaultSize;
  return Math.round(Math.min(spec.max, Math.max(spec.min, size)));
}

/** The stored sizes for `key`, each clamped to its spec; anything unreadable falls back to defaults. */
export function readLayout(key: string, specs: PaneSpec[]): LayoutState {
  let stored: Record<string, Partial<PaneState>> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storagePrefix + key) ?? "{}");
    if (parsed && typeof parsed === "object") stored = parsed as typeof stored;
  } catch {}
  return Object.fromEntries(
    specs.map((spec) => {
      const entry = stored[spec.id];
      return [
        spec.id,
        {
          size: clampSize(spec, typeof entry?.size === "number" ? entry.size : spec.defaultSize),
          collapsed: entry?.collapsed === true,
        },
      ];
    }),
  );
}

export function writeLayout(key: string, state: LayoutState) {
  try {
    localStorage.setItem(storagePrefix + key, JSON.stringify(state));
  } catch {}
}

/** Pane sizes and collapsed states for one workspace, kept in the browser between visits. */
export function usePaneLayout(key: string, specs: PaneSpec[]) {
  const state: Ref<LayoutState> = ref(readLayout(key, specs));
  const spec = (id: string) => specs.find((entry) => entry.id === id);

  function update(id: string, change: Partial<PaneState>) {
    const current = state.value[id];
    if (!current) return;
    state.value = { ...state.value, [id]: { ...current, ...change } };
    writeLayout(key, state.value);
  }

  return {
    state,
    resize(id: string, size: number) {
      const entry = spec(id);
      if (entry) update(id, { size: clampSize(entry, size), collapsed: false });
    },
    setCollapsed(id: string, collapsed: boolean) {
      update(id, { collapsed });
    },
    reset(id: string) {
      const entry = spec(id);
      if (entry) update(id, { size: entry.defaultSize, collapsed: false });
    },
  };
}
