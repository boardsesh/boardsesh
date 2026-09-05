# @boardsesh/board-look

The Aura board look, as data: its tuning constants and the render-config fields
they produce.

Aura is the app's default drawing since 2.4 — a field-colour veil over the unlit
wall with each lit hold's traced silhouette glowing out of it. The look is
defined by ~20 numbers (glow reach, seam crossfade, veil buckets, fill alpha),
and every renderer has to send the same ones or it draws a different picture from
the same climb.

Those numbers used to live in `packages/mobile/src/lib/board-render-settings.ts`
next to the preference store, which imports React — so www and the backend could
not read them. Their Aura renders fell back to the Rust `GlowTuning` defaults and
drew a flatter, seam-notched glow than the app. This package is the fix: pure
data and pure functions, no React, no renderer, importable from mobile, web and
the backend alike.

## What is here

- `settings.ts` — the setting types, their option lists and slider bounds, the
  shipped defaults (`DEFAULT_BOARDSESH_RENDER_SETTINGS`), the glow tuning
  (`AURA_GLOW_TUNING`), the Woods reach multiplier (`AURA_BOARD_REACH_SCALE`), the play-field colours, and `resolveVeilOpacity`.
- `aura-fields.ts` — `buildAuraRenderFields`, which turns a settings object plus
  the per-board veil measurement into the snake_case block the Rust renderer
  consumes (`render_mode`, `veil`, `mark_style`, `glow_falloff`, `glow`, `fill`,
  `glyphs`, `led_cover`).

## What is not

The preference store, its sanitisers and migrations, the native capability probe
and the board-look onboarding step stay in `packages/mobile` — they are
preference plumbing, not tuning. The per-hold half of the config (silhouette
outlines, LED plates, silhouette lightness) comes from
`@boardsesh/board-art-geometry` and is assembled by each renderer's config
builder.

## Naming

The identifiers keep the pre-2.4 `boardsesh` spelling (`BoardseshRenderSettings`,
`DEFAULT_BOARDSESH_RENDER_SETTINGS`). Only the wire values were renamed to
`aura`; renaming the ~90 mobile call sites would buy a string nobody sees. New
names added here use `aura`.
