# Beatmap Lens Inspector design language

- Version: v1.4
- Status: 已审批
- Approved: 2026-08-05

## 1. Visual theme and atmosphere

The Inspector is a precision paper lab: a high-key workspace with quiet white surfaces,
graphite typography, and a small cobalt signal color. The application chrome stays restrained so
the dark beatmap render can become the single rich visual anchor when it is present.

The interface is precise, calm, and kinetic. It should feel like a focused inspection instrument,
not a generic analytics dashboard or a collection of cards.

## 2. Color palette and roles

| Token | Value | Role |
| --- | --- | --- |
| Canvas | `oklch(96% 0.008 255)` | Cool paper surrounding the work surface |
| Surface | `oklch(100% 0 0)` | Primary workspace |
| Surface quiet | `oklch(97.5% 0.006 255)` | Editor and inset controls |
| Ink | `oklch(21% 0.018 255)` | Primary text and primary action |
| Ink secondary | `oklch(43% 0.018 255)` | Supporting labels |
| Ink muted | `oklch(59% 0.014 255)` | Tertiary metadata |
| Signal | `oklch(57% 0.21 258)` | Focus, selected states, and active status |
| Success | `oklch(59% 0.15 153)` | Ready pipeline state |
| Warning | `oklch(69% 0.16 76)` | Diagnostics present |
| Danger | `oklch(60% 0.2 27)` | Pipeline failure |

Neutrals carry a faint cool tint. Signal color is used as status ink, never as a decorative wash.

## 3. Typography rules

- Interface text uses the native sans stack for fast, familiar controls and compact reading.
- `Azeret Mono Variable` is reserved for the product mark, indexes, source, statuses, and numbers.
- Display title: 30px, weight 650, line-height 1.08, letter-spacing `-0.022em`.
- Section title: 13px, weight 650, line-height 1.25.
- Body: 13px to 14px, weight 450 to 550, line-height 1.5.
- Data: 11px to 13px, weight 520 to 650, tabular numerals.
- Headings use balanced wrapping. Descriptions use pretty wrapping. Code keeps natural wrapping.

## 4. Component styling

- Buttons use a fixed 10px radius and a 40px minimum hit area. Primary buttons are graphite,
  quiet buttons are white with a layered hairline shadow. Hover changes color and shadow; press
  scales to `0.96` with an interruptible transition.
- The workspace is one continuous surface. Internal regions use structural 1px dividers instead of
  becoming separate cards.
- Textareas use a quiet inset surface and 14px radius. The surrounding 8px gutter produces a 22px
  concentric outer relationship.
- Statuses pair a small color dot with text. Color is never the only indicator.
- Inspect, onboarding, and read-only beatmap previews are inset rich surfaces with an 8px gutter,
  22px outer radius, and 14px inner radius. The active Annotate evidence view is the deliberate
  exception: its falling-note viewport is flush, full browser height, and separated from adjacent
  rails by structural 1px dividers.
- The active vertical timeline uses a low-contrast selection fill with no visible resize handles,
  caps, or heavy outline. Transparent 40px hit zones preserve precision, while selection start and
  end labels use tabular numerals and `mm:ss.s` display precision.

## 5. Layout principles

- Desktop: source column, flexible preview, optional details column.
- The preview owns the most width and remains the main visual anchor.
- Metadata appears in line-based rails with aligned labels and tabular values.
- Spacing scale: 4, 8, 12, 16, 24, 32px. Dense rows use vertical space sparingly and columns get
  the larger gaps.
- An active Annotate session uses a `100dvh` grid in this order: source rail, falling-note viewport,
  vertical timeline, details rail. The falling-note SVG and timeline share the exact top and bottom
  edges of the browser viewport; neither an app bar, stage header, nor bottom transport subtracts
  from their height.
- The active timeline touches the viewport's right edge through a 1px divider. It is 64px wide on
  desktop, 56px below 1160px, and 48px in mobile Preview.
- Timeline time runs upward: the bottom is song start at `0ms`, the top is song end at
  `chartEndMs`. Density, playhead, viewport window, saved ranges, selection geometry, pointer
  mapping, and labels all use this reversed Y-axis rather than a CSS rotation.
- Active-session chrome is redistributed instead of stacked vertically: identity and mode live in
  the source rail, save and transport controls live in a sticky details section, and chart identity
  plus playhead live in passive viewport HUD chips.
- Section Review keeps five compact horizontal assessment sliders together in the details rail.
  Each slider has three discrete positions: Absent, Supporting, and Prominent. Unreviewed and
  Unresolved stay visibly distinct from those positions. One section action submits all assessed
  dimensions; per-tag evidence is expandable below, and choosing it preserves the whole draft.
- Each section label has an independent High confidence checkbox beside its slider.
  New drafts start unchecked (Low); historical omissions remain unchecked and their
  saved history identifies confidence as unspecified. Confidence-only edits use the same single section save and
  append-only history. Changing assessment, scope, tag or playback rate resets draft
  confidence to Low; evidence-only edits do not redefine label certainty.
- Connected Review provides a Golden set view with label, strength, and chart filters.
  Its read-only source previews pair current High-confidence judgments with human
  comments and Foundation criteria. A link beside section sliders opens references
  in another tab so the active human draft remains in place.
- Connected chart review exposes saved history and its version selector in the source rail.
  A version identifies skill name, revision, and content hash; identical bytes do not hide named
  revisions. Earlier human records remain inspectable and editable through append-only revisions.

## 6. Depth and elevation

- Canvas to workspace is a 4% lightness step. The full-width workspace stays flat and continuous.
- Elevated controls use three layers: a translucent 1px ring, a short contact shadow, and a soft
  ambient shadow.
- Borders are reserved for dividers and table-like rows. There are no decorative card borders.
- The rendered SVG gets a 10% inset outline so its dark edge remains crisp against the white shell.

## 7. Do and do not

- Do keep the application shell white and the beatmap itself visually rich.
- Do use monospaced type only for technical identity and changing data.
- Do keep state transitions short, interruptible, and transform or opacity based.
- Do preserve the editor, keyboard shortcut, error state, facts, and full pipeline detail.
- Do align numeric values on a stable right edge.
- Do route active timeline gestures by their start target: dragging a selection highlight moves the
  selection, while dragging the timeline background or viewport window navigates the main view.
- Do support macOS Three Finger Drag through that same selection pointer-drag path. The browser does
  not expose a reliable trackpad finger count, so mouse drag remains the equivalent accessible path.
- Do keep ordinary two-finger wheel gestures free of timeline state changes. Pinch or
  `Control + wheel` zooms around the pointer time; `Shift + drag` creates a selection and
  `Control + drag` adjusts its body or invisible edges.
- Do make the timeline root keyboard-focusable with the standard visible focus treatment and an
  accessible name that states "bottom is song start, top is song end." Zoom in, Zoom out, and Fit
  are real labeled buttons; `+`, `-`, and `0` only act while the timeline or those controls have
  focus. Selection start and end times must exist as accessible text, not only SVG paint.
- Do not add gradients, glass surfaces, thick accent rails, or a grid of equal cards.
- Do not use accent color for large backgrounds.
- Do not hide ordinary overflow in a modal.
- Do not animate layout properties or use `transition: all`.

## 8. Responsive behavior

- Above 920px, source, preview, and optional details are visible as columns.
- At 920px and below, a compact three-view switch shows Source, Preview, or Details in the same
  workspace position so the preview is never pushed below a long editor.
- In an active mobile Annotate Preview, the view switch is a fixed overlay and does not consume
  layout height. The falling-note viewport plus 48px timeline remain `100dvh`; any compact transport
  overlays the preview without resizing the SVG or covering the judgment line.
- At 375px, controls retain 40px hit areas, the chart title remains readable, and metadata becomes a
  two-column rail.
- Safe-area insets apply to the outer app shell.

## 9. Agent prompt guide

- "Add an Inspector control on white `oklch(100% 0 0)`, 40px tall, 10px radius, 13px weight 600,
  graphite `oklch(21% 0.018 255)`, with an interruptible `scale(.96)` press state."
- "Add an inset technical panel with an 8px quiet gutter `oklch(97.5% 0.006 255)`, 22px outer
  radius, 14px inner radius, and no decorative border."
- "Add a metric row with a left-aligned native-sans label at 11px and a right-aligned Azeret Mono
  value at 12px using tabular numerals and a 1px structural divider."
- "Add a status using a semantic color dot plus text, with ready `oklch(59% 0.15 153)`, warning
  `oklch(69% 0.16 76)`, and danger `oklch(60% 0.2 27)`."
- "Build the active Annotate shell as a flat `100dvh` grid: source rail, flexible dark falling-note
  viewport, 64px vertical timeline, details rail. Use 1px dividers, no vertical preview gutter, no
  bottom layout strip, passive HUD over the viewport, and a low-contrast handle-free selection
  highlight on a bottom-start/top-end timeline."
