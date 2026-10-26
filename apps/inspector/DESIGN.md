# Beatmap Lens Inspector design language

- Version: v2.0
- Status: proposed; replaces the theme and layout of v1.4 (approved 2026-08-05). The interaction
  rules of v1.4 that this version keeps are marked as kept.
- Research behind it: the commons research note `inspector-daw-ui-20261026` (professional audio
  tools' conventions, the Inspector before the change, and the reasons for each decision).

## 1. Visual theme and atmosphere

The Inspector is a dark audio workstation for charts: a few grey levels that separate the data from
the chrome, one blue accent for state, and saturated colour kept for data (proposals, notes, the
playhead). The data view is the darkest and largest region; chrome gets lighter the closer it is to
the hand. Every open workspace shares one frame, so moving between modes keeps the toolbar, panes
and status bar in the same places.

The interface is dense, precise and quiet. It should feel like Logic, Pro Tools or REAPER in a
browser, not a dashboard or a collection of cards.

## 2. Colour palette and roles

Strata, darkest first. Data views sit in the well; panes, headers and controls step up.

| Token | Value | Role |
| --- | --- | --- |
| `--seam` | `oklch(14% 0.012 255)` (`#06090e`) | 1 px boundaries between regions, segmented wells |
| `--well` | `oklch(20.5% 0.02 249)` (`#101820`) | Data views: Timing's stage, falling notes, Compare, Inspect's render |
| `--field` | `oklch(19% 0.012 255)` | Text fields, the time counter, lists inset in a pane |
| `--surface-1` | `oklch(23.5% 0.013 255)` | Side panes, the vertical timeline |
| `--surface-2` | `oklch(26.5% 0.014 255)` | Toolbar, status bar, pane and section headers, a view's own bar |
| `--surface-3` | `oklch(31.5% 0.014 255)` | Controls (buttons, segments) |
| `--ink` | `oklch(93% 0.006 255)` | Primary text and values |
| `--ink-secondary` | `oklch(78% 0.01 255)` | Labels, control text |
| `--ink-muted` | `oklch(64% 0.012 255)` | Units, captions, counts; never on a control |
| `--signal` | `oklch(72% 0.14 255)` (`#65a7fa`) | Focus, selection outline, accent text |
| `--signal-fill` | `oklch(52% 0.16 258)` (`#2466c3`) | Filled "on" states: pressed segments, primary actions |
| `--success` | `oklch(76% 0.15 153)` | Ready, saved; `--success-fill` while playing |
| `--warning` | `oklch(83% 0.14 80)` | Diagnostics, notices that need a look |
| `--danger` | `oklch(72% 0.17 25)` | Errors; the playhead |

Colour has roles. The accent marks focus, selection and toggles that are on. Play is green while
it plays. Amber warns and red is an error or the playhead. On a data view, hue belongs to the data:
Timing's proposal palette (`src/timing/palette.ts`, which leaves out red, white and grey) and the
listener's own marks in white. A selected Timing mark is white, heavier and cased in the seam
colour, with a faint accent wash either side of its line (as a selection drag) and an accent plate
behind its glyph; the line itself is never a palette colour.

Measured contrast on `--surface-1`: ink 13.6:1, secondary 8.4:1, muted 5.0:1, signal 6.7:1; white
on `--signal-fill` 5.6:1. Muted ink on a control would be 3.9:1, so controls use secondary ink.

## 3. Typography rules

- Interface text uses the native sans stack; `Azeret Mono Variable` carries numbers, times,
  sample indexes, identifiers and file paths, always with tabular figures.
- Sizes in px: 10 (units, captions, key hints), 11 (labels, rows, toolbar and status text),
  12 (body), 13 (reading text, section titles in a view), 15 (the time counter).
- Weights 450 to 650. Headings in panes are 11 px, weight 650, secondary ink.
- No rem fractions; use the `--text-*` tokens.

## 4. Component styling

- **Tool button** (`.tool-button`): 24 px tall, 4 px radius, `--surface-3` with a 1 px dark ring,
  11 px weight 600. Pressed (`aria-pressed="true"`) uses the accent's soft fill and outline;
  primary uses `--signal-fill`; Play while playing uses `--success-fill`. Icons are 14 px strokes.
  A key hint sits inside as `<kbd>` at 10 px.
- **Segmented** (`.segmented`): one seam-coloured well with 22 px segments; the chosen one is filled
  with `--signal-fill`. Used for rate, zoom, view and nudge steps.
- **Fields**: 26 px, `--field` with a 1 px `--field-edge` ring, focus ring in `--signal`.
- **Time counter** (`.time-counter`): a recessed 30 px box with the main time at 15 px and a
  secondary value (sample index, range) at 10 px; `contain: layout paint`, so the per-frame update
  never relays out the toolbar.
- **Panel section** (`PanelSection.vue`): a 28 px header in `--surface-2` whose title is a disclosure
  button (the APG accordion); the browser remembers which sections are open. A section a save may
  need to focus is not collapsible.
- **Rows**: lists use 24 to 26 px rows divided by 1 px lines; the selected row has the accent's soft
  fill and a 2 px accent bar on its leading edge.
- **Notice bar**: a full-width strip under a view's bar, amber for warnings, red for errors, with a
  dot and text, and at its end the tool buttons that act on it (Timing's Reopen audio). A warning
  about a setting in a side pane goes here, not only in the pane, which may be hidden or closed.
- **Status**: a coloured dot plus text; colour is never the only indicator.
- **Radii**: 3 to 6 px. No cards, no gradients, no glass.

## 5. Layout principles

Every open workspace is a `WorkspaceFrame` (`src/layout/`):

| Region | Size | Holds |
| --- | --- | --- |
| Toolbar | 40 px | Product glyph and mode tabs; the document's identity; transport; time counter; global state and the primary document action; panel toggles at the trailing edge |
| Left pane | resizable | Lists: passages, task queue, excerpts, source text, files |
| Main view | the rest | A view's own bar (identity, view-local controls), notices, then the data view in the well |
| Right pane | resizable | An inspector of collapsible sections |
| Status bar | 24 px | Passive facts that do not change while playing: zoom, rate, loop, offset, file |

- The main view cannot be hidden. Side panes are hidden from the toolbar toggles, by Enter on their
  boundary, or by dragging the boundary 56 px past the narrowest width.
- Pane widths (CSS px, default, min to max; at most 38 % of the window, a limit the boundary's
  widest width and reported value follow, so no key press or drag goes unseen):

  | Mode | Left | Right |
  | --- | --- | --- |
  | Timing | Passages 232, 168–420 | Marks and settings 320, 268–520 |
  | Annotate | Task queue 260, 180–440 | Playback and judgment 340, 280–560 |
  | Review | Files and queue 260, 200–460 | Section judgments 380, 300–600 |
  | Compare | Excerpts 248, 180–420 | Verdict and listening 300, 248–480 |
  | Inspect | Source 420, 240–720 | Details 300, 220–480 |

- Widths and hidden states are stored per workspace in `localStorage` under `lens-layout:<mode>`,
  read and written inside `try`/`catch`; Timing's passage list keeps its `passagesHidden`
  preference.
- Spacing is on a 4 px grid: 4 and 8 px inside panes, 8 and 12 px between groups. Regions are
  separated by 1 px seams, not by gutters.
- Annotate's main view is the falling-note view with the vertical timeline at its right edge, both
  the full height between toolbar and status bar. The timeline is 64 px wide (56 px below 1160 px,
  48 px in narrow windows). Kept from v1.4: time runs upward on the timeline (bottom is `0ms`, top
  is `chartEndMs`); density, playhead, viewport window, saved ranges, selection and pointer mapping
  all use that reversed axis without a CSS rotation.
- Kept from v1.4: Section Review keeps five horizontal assessment sliders (Absent, Supporting,
  Prominent, with Unreviewed and Unresolved distinct) and an independent High confidence checkbox
  per label; one section action submits all assessed dimensions; per-tag evidence expands below.
  Connected Review offers the golden set with label, strength and chart filters, and saved history
  with its version selector.
- Workspaces that are not open yet (onboarding forms) keep a two-column intro and form under a bar
  laid out like the toolbar.

## 6. Depth and elevation

- Depth is lightness, not shadow: each stratum is a fixed step lighter than the one below it.
- Controls have one ring (`--shadow-control`: a 1 px dark outline and a faint top highlight).
- Borders are 1 px seams between regions and 1 px lines between rows. No decorative borders.

## 7. Interaction rules

- **Boundaries** (`PaneSplitter.vue`) are the APG window splitter: a focusable `separator` whose
  value is the pane width, with `aria-controls` naming the pane. Left and Right resize by 16 px
  (Shift: 64 px), Home and End go to the narrowest and widest width, Enter hides and restores the
  pane, double-click restores the default width. The 1 px seam has a 9 px grab area over the pane,
  never the main view (beside a hidden pane it lies over the main view), and lights after a 200 ms
  hover, at once on focus or while dragging. Drags resize at most once per frame.
- A mouse press on a boundary does not take keyboard focus, so a workspace's window-wide shortcuts
  (Timing's arrows and Enter) keep working after a drag.
- Panel toggles are icon buttons named "Hide <pane>" / "Show <pane>" with `aria-expanded`.
- Every control keeps a keyboard path, `aria-keyshortcuts` where a key exists, and a title naming
  the key.
- Timing keeps all of its behaviour: proposals are anonymous and never audible; names only after
  a save and a reveal; Beat and Unbeat buttons are timed by their press; the marks list shows
  0.001 ms and the sample index; the README's shortcuts and gestures are the contract.
- Nothing that updates during playback may change layout: the toolbar counter is the only text
  that changes per frame besides the stage, and it is contained.
- Kept from v1.4: active timeline gestures are routed by their start target; Shift+drag creates a
  selection and Control+drag adjusts it; pinch or Control+wheel zooms at the pointer; ordinary
  two-finger wheel never changes timeline state; `+`, `-` and `0` act only while the timeline or its
  zoom buttons have focus; selection start and end exist as accessible text.

## 8. Do and do not

- Do keep the data view the darkest, largest region and the only place with saturated colour.
- Do put a view's own controls (rate, zoom, follow, visual speed) in the bar directly above it,
  and passive facts in the status bar.
- Do use monospaced type only for numbers, times and identifiers.
- Do keep transitions short and on colour, opacity or transform; never animate layout or use
  `transition: all`.
- Do not use the accent for large backgrounds or as a data colour.
- Do not add cards, gradients, glass, thick accent rails or rounded containers inside panes.
- Do not add per-frame reactive work during playback.

## 9. Responsive behavior

- At 920 px and below the frame shows one region at a time, chosen by a Source, Preview and
  Details switch under the toolbar; boundaries and panel toggles are not shown, and the toolbar
  wraps.
- Timing needs a window wider than 920 px and says so instead.
- Below 1240 px the toolbar drops its optional items (identity, the duplicate Beat button), views'
  bars drop their group labels, their time range and the word before the number ("02 of 6"), and
  the status bar drops optional facts. A view's bar keeps its flags and its hint, truncated, with
  the whole identity as its title; its height does not depend on the hint.
- Controls keep at least 24 CSS px hit areas (WCAG 2.2 SC 2.5.8). Safe-area insets apply to the
  toolbar and status bar.

## 10. Agent prompt guide

- "Add a toolbar control: `.tool-button`, 24 px, `--surface-3`, 11 px weight 600, `aria-pressed`
  for a toggle, a `<kbd>` hint and a title naming its key."
- "Add an inspector section: `<PanelSection id title>` in the right pane; rows of
  `.prop-row` (label left, value right in Azeret Mono with tabular figures)."
- "Add a passive fact to the status bar: `<span class="status-item">Label <b>value</b></span>`;
  mark it `status-optional` if it may drop below 1240 px."
- "Add a workspace: `<WorkspaceFrame layout-key mode :left :right>` with `#toolbar`,
  `#toolbar-end`, `#left`, `#main`, `#right` and `#status` slots and `PaneSpec`s for its panes."
