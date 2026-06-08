# AI Design Guidelines

A comprehensive, self-contained reference for AI agents redesigning Boardsesh components to match the established design language. All values in this document are sourced from the live codebase and should be treated as the single source of truth alongside `packages/web/app/theme/theme-config.ts`.

---

## Design Philosophy

Boardsesh follows a **modern, mobile-first aesthetic** inspired by apps like Spotify and Airbnb. The core principles:

- **Mobile-first**: Design for touch and small screens first, enhance for desktop
- **Progressive disclosure**: Show summary information by default, reveal detail on interaction (accordion cards, swipeable drawers, expandable panels)
- **Gestural interaction**: Swipe-to-reveal actions, drag-to-dismiss drawers, swipe-to-navigate between items
- **Warm organic palette**: A dusty rose primary with muted sage/brick accents rather than saturated primaries
- **Minimal visual weight**: Subtle shadows, thin borders, and generous whitespace over heavy decoration

---

## Design Tokens Reference

All tokens live in `packages/web/app/theme/theme-config.ts` and are exposed as CSS custom properties in `packages/web/app/components/index.css`.

> **Web vs. mobile.** The tables in this section are the **web** palette (maroon/sage). The React Native app (`packages/mobile`) uses a separate, logo-cohesive **"Velvet Send"** violet palette — see [Mobile palette — "Velvet Send"](#mobile-palette--velvet-send-packagesmobile). The two are intentionally independent; only the climbing **grade colours** are shared (`@boardsesh/board-constants`).

### Colors

| Token                  | Value     | CSS Variable            | Usage                                           |
| ---------------------- | --------- | ----------------------- | ----------------------------------------------- |
| `colors.primary`       | `#8C4A52` | `--color-primary`       | Brand accent, active states, selected borders   |
| `colors.primaryHover`  | `#7A3F47` | `--color-primary-hover` | Hover state for primary elements                |
| `colors.primaryActive` | `#6B353D` | --                      | Pressed state for primary elements              |
| `colors.secondary`     | `#6B7280` | --                      | Info/secondary actions                          |
| `colors.success`       | `#6B9080` | `--color-success`       | Completions, queue-added confirmation           |
| `colors.successHover`  | `#5A7A6C` | `--color-success-hover` | Success hover                                   |
| `colors.successBg`     | `#EFF5F2` | `--color-success-bg`    | Success background tint                         |
| `colors.warning`       | `#C4943C` | `--color-warning`       | Warnings, caution states                        |
| `colors.warningBg`     | `#FAF5EC` | `--color-warning-bg`    | Warning background tint                         |
| `colors.error`         | `#B8524C` | `--color-error`         | Favorites (filled heart), removals, destructive |
| `colors.errorBg`       | `#F9EFEE` | `--color-error-bg`      | Error background tint                           |
| `colors.purple`        | `#7C3AED` | --                      | Mirror button                                   |
| `colors.purpleHover`   | `#6D28D9` | --                      | Mirror button hover                             |
| `colors.amber`         | `#FBBF24` | --                      | Flash/benchmark badges                          |
| `colors.pink`          | `#EC4899` | --                      | Finish holds in climb creation                  |
| `colors.accentGreen`   | `#5fb27a` | --                      | Playlist tile + OG card accent (palette only)   |
| `colors.accentRose`    | `#d65a4f` | --                      | Playlist tile + OG card accent (palette only)   |

### Neutral Palette

| Token          | Value     | CSS Variable    | Usage                                                 |
| -------------- | --------- | --------------- | ----------------------------------------------------- |
| `neutral[50]`  | `#F9FAFB` | `--neutral-50`  | Pill backgrounds, switch group backgrounds            |
| `neutral[100]` | `#F3F4F6` | `--neutral-100` | Hover backgrounds, active press                       |
| `neutral[200]` | `#E5E7EB` | `--neutral-200` | Borders, dividers, pill borders                       |
| `neutral[300]` | `#D1D5DB` | `--neutral-300` | Drag handles, logged-out avatars, recent pill borders |
| `neutral[400]` | `#9CA3AF` | `--neutral-400` | Collapsed labels, pill icons, secondary text          |
| `neutral[500]` | `#6B7280` | `--neutral-500` | Pill text, meta text, sort toggles                    |
| `neutral[600]` | `#4B5563` | `--neutral-600` | Menu item icons, recent pill text                     |
| `neutral[700]` | `#374151` | `--neutral-700` | --                                                    |
| `neutral[800]` | `#1F2937` | `--neutral-800` | Primary text                                          |
| `neutral[900]` | `#111827` | `--neutral-900` | Headlines, accordion active labels, summary values    |

### Semantic Colors

| Token                      | Value                       | CSS Variable                 | Usage                                |
| -------------------------- | --------------------------- | ---------------------------- | ------------------------------------ |
| `semantic.selected`        | `rgba(140, 74, 82, 0.18)`   | `--semantic-selected`        | Selected item background (rose tint) |
| `semantic.selectedHover`   | `#EFE6E8`                   | `--semantic-selected-hover`  | Selected item hover                  |
| `semantic.selectedLight`   | `rgba(140, 74, 82, 0.06)`   | `--semantic-selected-light`  | Very subtle rose highlight           |
| `semantic.selectedBorder`  | `#8C4A52`                   | `--semantic-selected-border` | Matches primary                      |
| `semantic.background`      | `#F9FAFB`                   | `--semantic-background`      | Page background                      |
| `semantic.surface`         | `#FFFFFF`                   | `--semantic-surface`         | Card/surface backgrounds             |
| `semantic.surfaceElevated` | `#FFFFFF`                   | --                           | Elevated surfaces                    |
| `semantic.surfaceOverlay`  | `rgba(255, 255, 255, 0.95)` | `--semantic-surface-overlay` | Semi-transparent overlays            |

### Spacing Scale

Base unit: **4px**. All spacing uses this scale.

| Token         | Value  | Common Use                                  |
| ------------- | ------ | ------------------------------------------- |
| `spacing[0]`  | `0`    | --                                          |
| `spacing[1]`  | `4px`  | Tight gaps, icon margins                    |
| `spacing[2]`  | `8px`  | Form field gaps, small padding              |
| `spacing[3]`  | `12px` | List item padding, medium gaps              |
| `spacing[4]`  | `16px` | Standard padding, panel content gaps        |
| `spacing[5]`  | `20px` | --                                          |
| `spacing[6]`  | `24px` | Drawer header/body padding, section padding |
| `spacing[8]`  | `32px` | Large section spacing                       |
| `spacing[10]` | `40px` | --                                          |
| `spacing[12]` | `48px` | Menu item height, button height             |
| `spacing[16]` | `64px` | Thumbnail width                             |

### Typography

**Font Stack:**

```
-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif
```

| Token             | Value  | Use                                                          |
| ----------------- | ------ | ------------------------------------------------------------ |
| `fontSize.xs`     | `12px` | Captions, meta text, section labels, recent pills            |
| `fontSize.sm`     | `14px` | Body secondary, pill text, collapsed labels, difficulty text |
| `fontSize.base`   | `16px` | Body primary, menu items, form inputs                        |
| `fontSize.lg`     | `18px` | User name in profile                                         |
| `fontSize.xl`     | `20px` | Climb name in list items, section titles                     |
| `fontSize['2xl']` | `24px` | Grade display in list items                                  |
| `fontSize['3xl']` | `30px` | Large display text                                           |

| Token                 | Value | Use                                                |
| --------------------- | ----- | -------------------------------------------------- |
| `fontWeight.normal`   | `400` | Body text, collapsed labels                        |
| `fontWeight.medium`   | `500` | Summary values, medium emphasis                    |
| `fontWeight.semibold` | `600` | Titles, drawer headers, section labels, user names |
| `fontWeight.bold`     | `700` | Grade display, active accordion labels             |

| Token                | Value  |
| -------------------- | ------ |
| `lineHeight.tight`   | `1.25` |
| `lineHeight.normal`  | `1.5`  |
| `lineHeight.relaxed` | `1.75` |

### Border Radius

| Token               | Value    | Use                                              |
| ------------------- | -------- | ------------------------------------------------ |
| `borderRadius.none` | `0`      | --                                               |
| `borderRadius.sm`   | `4px`    | Grade select, small inputs                       |
| `borderRadius.md`   | `8px`    | Menu items, switch groups, user drawer           |
| `borderRadius.lg`   | `12px`   | Section cards, switch groups, search buttons     |
| `borderRadius.xl`   | `16px`   | Accordion section cards                          |
| `borderRadius.full` | `9999px` | Pills (search pills, recent pills, filter pills) |

### Shadows

| Token           | Value                                                                     | Use                             |
| --------------- | ------------------------------------------------------------------------- | ------------------------------- |
| `shadows.xs`    | `0 1px 2px 0 rgba(0, 0, 0, 0.05)`                                         | Subtle elevation                |
| `shadows.sm`    | `0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)`       | Default card shadow, pill hover |
| `shadows.md`    | `0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)`    | Hover-elevated cards            |
| `shadows.lg`    | `0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)`  | Modals, elevated panels         |
| `shadows.xl`    | `0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)` | Top-level overlays              |
| `shadows.inner` | `inset 0 2px 4px 0 rgba(0, 0, 0, 0.05)`                                   | Inset depth                     |

### Transitions

| Token                | Value        | Use                                   |
| -------------------- | ------------ | ------------------------------------- |
| `transitions.fast`   | `150ms ease` | Hovers, tab color changes, snap-backs |
| `transitions.normal` | `200ms ease` | Fades, summary opacity, snap-backs    |
| `transitions.slow`   | `300ms ease` | Drawers, panels, swipe exits          |

### Z-Index Scale

| Token             | Value  |
| ----------------- | ------ |
| `zIndex.dropdown` | `1000` |
| `zIndex.sticky`   | `1020` |
| `zIndex.fixed`    | `1030` |
| `zIndex.modal`    | `1040` |
| `zIndex.popover`  | `1050` |
| `zIndex.tooltip`  | `1060` |

---

## Mobile palette — "Velvet Send" (`packages/mobile`)

The React Native app is recolored onto a **violet brand** anchored on the logo (built from the V11–V16 grade purples). Tokens live in `packages/mobile/src/theme/colors.ts` as `brandColors` (light) + `brandColorsDark` (dark overrides). They are resolved per colour scheme by the ThemeProvider and exposed as **`useTheme().brandColors`** — components must read brand colours from the theme wherever the scheme matters, **not** from the static import. Material-variant components additionally read these via `buildPaperTheme` (`paper-theme.ts`).

### Brand & semantic

| Role          | Light     | Dark      | Usage                                                            |
| ------------- | --------- | --------- | --------------------------------------------------------------- |
| `primary`/`tint` | `#6D28D9` | `#A78BFA` | Foreground brand: text, icons, links, borders, accent bars      |
| `primaryFill` | `#6D28D9` | `#7C3AED` | Filled surface/button background (pair with `onPrimary`)         |
| `onPrimary`   | `#FFFFFF` | `#FFFFFF` | Text/icon on `primaryFill`                                       |
| `accent`      | `#FF8A3D` | `#FF8A3D` | Amber spark for highlights — **fill-only, always dark text**     |
| `success`     | `#047857` | `#34D399` | Sends, positive confirmation                                    |
| `warning`     | `#B45309` | `#FBBF24` | Flashes, caution                                                |
| `error`       | `#C81E1E` | `#F87171` | Destructive, removals                                           |

Contrast (WCAG): white-on-`#6D28D9` 7.10:1 · `#A78BFA` tint ≥6.12:1 across the dark ladder · white-on-`#7C3AED` 5.70:1 · black-on-`#FF8A3D` 8.95:1 (white-on-amber fails, so accent is fill-only).

> **Scheme-aware rule.** Use `useTheme().brandColors.primary` for any brand **foreground** so dark mode lifts to `#A78BFA`. The static `brandColors` import is only safe for **fills** that carry white/`onPrimary` text (e.g. filled buttons, swipe-action panels), where the value is legible in both schemes. A number of legacy static foreground sites are not yet ported — tracked as a follow-up.

### Neutrals

- **Liquid Glass variant** (iOS): neutrals come from `PlatformColor` (system materials, auto-adapting). **Android fallback** is a violet-tinted set in `androidFallbackColors` (light bg `#F4F1FB` / dark bg `#0F0B16`, label `#16111F` / `#F5F2FB`, opaque secondary labels for AA).
- **Material 3 variant** (any platform): `materialSurfaces` — violet-tinted tonal surfaces (light bg `#F3EFFA`, surface `#FFFFFF`, fill `rgba(109,40,217,0.14)`; dark bg `#15101E`, surface `#221A33`, elevated `#2A2142`).

### Grade colours (shared with web + backend)

The yellow→red→purple grade arc in `@boardsesh/board-constants/grade-colors.ts` was refreshed (V0 `#FFD400` → V10 `#7E1C8E`); the V11–V16 logo purples are unchanged. Luminance descends monotonically except the documented V10→V11 step (the logo purple is brighter than its grape neighbour) — guarded by a test in `board-constants/src/__tests__/grade-colors.test.ts`. Grade-pill text is auto-picked for contrast (`readableTextColor`), so refreshed hexes stay AA without per-pill colours.

> Climbing **hold** colours (`hold-states.ts`) are board data, fully decoupled from the theme — the recolor never affects rendered holds.

## Color Usage Rules

### Primary Rose (`#8C4A52`)

- Brand accent in headers and navigation
- Active tab indicator in bottom tab bar
- Selected item borders (`semantic.selectedBorder`)
- Active indicator dots on pills (6px circle)
- Avatar background for logged-in users
- Queue badge background
- Swipe-to-reveal left action background (favorite)

### Success Green (`#6B9080`)

- Tick badge when user has a successful ascent
- Queue-added confirmation icon (`CheckCircleOutlined`)
- Temporary "recently added" state (5-second cooldown)

### Error Red (`#B8524C`)

- Filled favorite heart icon
- Tick badge when no successful ascent
- Logout menu item text
- Swipe-to-reveal right action background (queue add) in some contexts
- Destructive action confirmation

### Neutrals for Text Hierarchy

- **`neutral[900]`** (`#111827`): Headlines, active accordion labels, summary values
- **`neutral[800]`** (`#1F2937`): Primary body text
- **`neutral[600]`** (`#4B5563`): Menu item icons, recent pill text
- **`neutral[500]`** (`#6B7280`): Pill body text, meta information, sort toggles
- **`neutral[400]`** (`#9CA3AF`): Collapsed accordion labels, pill icons, inactive tab icons, placeholder text
- **`neutral[300]`** (`#D1D5DB`): Drag handles, logged-out avatar background
- **`neutral[200]`** (`#E5E7EB`): All borders and dividers
- **`neutral[100]`** (`#F3F4F6`): Hover backgrounds
- **`neutral[50]`** (`#F9FAFB`): Pill backgrounds, switch group backgrounds

### Grade Colors

Climbing difficulty is represented by a spectrum from yellow through red to purple (sourced from `packages/web/app/lib/grade-colors.ts`):

- **V0-V2**: Yellow to orange (`#FFEB3B` to `#FF9800`)
- **V3-V4**: Deep orange to red-orange (`#FF7043` to `#FF5722`)
- **V5-V6**: Red spectrum (`#F44336` to `#E53935`)
- **V7-V10**: Dark red to red-purple (`#D32F2F` to `#A11B4A`)
- **V11+**: Purple spectrum (`#9C27B0` to `#2A0054`)

**Grade utility functions** (from `packages/web/app/lib/grade-colors.ts`):

| Function                                   | Returns                           | Use                                          |
| ------------------------------------------ | --------------------------------- | -------------------------------------------- |
| `getGradeColor(difficulty)`                | Hex color string                  | Direct grade color for text/badges           |
| `getGradeTintColor(difficulty, 'default')` | Light HSL: `hsl(hue, 30%, 88%)`   | Queue bar backgrounds, card tints            |
| `getGradeTintColor(difficulty, 'light')`   | Lighter HSL: `hsl(hue, 20%, 94%)` | List item selected backgrounds               |
| `getSoftGradeColor(difficulty)`            | Muted HSL: `hsl(hue, 72%, 44%)`   | Large/bold grade text in list views          |
| `getGradeTextColor(gradeColor)`            | `#000000` or `#FFFFFF`            | Contrast text over grade-colored backgrounds |

### Semantic Selected Tints

- **`semantic.selected`** (`rgba(140, 74, 82, 0.18)`): Selected list item background (subtle rose)
- **`semantic.selectedHover`** (`#EFE6E8`): Selected item hover state
- **`semantic.selectedLight`** (`rgba(140, 74, 82, 0.06)`): Ultra-subtle highlight
- Grade-tinted backgrounds override `semantic.selected` when a climb is selected (uses `getGradeTintColor(difficulty, 'light')`)

---

## Dark Mode

Dark mode uses a Spotify-inspired **layered grey palette**, not pure black. The body sits at `#0E0E0E` and each elevation level steps _lighter_ (surface `#1A1A1A`, elevated `#282828`) so drawers and dialogs read as floating above the page instead of blending into a flat black.

Tokens live in `darkTokens` in `packages/web/app/theme/theme-config.ts` and are mirrored as CSS custom properties in `packages/web/app/components/index.css`.

### Dark Mode Surfaces (layered)

| Layer    | Token                                 | Value     | Usage                                                              |
| -------- | ------------------------------------- | --------- | ------------------------------------------------------------------ |
| Body     | `darkTokens.semantic.background`      | `#0E0E0E` | `html` / `body`, scrollable chrome, climb list background          |
| Surface  | `darkTokens.semantic.surface`         | `#1A1A1A` | Drawers, queue control bar, accordion search form, search dropdown |
| Elevated | `darkTokens.semantic.surfaceElevated` | `#282828` | MUI `background.paper` → dialogs, menus, popovers                  |
| Input    | `darkTokens.semantic.inputSurface`    | `#FFFFFF` | All input field backgrounds (see below)                            |

`html` / `body` bind to `var(--semantic-background)` — the body is the lowest layer, drawers sit above it, dialogs above drawers. Do not use `--semantic-surface` for the page background.

### Dark Mode Neutrals

Unlike light mode, the dark neutral ladder is _not_ cleanly inverted — the lower steps are tuned so "slightly above surface", "divider", and "text.secondary" have perceptible contrast against the layered greys.

| Token                         | Value     | Common use in dark                                                       |
| ----------------------------- | --------- | ------------------------------------------------------------------------ |
| `neutral[50]`                 | `#121212` | Subtle recessed fills sitting just above body (e.g. accordion summaries) |
| `neutral[100]`                | `#222222` | Queue history row, scrollbar track, faint elevation above surface        |
| `neutral[200]`                | `#333333` | Dividers in MUI Accordion / Menu contexts                                |
| `neutral[300]`                | `#3A3A3A` | Scrollbar thumb, strong borders                                          |
| `neutral[400]`                | `#6B7280` | (unchanged from light)                                                   |
| `neutral[500]`                | `#B3B3B3` | **`text.secondary`** — Spotify-style subtitle grey                       |
| `neutral[600]`–`neutral[900]` | unchanged | Text greys; `900 = #F9FAFB` (near-white) for primary text                |

### Row hairlines

Use `var(--border-subtle)` (surface-relative, resolves to `rgba(255, 255, 255, 0.10)` in dark) for row separators in climb lists and card lists. Do **not** use `--neutral-200` for hairlines — it's tuned for stronger dividers and will read too heavy.

### Translucent overlays on the layered palette

Historically the global header, bottom tab bar, and offline banner used `rgba(0, 0, 0, X)` overlays — those render _darker_ than the new grey body and break the "floating above" feel. In dark mode they now use grey-tinted translucents (`rgba(26, 26, 26, 0.7)` / `rgba(40, 40, 40, 0.85)`) that sit lighter than the body and read as lifted.

### White Input Fields (Intentional)

Dark mode uses **white input fields** (`darkTokens.semantic.inputSurface`) on dark backgrounds. This is a deliberate design decision for high contrast and clarity — inputs must stand out from the surrounding dark UI.

All input variants (TextField, OutlinedInput, FilledInput, Select, Autocomplete) use white backgrounds with dark text (`themeTokens.neutral[800]`) in dark mode. These overrides are defined in `darkComponents` in `packages/web/app/theme/mui-theme.ts`.

**Do not change dark mode input backgrounds to dark colors.** This is not a bug — it is the intended design.

---

## Typography Hierarchy

### Display Grade

```css
font-size: 24px; /* fontSize['2xl'] */
font-weight: 700; /* fontWeight.bold */
color: <grade-color>; /* from getGradeColor() or getSoftGradeColor() */
```

### Section Title

```css
font-size: 20px; /* fontSize.xl */
font-weight: 600; /* fontWeight.semibold */
color: var(--neutral-900);
```

### Active Accordion Label

```css
font-size: 22px; /* custom, transitions from 14px */
font-weight: 700; /* fontWeight.bold */
color: var(--neutral-900);
line-height: 1.2;
transition:
  font-size 250ms ease,
  color 250ms ease;
```

### Body Primary

```css
font-size: 16px; /* fontSize.base */
font-weight: 400; /* fontWeight.normal */
color: var(--neutral-800);
```

### Body Secondary

```css
font-size: 14px; /* fontSize.sm */
font-weight: 400; /* fontWeight.normal */
color: var(--neutral-500);
```

### Meta / Caption

```css
font-size: 12px; /* fontSize.xs */
font-weight: 400; /* fontWeight.normal */
color: var(--neutral-500);
```

### Section Label (Uppercase)

```css
font-size: 12px; /* fontSize.xs */
font-weight: 600; /* fontWeight.semibold */
text-transform: uppercase;
letter-spacing: 0.5px;
color: var(--neutral-500);
```

### Menu Item

```css
font-size: 15px; /* between sm and base */
font-weight: 400;
color: inherit;
```

### Tab Label

```css
font-size: 10px;
line-height: 1;
margin-top: 2px;
```

---

## Core UX Patterns

### 1. Swipeable Drawers

Bottom-sheet drawers are the primary container for detail views and forms.

**Structure:**

```
SwipeableDrawer (MUI)
├── Drag Handle Zone (mobile only)
│   └── Horizontal bar: 36px x 4px, border-radius 2px, neutral-300
├── Header
│   ├── Title (h6, semibold, base size)
│   ├── Extra controls (right-aligned)
│   └── Close button (desktop only)
├── Body (padding: 24px)
└── Footer (optional, border-top: 1px solid neutral-200)
```

**Responsive behavior:**

- **Mobile (<768px)**: Drag handle visible, close button hidden, swipe-to-dismiss enabled
- **Desktop (>=768px)**: Drag handle hidden, close button visible, no swipe-to-dismiss

**Props pattern:**

- `height`: Default `70vh`, use `auto` for forms
- `keepMounted`: Use for performance when drawer has heavy content
- `disablePortal`: Use for nested drawers
- `placement`: `'bottom'` (default), `'left'`, `'right'`, `'top'`

**Header padding:** `16px 24px` with `border-bottom: 1px solid var(--neutral-200)`.

### 2. Swipe-to-Reveal List Items

List items support horizontal swiping to reveal action panels behind them.

**Configuration:**

- Maximum swipe distance: `120px`
- Action trigger threshold: `100px`
- Direction detection: First `10px` of touch movement determines horizontal vs. vertical
- DOM-direct manipulation during drag (no React state updates for 60fps performance)
- Snap-back animation: `150ms ease`

**Action panels:**

- Left panel (swipe right to reveal): Primary rose background (`#8C4A52`), white icon
- Right panel (swipe left to reveal): Error red background (`#B8524C`), white icon
- Icon size: `20px`
- Container: `overflow: hidden` to constrain animation

**Item layout:**

```
[Thumbnail 64px] [Text Column: name (20px semibold) + subtitle (12px)] [Grade (24px bold, colored)] [Actions ...]
```

- Padding: `8px 12px`
- Gap: `12px`
- Border-bottom: `1px solid var(--neutral-200)`
- Selected background: grade-tinted via `getGradeTintColor(difficulty, 'light')` or `semantic.selected`

### 3. Playful Summary Pills

Used in the search drawer to show active filter state.

**Search pills (`.pill`):**

```css
border-radius: 9999px;
padding: 6px 14px;
background: var(--neutral-50);
border: 1px solid var(--neutral-200);
font-size: 14px;
color: var(--neutral-500);
transition: box-shadow 200ms ease;
gap: 8px;
```

- Hover: `box-shadow: var(--shadow-sm)`
- Active: `background: var(--neutral-100)`
- Active indicator: 6px circle, `border-radius: 50%`, `background: var(--color-primary)`
- Icon: `14px`, `color: var(--neutral-400)`

**Recent search pills (`.pill` in recent-search-pills):**

```css
padding: 2px 10px;
border-radius: 9999px;
border: 1px solid var(--neutral-300);
background: var(--semantic-surface);
font-size: 12px;
color: var(--neutral-600);
gap: 4px;
transition:
  background-color 150ms ease,
  border-color 150ms ease;
```

- Container: Horizontally scrollable, hidden scrollbar (`scrollbar-width: none`)
- Hover: `background: var(--neutral-100)`, `border-color: var(--neutral-400)`
- Active: `border-color: var(--color-primary)`, `background: var(--semantic-selected)`, `color: var(--color-primary-hover)`
- Icon: `10px`, primary-colored when active

### 4. Accordion Stepped Cards

Filter sections that expand one at a time, with animated label scaling.

**Card container:**

```css
background: var(--semantic-surface);
border-radius: 16px;
box-shadow:
  0 1px 2px rgba(0, 0, 0, 0.06),
  0 1px 3px rgba(0, 0, 0, 0.08);
overflow: hidden;
transition: box-shadow 200ms ease;
```

- Hover (inactive): Shadow increases to `0 2px 6px rgba(0, 0, 0, 0.1), 0 1px 3px rgba(0, 0, 0, 0.08)`
- Active: Shadow elevated to `0 3px 10px rgba(0, 0, 0, 0.1), 0 1px 4px rgba(0, 0, 0, 0.06)`

**Collapsed row:**

- Padding: `18px 24px` (active: `24px 24px 4px 24px`)
- Label: `14px`, `fontWeight: 400`, `color: var(--neutral-400)`
- Summary value: `14px`, `fontWeight: 500`, `color: var(--neutral-900)`, right-aligned, max-width 65%

**Active state transition (250ms ease):**

- Label scales: `14px` -> `22px`, weight `400` -> `700`, color `neutral-400` -> `neutral-900`
- Summary fades out: `opacity: 1` -> `opacity: 0`
- Content expands via `grid-template-rows: 0fr` -> `1fr` (250ms ease)

**Switch groups inside expanded cards:**

```css
background: var(--semantic-background); /* neutral-50 */
border-radius: 12px;
padding: 4px 0;
```

- Switch rows: `padding: 12px 16px`, hover `background: var(--neutral-100)`, transition `150ms ease`

**Mobile adjustments (<768px):**

- Container gap: `10px` (vs `12px`)
- Collapsed padding: `16px 20px`
- Active label: `20px` (vs `22px`)
- Panel padding: `12px 20px 20px`

### 5. Queue Control "Now Playing" Bar

Persistent footer bar showing the current climb with swipe navigation.

**Bar structure:**

```
MuiCard (outlined)
└── CardContent
    └── swipeWrapper (overflow: hidden)
        └── swipeContainer
            ├── Left: [Thumbnail 36px] [Text with swipe clip]
            └── Right: [Mirror] [Play] [Prev/Next] [Party] [Tick]
```

**Styling:**

- Desktop: `border-top: 1px solid var(--neutral-200)`, no border-radius
- Mobile: `border-radius: 4px`, `box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12)`
- Background: `var(--semantic-surface)`, optionally grade-tinted

**Swipe text animation:**

- Current text slides off-screen: `transform: translateX(exitOffset)`, `300ms ease-out`
- Peek text (next/previous) positioned off-screen, moves with swipe offset
- Snap-back: `200ms ease`
- Clip exit (text leaves visible area): `100ms`

**Thumbnail crossfade:**

```css
@keyframes thumbnailFadeIn {
  from {
    opacity: 0;
    transform: scale(0.85);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
animation: thumbnailFadeIn 120ms ease-out;
```

**Swipe thresholds:**

- Trigger threshold: `80px`
- Exit duration: `300ms`
- Enter animation duration: `170ms`

**Desktop shadow (pseudo-element):**

```css
.queue-bar-shadow::before {
  background: linear-gradient(to top, rgba(0, 0, 0, 0.06), transparent);
  height: 4px;
  top: -4px;
}
```

Hidden on mobile.

### 6. Scroll-Based Drawer Expansion

The queue drawer dynamically expands from partial to full height based on scroll position.

- Start height: `60%` of viewport
- End height: `100%` of viewport
- Easing: Quadratic ease-out: `1 - (1 - progress)^2`
- Uses passive scroll listener for performance
- Height transition: `300ms cubic-bezier(0.4, 0, 0.2, 1)`
- Scroll container: `-webkit-overflow-scrolling: touch`, `overscroll-behavior-y: contain`

### 7. Bottom Tab Bar

Mobile-only navigation bar with glassmorphism effect.

> **Web responsive bar only.** The CSS below is the web app's narrow-viewport tab bar. The React Native (Expo) app implements its tab bar with native Liquid Glass via `GlassSurface` — see [React Native App: Liquid Glass & Appearance](#react-native-app-liquid-glass--appearance).

**Styling:**

```css
background: rgba(255, 255, 255, 0.5);
-webkit-backdrop-filter: blur(10px);
backdrop-filter: blur(10px);
padding-top: 4px;
padding-bottom: env(safe-area-inset-bottom, 0px);
```

**Tab items:**

- Layout: Flex column, centered
- Padding: `6px 0 4px`
- Icon size: `20px`
- Label: `10px`, `margin-top: 2px`, `line-height: 1`
- Active color: `var(--color-primary)` (`#8C4A52`)
- Inactive color: `var(--neutral-400)` (`#9CA3AF`)
- Transition: `color 150ms ease`
- Touch handling: `-webkit-tap-highlight-color: transparent`, `touch-action: manipulation`

**Responsive:**

- Hidden at `min-width: 768px` (desktop uses sidebar/header navigation)
- Safe area insets for notched devices

---

## Interactive States

### Hover

```css
transition: <property> 150ms ease;
```

- Background change: `transparent` -> `var(--neutral-100)` (menu items, switch rows)
- Shadow lift: `shadow-sm` -> `shadow-md` (cards)
- Pill: Add `box-shadow: var(--shadow-sm)`

### Active / Pressed

```css
background: var(--neutral-200);
```

Or for interactive surfaces:

```css
background: var(--neutral-100); /* lighter press on already-hovered */
```

### Selected

- Grade-tinted background via `getGradeTintColor(difficulty, 'light')`
- Or `semantic.selected` (`rgba(140, 74, 82, 0.18)`) for non-grade items
- Active recent pill: `border-color: var(--color-primary)`, `background: var(--semantic-selected)`

### Disabled

```css
opacity: 0.5;
cursor: not-allowed;
pointer-events: none; /* optional, depends on context */
```

### Loading

- Inline: `<CircularProgress size={16} />` next to or replacing the action element
- Do not block the entire UI; show loading state on the specific action

---

## Animation & Motion

| Category        | Duration | Easing                         | Use Cases                                                         |
| --------------- | -------- | ------------------------------ | ----------------------------------------------------------------- |
| Fast            | `150ms`  | `ease`                         | Hover states, color transitions, snap-backs, tab switches         |
| Normal          | `200ms`  | `ease`                         | Fades, summary opacity, snap-back after swipe, shadow transitions |
| Slow            | `300ms`  | `cubic-bezier(0.4, 0, 0.2, 1)` | Drawer open/close, panel expand, swipe exit                       |
| Accordion       | `250ms`  | `ease`                         | Label scale, grid-template-rows expand, padding shift             |
| Thumbnail enter | `120ms`  | `ease-out`                     | `scale(0.85)` -> `scale(1)` + opacity `0` -> `1`                  |
| Swipe exit      | `300ms`  | `ease-out`                     | Text sliding off-screen                                           |
| Swipe snap-back | `200ms`  | `ease`                         | Returning to origin after incomplete swipe                        |

**Hover lift pattern:**

```css
transform: translateY(-1px);
transition: transform 150ms ease;
```

**Accordion expand (CSS Grid animation):**

```css
.expandableContent {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 250ms ease;
}
.expandableContent.open {
  grid-template-rows: 1fr;
}
.expandableInner {
  overflow: hidden;
  min-height: 0;
}
```

---

## Responsive Patterns

### Breakpoint

The single primary breakpoint is **768px**.

| Aspect            | Mobile (<768px)                           | Desktop (>=768px)                         |
| ----------------- | ----------------------------------------- | ----------------------------------------- |
| Navigation        | Bottom tab bar                            | Hidden tab bar (sidebar/header)           |
| Drawers           | Drag handle, full-width, swipe-to-dismiss | Close button, constrained width           |
| Swipe gestures    | Primary interaction model                 | Hidden (show prev/next buttons)           |
| Queue bar         | Rounded with shadow, swipe navigation     | Full-width, border-top, button navigation |
| Accordion padding | `16px 20px`                               | `18px 24px`                               |

### Implementation Rules

- **CSS media queries only**: Never use JavaScript breakpoint detection
- **CSS modules**: Co-located `.module.css` files, not inline styles
- **Safe area insets**: Use `env(safe-area-inset-bottom)` for bottom-anchored elements on notched devices
- **Touch handling**: Use `-webkit-tap-highlight-color: transparent` and `touch-action: manipulation` on interactive elements

---

## Surface & Card Patterns

### Default Card

```css
background: var(--semantic-surface); /* white */
border: 1px solid var(--neutral-200);
border-radius: 12px; /* or 16px for larger cards */
box-shadow: var(--shadow-sm);
```

### Elevated Card (hover)

```css
box-shadow: var(--shadow-md);
transition: box-shadow 200ms ease;
```

### Section Card (accordion)

```css
border-radius: 16px;
box-shadow:
  0 1px 2px rgba(0, 0, 0, 0.06),
  0 1px 3px rgba(0, 0, 0, 0.08);
```

### Dividers

```css
height: 1px;
background: var(--neutral-200);
margin: 8px 0;
```

Or as border:

```css
border-bottom: 1px solid var(--neutral-200);
```

### Rules

- No heavy gradients or strong box-shadows
- White backgrounds for surfaces (`semantic.surface`)
- Selected items use grade-tinted backgrounds, not colored borders
- Borders are always `1px solid var(--neutral-200)` unless selected

---

## Button & Action Patterns

### Icon Buttons

- Use MUI `<IconButton size="small">`
- Default icon size: `20px` (action bar), `16px` (inline), `14px` (compact)
- Transition: `color 0.2s ease`
- Hover: `opacity: 0.8`

### Icon Color States

| State              | Style                                 | Example             |
| ------------------ | ------------------------------------- | ------------------- |
| Default            | Inherited / neutral                   | Outlined icon       |
| Active (favorited) | `color: var(--color-error)`           | Filled heart        |
| Active (queued)    | `color: var(--color-success)`         | Filled check circle |
| Active (mirror)    | Primary bg + white icon               | Toggle button       |
| Disabled           | `opacity: 0.5`, `cursor: not-allowed` | --                  |

### Action Bars

```css
display: flex;
justify-content: space-around;
align-items: center;
padding: 8px 16px 12px;
```

### Badges

```css
.MuiBadge-badge {
  backgroundcolor: <semantic-color>; /* success or error */
  color: white;
}
```

- Max value: `99` (displays as "99+")

### Action Tooltips

- Disabled on touch devices (uses `@media (hover: none)` detection)
- Ensures immediate tap-to-action on mobile without tooltip delay

### Menu Items (Drawer Lists)

```css
height: 48px;
padding: 0 16px;
gap: 12px;
font-size: 15px;
border-radius: 8px;
transition: background 150ms ease;
```

- Icon container: `24px` width, `18px` font-size, `color: var(--neutral-600)`
- Hover: `background: var(--neutral-100)`
- Active: `background: var(--neutral-200)`
- Danger items: `color: var(--color-error)`

### Search Footer Button

```css
variant: 'contained';
size: 'large';
border-radius: 12px;
height: 48px;
padding: 0 24px;
```

- Shows result count inline: "Search . 123"

---

## React Native App: Liquid Glass & Appearance

The Expo app (`packages/mobile/`) is a separate implementation from the web CSS above. It does **not** use CSS `backdrop-filter`; it uses Apple's iOS 26 Liquid Glass material with graceful fallbacks. Tokens live in `packages/mobile/src/theme/`, not `theme-config.ts`.

### GlassSurface

`packages/mobile/src/components/GlassSurface.tsx` is the single primitive for every translucent surface. It resolves the best material per device:

| Condition                                   | Material                                              |
| ------------------------------------------- | ----------------------------------------------------- |
| iOS 26+ (Liquid Glass available)            | `expo-glass-effect` `GlassView`                       |
| iOS < 26                                    | `@react-native-community/blur` `BlurView` (frosted)   |
| Android                                     | Solid themed surface (`systemColors.secondaryBackground`) |
| Reduce Transparency on (any platform)       | Solid themed surface                                  |

Props: `glassEffectStyle` (`'regular'` for frosted chrome, `'clear'` for content-forward), `tintColor` (translucent hue composited onto the glass), `fallbackColor` (solid path).

**Material: lean on what the OS provides.** Native iOS 26 Liquid Glass (`GlassView`) exposes only `'regular'` and `'clear'`, so we use exactly those — there are no custom "thin"/"thick" thicknesses. Every glass FAB and capsule uses `'regular'`; the iOS < 26 `BlurView` fallback uses `GlassSurface`'s single default `blurAmount`. Legibility over busy/bright content comes from a high-contrast glyph/text colour, not from tuning the material.

### Where glass is allowed

Glass is for **floating chrome only** — never for content canvases or text-heavy reading surfaces (Apple's HIG, and washed-out/illegible content otherwise). FABs and capsules carry **no solid colour fill**: colour rides the icon/text (and, for state, a translucent native `tintColor`), never an opaque background.

- **Glass:** the bottom tab bar (`BlurTabBar`), the persistent floating toolbar — the climb-name capsule (`ClimbCapsule`), log-ascent FAB (`LogAscentFab`), and search FAB (`SearchFab`) — the `QuickTickBar`, the create-playlist FAB, the top board-name chrome (`ClimbTopChrome`), the session overlay (`SessionScreenHost`), and the `PlayDrawer` background. All use `'regular'` glass.
- **Opaque:** the remaining bottom sheets (`Sheet`, `QueueSheet`, `AngleSelectorSheet`, etc.) use themed `secondaryBackground`.

### Dark mode & appearance

- iOS resolves system colors via `PlatformColor` (auto-adapting); Android uses the `androidFallbackColors.{light,dark}` maps in `theme/colors.ts`. Components read everything through `useTheme().systemColors`.
- A **Light / Dark / System** toggle lives in More → Appearance. `ColorSchemePreferenceProvider` persists the choice and calls `Appearance.setColorScheme(...)`, which overrides the app's native trait collection so `PlatformColor`, the status bar, and the glass all follow in lockstep. `app.config.ts` stays `userInterfaceStyle: 'automatic'` so the override can take effect at runtime.
- `elevatedSurface` (`tertiarySystemBackground` on iOS) is the token for a raised tile over a secondary/fill surface — e.g. the selected segmented-control pill.

### Material variant (react-native-paper)

The mobile app ships **two visual variants**, switchable in More → **UI style** (Auto / Liquid Glass / Material). Liquid Glass (above) is the preferred, primary UI; **Material** is the default on non-iOS-26 devices and renders authentic Material 3 via `react-native-paper`. The resolved variant is exposed as `useTheme().variant` (`'liquidGlass' | 'material'`) — resolved in `ThemeProvider` from the persisted `uiVariantPreference` (`src/theme/resolve-ui-variant.ts`).

**Our theme stays the source of truth.** `src/theme/paper-theme.ts` `buildPaperTheme(colorScheme, dynamic?)` maps our tokens (`materialSurfaces`, `brandColors`) onto MD3 colour roles and feeds `PaperProvider` (mounted by `src/providers/material-theme-provider.tsx`, under `ThemeProvider`). Paper's MD3 type scale + shapes stay as defaults (system font). On Android 12+ in the Material variant, `@pchmn/expo-material3-theme` supplies the device Material You palette; unsupported devices keep the static "Velvet Send" violet Material map.

**Material You must reach both theme paths.** `ThemeProvider` gates dynamic color to `variant === 'material' && isDynamicThemeSupported`, passes that palette to Paper, and converts it into the `systemColors` shape used by token-skinned surfaces. Do not feed dynamic color only to Paper; the tab bar, gorhom sheets, accessory bar, `ListRow`, `GradeChip`, and `GlassSurface` material branch must stay palette-consistent.

**Per-primitive dispatch convention** — when adding/migrating a primitive, branch on the variant and keep the Liquid Glass body untouched in the `else`:

```tsx
export function Button(props: ButtonProps) {
  const { variant: uiVariant } = useTheme();
  return uiVariant === 'material' ? <ButtonMaterial {...props} /> : <ButtonGlass {...props} />;
}
```

The public prop API must stay identical across both branches so call sites never change. `Button.tsx` is the exemplar.

- **Icons:** Paper resolves icons through the app's `@expo/vector-icons` MaterialCommunityIcons (wired via `PaperProvider settings.icon`), so pass the **MDI** name — bridge our semantic `IconName` with `iconMap[name].android` (`src/components/icon-map.ts`).
- **Paper-backed today:** Button, SegmentedControl→`SegmentedButtons`, SwitchRow→`Switch`, Badge, GlassIconButton→`IconButton`, Card, Toast/QueueAddedSnackbar→`Snackbar`, SearchHeader→`Searchbar`.
- **Token-skinned but palette-consistent** (they read the same static or dynamic Material surface ladder that feeds the Paper theme): `ListRow`, `GradeChip`, `MaterialTabBar`, gorhom sheets, `AccessoryBarSurface`.
- **Native build note:** `@pchmn/expo-material3-theme` is an Android native module. Adding or updating it needs a fresh `vp run mobile:preview-build`; OTA-only updates are not enough for testers who do not already have the module in their installed shell.
- **Tests:** `react-native-paper` is aliased to a jsdom-safe stub (`test/react-native-paper-stub.tsx`) in `packages/mobile/vite.config.ts` — the same pattern as the posthog stub — so any suite can import a Paper-backed primitive. Component tests that assert Paper props register their own `vi.mock('react-native-paper', …)`, which takes precedence.

---

## Anti-Patterns

These are explicitly prohibited in the Boardsesh codebase:

| Don't                               | Do Instead                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| Hardcoded color values (`#8C4A52`)  | Use `themeTokens.colors.primary` or `var(--color-primary)`                        |
| `localStorage` / `sessionStorage`   | IndexedDB via `idb` package (see `packages/web/app/lib/user-preferences-db.ts`)   |
| `style` prop on components          | CSS modules (`.module.css`) or MUI `sx` prop                                      |
| Hover-only interactions             | Ensure all interactions work on touch; use swipe/tap as primary                   |
| Heavy shadows or gradients          | Subtle `shadow-sm` / `shadow-md` only; no decorative gradients                    |
| JavaScript breakpoint detection     | CSS `@media` queries only                                                         |
| `Grid.useBreakpoint()`              | CSS `@media (min-width: 768px)`                                                   |
| Emoji in UI text                    | Use Material UI icons                                                             |
| Creating new files unnecessarily    | Edit existing files; prefer CSS modules co-located with components                |
| Adding unused code                  | Remove dead code immediately                                                      |
| Over-engineering                    | Minimum complexity for current task                                               |
| Dark input backgrounds in dark mode | Use `darkTokens.semantic.inputSurface` (white) — intentional high-contrast design |

---

## File & Import Conventions

### Theme Tokens (TypeScript)

```typescript
import { themeTokens } from '@/app/theme/theme-config';

// Usage
themeTokens.colors.primary; // '#8C4A52'
themeTokens.neutral[200]; // '#E5E7EB'
themeTokens.spacing[4]; // 16
themeTokens.typography.fontSize.sm; // 14
themeTokens.shadows.sm; // shadow string
themeTokens.transitions.fast; // '150ms ease'
themeTokens.borderRadius.lg; // 12
```

### CSS Variables (CSS Modules)

```css
/* Available globally from packages/web/app/components/index.css */
var(--color-primary)
var(--neutral-200)
var(--semantic-surface)
var(--shadow-sm)
var(--color-error)
var(--semantic-selected)
/* etc. */
```

### Grade Utilities

```typescript
import { getGradeColor, getGradeTintColor, getSoftGradeColor, getGradeTextColor } from '@/app/lib/grade-colors';
```

### CSS Module Co-location

```
packages/web/app/components/
  my-component/
    my-component.tsx           # Component code
    my-component.module.css    # Styles (co-located)
```

### MUI Imports

```typescript
import { IconButton, Button as MuiButton, Badge as MuiBadge, CircularProgress } from '@mui/material';
import { FavoriteBorderOutlined, CheckOutlined } from '@mui/icons-material';
```

### Typical Component File Structure

```typescript
'use client';  // Only if needed for interactivity

import { themeTokens } from '@/app/theme/theme-config';
import { getGradeColor, getGradeTintColor } from '@/app/lib/grade-colors';
import styles from './my-component.module.css';

// MUI imports
import { IconButton, Button as MuiButton } from '@mui/material';

export function MyComponent() {
  return (
    <div className={styles.container}>
      {/* Use CSS module classes */}
      {/* Use themeTokens in sx prop when dynamic values needed */}
      {/* Use CSS variables in .module.css for static values */}
    </div>
  );
}
```
