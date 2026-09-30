# Boardz Design System — Graphite

Boardz is a companion app for connected LED climbing boards (Moonboard, Kilter, Tension and others). It pairs with the board over Bluetooth, lights up problems, and lets climbers filter, sort, log sends, check rankings, watch beta videos, keep favorites lists and review their history. It runs on **phone** (on the mat between attempts), **tablet** (mounted by the board) and **desktop** (browsing and planning).

**Direction: Graphite.** Boardz should feel like a precision instrument for your wall. The UI is made of ink, paper and hairlines, and numbers are easy to read from the mat. **The only color on screen is light**: the board's LEDs and a few status lights. The brand has no hue of its own.

**Sources:** none. This system was built from scratch using the brief and the answers in chat. No logo, codebase or Figma file was provided. Direction explorations are in `explorations/`: A (chosen), plus B Guidebook and C Night Session for reference.

---

## Content fundamentals

- **Two registers.** *Labels* are terse, mono and uppercase: `MOONBOARD 2024 · 40°`, `SENDS`, `MOST SENT ↓`. *Messages* are playful climbing slang: "Flashed! First go. Filthy." / "Nothing here. Too spicy?"
- **Clarity first, flavor second.** Say what happened, then add a wink. Errors use no jargon: "Lost the board. Move closer and retry.", never "BLE GATT timeout".
- **Person:** speak to the climber as *you*. The app never says *I* or *we*.
- **Casing:** sentence case for titles, buttons and body. UPPERCASE is used only in mono labels.
- **Buttons:** 1–3 words, verb first: "Light it up", "Log", "Connect board", "Show 14 problems".
- **Vocabulary:** send, flash, project, beta, benchmark, sandbagged, soft, crux, "It'll go next session".
- **Numbers** are always mono and precise: `6C+`, `V8`, `1,204`, `28%`, `2.9`. Hold positions use board coordinates (`E4 G5 → F18`). Grades follow the user's setting (Font or V).
- **No emoji.** Stars (★) appear only as the quality mark in mono meta text.

## Visual foundations

- **Color.** The palette is warm-neutral *paper* (`#F4F3EF`) and *graphite* greys, with **ink `#151618` as the accent**. Primary buttons, selected cells and active tabs are all ink. In dark mode the roles swap: ink `#0E0F10` becomes the background and paper `#EDECE8` becomes the accent. Status colors (success, danger, warning, info) are muted inks with soft tints, used only for messages.
- **Light is the only chroma.** Hold colors follow each board's own LED convention (`--led-{moon|kilter|tension}-{start|hand|foot|finish}`). Generic status LEDs (`--led-green/blue/amber/red`) appear as small glowing dots: the connection pill, toasts, and the dot inside **Light it up**. Glow is `0 0 12px 2px color-mix(led 55%)`.
- **Grades are color-coded** by difficulty band, and this is the one hue outside of light. There are 7 bands on `--grade-1…7`: ≤6A+ green, 6B teal, 6C blue, 7A violet, 7B magenta, 7C red, and 8A+ ink/paper. V grades map to the same bands (`gradeBand()`). Grade color is used only on grades (tags, the big readout and grade charts). A tinted outline means open and a solid fill means sent. Light theme uses deep inks for 4.5:1 text; dark theme uses brighter tones.
- **The board panel is always dark** (`--board-panel #131416`) in both themes. It shows hole dots, unlit holds in `--board-hold`, and lit holds as 2px LED rings with a 16% tint and a glow.
- **Type.** Geist handles UI and titles: 600 weight with tight tracking (−0.045em display, −0.03em titles), body 15/22. Geist Mono handles all data: 10px uppercase labels at +0.08em, 17px values, 14px grades, and **300-weight readout numerals** at −0.07em for the big grade (64px phone, 88px board mode).
- **Signature details.** Crop marks frame the board. Coordinates sit outside the panel (1–18 on the left, A–K below). **Readout strips** show hairline-bounded rows of figures. Mono column headers sit over hairline tables. **Control strips** are hairline boxes split into cells, with the selected cell in ink.
- **Hairlines, not shadows.** Cards are 1px `--border-1` on surface. Controls use 1px `--border-2`. Tables use hairline rows with no zebra striping. `--shadow-1` is none; shadows exist only on floating layers (`--shadow-2` popovers, `--shadow-3` sheets, dialogs and toasts).
- **Corners** are softly rounded: 3 for mono tags, 5 for badges, 8 for grade tags and chips, 10 for buttons, inputs and strips, 14 for cards, 20 for sheets. Pills are used only for the connection indicator.
- **Backgrounds** are flat paper or ink. No gradients, textures or illustrations. The only imagery is beta video thumbnails; placeholders are dark panels with fine hatching.
- **Spacing:** 2/4/8/12/16/20/24/32/40/48/64. Gutters are 20 (phone), 24 (tablet) and 32 (desktop). Density is balanced, with 62px problem rows.
- **Tap targets** are at least 44px. Filter strips are 44px tall. **Board mode** (tablet at the wall) uses `xl` 56px buttons and 88px readouts.
- **Motion** is fast and functional: 80/140/220/360ms with `--ease-out`. LEDs fade on over 220ms, sheets slide up (phone) or fade and scale in (dialog), and scanning pulses the LED dot. There is no bounce.
- **States.** Hover moves a surface one step (`transparent → surface-3`) or darkens the hairline to `--border-strong`. Press is `scale(0.98)` on buttons and `0.94` on icon buttons. Focus is a 2px `--focus-ring` outline with a 2px offset. Disabled is 40% opacity.
- **Transparency** is used only for scrims (`--overlay`), LED tints and glows.
- **Layout.** Phone uses a big-title header (mono meta row, 38px title, mono count) and a 5-item bottom `TabBar`, with the primary action pinned in the thumb zone. Tablet uses a 76px `Rail` plus a list/detail split. Desktop uses a 248px `Sidebar` with the board status at the bottom, plus a list/detail split.

## Iconography

- **Lucide** (`lucide@0.460.0` via CDN) is the icon set: outline style, **1.75 stroke**, 20px default (22 in the tab bar, 16 inline). Render icons with the `Icon` component using kebab-case names. The SVGs used in explorations are copied to `assets/icons/`.
- Icons are always ink or graphite, never colored. `active` fills the glyph (heart, bookmark).
- LED dots are UI elements, not icons. There's no emoji and no custom icon font.
- **Logo:** none was provided. The wordmark is plain type: "boardz" in Geist 600 at −0.06em, followed by a lit blue LED dot (`guidelines/brand-wordmark.html`). Replace it when a real mark exists.

---

## Index

- `styles.css` is the entry point and contains only `@import`s. Tokens live in `tokens/`: `fonts.css` (Geist via Google Fonts), `colors.css`, `typography.css`, `spacing.css`, `motion.css` and `base.css`.
- `guidelines/` holds the foundation cards: Colors (paper & graphite, ink accent, grade colors, themes, status, status LEDs, hold LEDs), Type (display, body, mono, readout), Spacing (scale, radii, hairlines & elevation, layouts, motion) and Brand (wordmark, voice, signature details, icons).
- `components/` is split into groups:
  - `core/`: Icon, Button (`led`), IconButton, Badge (`mono outline`), Chip, Card, Avatar
  - `forms/`: TextField, Select, SegmentedControl (control strip, `multiple`), Checkbox, Radio, Switch, Stepper
  - `navigation/`: Tabs, TabBar, NavItem
  - `feedback/`: Toast (LED dot), Tooltip, Sheet (bottom sheet / dialog / side)
  - `climbing/`: BoardView (+ `holdCoords`), HoldMarker (+ `LED_SETS`), GradeBadge (`display`, `gradeBand`), ProblemRow, StatTile + ReadoutStrip, ConnectionPill, StarRating, VideoThumb
- `ui_kits/app/` is a click-through of phone, tablet and desktop in light and dark. It covers problems and filters, problem detail with the board, light-up, logging, beta, lists, rankings, history, settings and connect.
- `explorations/` holds the direction boards A/B/C.
- `assets/` contains `ds-runtime.js` (namespace helper for cards and kits) and `icons/` (Lucide SVGs).
- `SKILL.md` is the Agent Skill entry.

**Intentional additions:** the whole climbing group (domain-specific). `ReadoutStrip` is the Graphite figure row. `Stepper` is for logging attempts. `SegmentedControl` `multiple` replaces chip rows on touch.
