# AI Design Guidelines — Velvet Send

A self-contained reference for AI agents building or restyling Boardsesh UI to match the
design language. **"Velvet Send"** is the design language, and it lives in the mobile app
(`packages/mobile`). Every token in this document is sourced from the live code under
`packages/mobile/src/theme/` — treat that directory as the single source of truth and this doc as
its explanation.

> **Web has not migrated yet.** The Next.js app (`packages/web`) still runs the older rose/sage
> palette in `packages/web/app/theme/theme-config.ts`. That palette is legacy — it is on its way to
> Velvet Send, it is not a peer design language. New visual work should target Velvet Send. See
> [Legacy web palette](#legacy-web-palette-pending-migration) at the end for what web still uses today.

---

## Design philosophy

Velvet Send is a violet brand identity rendered through **platform-native chrome**. The colour comes
from the Boardsesh logo (built from the V11–V16 climbing-grade purples); the structure comes from
each platform's own design system.

- **Platform-native, not lowest-common-denominator.** The app renders in one of two variants —
  **Liquid Glass** (Apple's look) or **Material 3**. The variant is the _aesthetic_; it is distinct
  from whether the device can render real iOS 26 glass _chrome_ (see "Aesthetic vs. capability"
  below). The brand palette and the component APIs are identical across both; the silhouettes,
  elevation, motion and type scale follow whichever variant you're in. A control is the same product
  in both variants, drawn the way that platform draws controls.
- **One violet across light and dark.** The brand reads violet in every scheme. Dark mode lifts the
  tint and brightens fills so the same identity stays legible on near-black — it is not a different
  palette.
- **Read the theme, never the raw constants.** Components get colour, type, spacing, radii and motion
  from `useTheme()`. The exported constants in `theme/` are inputs to the provider; consuming them
  directly bypasses variant resolution and dark mode.
- **Accessible by construction.** Brand and label colours are chosen against documented WCAG ratios
  (recorded in `colors.ts`). Interactive tiers sit at or above the 44pt touch floor. Text honours
  Dynamic Type.

---

## The two UI variants

Source: `packages/mobile/src/theme/resolve-ui-variant.ts`, `providers/theme-provider.tsx`.

The whole app renders in one resolved `variant`:

| Variant       | When                                                  | Look                                                                                     |
| ------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `liquidGlass` | Every iPhone by default; opt-in on Android            | Apple Liquid Glass — floating glass capsules, soft corners, HIG type, reanimated springs |
| `material`    | Android by default; explicit user choice any platform | Material 3 — elevation, ripple, nav active-indicator pill, M3 type and corners           |

The user's stored preference is `UiVariantPreference` = `'auto' | 'liquidGlass' | 'material'`.
`'auto'` resolves against the **platform**, not glass capability — Liquid Glass on every iPhone
(including iOS < 26), Material on Android:

```ts
export function resolveUiVariant(preference: UiVariantPreference, autoPrefersGlass: boolean): UiVariant {
  if (preference === 'liquidGlass') return 'liquidGlass';
  if (preference === 'material') return 'material';
  return autoPrefersGlass ? 'liquidGlass' : 'material'; // 'auto'; caller passes Platform.OS === 'ios'
}
```

Change it with `theme.setUiVariant(next)`. Every option is selectable on every platform — any phone
can opt into Liquid Glass. Material is drawn opaque (M3 tonal surfaces) on **every** platform when
chosen, so a user who picks Material gets a real M3 app, not a glass app with the blur turned off.

### Aesthetic vs. capability

The `variant` chooses the _aesthetic_; a separate, synchronous **capability** check decides whether
real iOS 26 glass _chrome_ is used or a fallback stands in. Keep the two apart — Liquid Glass on an
older iPhone is the variant with the chrome degraded, not Material.

- `useGlassCapability()` → iOS 26 only (the native `GlassView` / `GlassContainer` API is present).
- `useNativeTabBar()` (= `liquidGlass && useGlassCapability()`) gates the native `NativeTabs` glass
  tab bar + `BottomAccessory`. When it's false — Material, **or** Liquid Glass on a non-capable
  device — the JS `Tabs` + `MaterialTabBar` carry navigation and the floating `PersistentQueueBar`
  carries the current climb. This is the canonical predicate; `useBottomChromeMetrics` keys tab-bar
  geometry on it so the layout math matches the bar actually on screen.
- Surfaces degrade in `GlassSurface` via `useEffectiveSurfaceMode()`: `glass` (iOS 26) → `blur`
  (iOS < 26 frosted) → `material`/`solid` (Android, Reduce Transparency). Buttons stay JS
  (`PressableSurface`) on every path, so any phone on Liquid Glass falls back to JS buttons safely.

**Component routing rule.** Cross-variant components expose one public prop API and route internally
on `theme.variant`; call sites never change. Don't hand-write the `variant === '…'` branch — use the
shared primitives in `packages/mobile/src/theme/variants/` (full decision tree + four-axis model in
its `README.md`):

```tsx
// Whole subtree differs → createVariantComponent (renders the chosen impl as JSX,
// so each gets its own fiber/hook list and a live variant flip can't crash).
export const Button = createVariantComponent('Button', { liquidGlass: ButtonGlass, material: ButtonMaterial });

// A single value differs → selectByVariant (a typed Record<UiVariant, T>; a new
// variant is a compile error at the call site).
const iconColor = selectByVariant(variant, { liquidGlass: systemColors.label, material: brandColors.primary });
```

Three rungs, in order of preference: (1) a **token** resolved once in the provider when the value has a
designer-facing name (`theme.actionColors`, `theme.chartColors`, `theme.sectionCaption`,
`theme.radii`, `theme.textStyles`); (2) **`createVariantComponent`** for a whole-subtree swap;
(3) **`selectByVariant`** for a local one-off. A CI guard (`vp run check:mobile-variants`) blocks raw
`variant === 'material'` / `=== 'liquidGlass'` compares from regrowing in `src/components/`.

---

## Color — Velvet Send palette

Source: `packages/mobile/src/theme/colors.ts`. **Read colours from `useTheme()`** —
`brandColors` for the brand, `systemColors` for surfaces/labels. The raw exports below are what the
provider resolves from; the file's own rule: _"All color access should go through
`useTheme().systemColors` — never consume [the constants] directly."_

### Brand colours

`brandColors` holds the light-scheme values; `brandColorsDark` overrides the roles that need to change
to stay legible on near-black. The provider picks the set per scheme and exposes it as
`theme.brandColors`.

| Role               | Light     | Dark      | Use                                                                         |
| ------------------ | --------- | --------- | --------------------------------------------------------------------------- |
| `tint` / `primary` | `#6D28D9` | `#A78BFA` | Brand **foreground**: text, icons, links, borders                           |
| `primaryFill`      | `#6D28D9` | `#7C3AED` | Brand **filled** surface/button background                                  |
| `onPrimary`        | `#FFFFFF` | `#FFFFFF` | Text/icon sitting on `primaryFill`                                          |
| `accent`           | `#FF8A3D` | `#FF8A3D` | Warm amber spark for highlights — **fill-only, always pair with dark text** |
| `success`          | `#047857` | `#34D399` | Success states                                                              |
| `warning`          | `#B45309` | `#FBBF24` | Warnings                                                                    |
| `error`            | `#C81E1E` | `#F87171` | Destructive actions                                                         |

**Role split matters.** Foreground brand (`tint`/`primary`) and filled-surface brand (`primaryFill`)
are different values in dark mode: the dark violet is too low-contrast as a foreground on near-black,
so the tint lifts to `#A78BFA` while filled buttons use a brighter `#7C3AED` so white text still
clears AA.

Documented contrast (from `colors.ts`):

- Light: white-on-`#6D28D9` = 7.10:1; black-on-`#FF8A3D` accent = 8.95:1.
- Dark: `#A78BFA` tint ≥ 6.12:1 across the dark surface ladder; white-on-`#7C3AED` = 5.70:1.

### System colours (surfaces & labels)

`theme.systemColors` resolves by **platform and variant**:

- **iOS + Liquid Glass** → Apple `PlatformColor` (`systemBackground`, `label`, `separator`,
  `systemFill`, `link`, …). These adapt to light/dark and accessibility settings natively — no app
  code needed.
- **Android (Liquid Glass fallback)** → `androidFallbackColors[light|dark]` (violet-tinted hexes).
- **Any platform + Material** → `materialSurfaces[light|dark]` (M3 tonal surfaces, violet-tinted).

The resolved set always has the same keys. Representative values (Android fallback / Material tonal,
which are the explicit hexes — iOS uses `PlatformColor` for the same roles):

| Key                   | Light (Android fallback) | Dark (Android fallback)  | Meaning                                                                             |
| --------------------- | ------------------------ | ------------------------ | ----------------------------------------------------------------------------------- |
| `background`          | `#F4F1FB`                | `#0F0B16`                | Screen base                                                                         |
| `secondaryBackground` | `#FFFFFF`                | `#181225`                | Cards, sheets                                                                       |
| `tertiaryBackground`  | `#FFFFFF`                | `#221A32`                | —                                                                                   |
| `groupedBackground`   | `#F4F1FB`                | `#0F0B16`                | Grouped-list base                                                                   |
| `elevatedSurface`     | `#FFFFFF`                | `#221A32`                | Raised tile (selected segmented pill, elevated bar)                                 |
| `label`               | `#16111F`                | `#F5F2FB`                | Primary text                                                                        |
| `secondaryLabel`      | `#5B5563`                | `#A9A2B6`                | Secondary text (opaque, clears WCAG AA — 6.44:1 on bg)                              |
| `tertiaryLabel`       | `#8E8898`                | `#6E687C`                | Tertiary text                                                                       |
| `separator`           | `rgba(60,55,75,0.18)`    | `rgba(180,168,205,0.2)`  | Hairlines, dividers                                                                 |
| `fill`                | `rgba(109,40,217,0.1)`   | `rgba(199,184,232,0.12)` | Faint violet track (segmented controls, fills)                                      |
| `accent`              | `#6D28D9`                | `#A78BFA`                | Interactive-accent foreground (links, active tab). iOS uses Apple's link blue here. |

Material tonal surfaces (`materialSurfaces`) are the same shape with M3-specific values
(`background` `#F3EFFA` light / `#15101E` dark, `secondaryBackground` `#FFFFFF` / `#221A33`, etc.).
The neutrals are tinted toward the brand violet so Material reads as the same product as Liquid Glass
— the Material feel comes from elevation, ripple and the nav pill, not from a different palette.

When the Material variant is active, `theme.m3` also exposes the full MD3 colour-role palette
(`primaryContainer`, `onSurfaceVariant`, `outlineVariant`, the `elevation.level0–5` ladder) for app
components that need to match Paper components without re-deriving roles. Liquid Glass never reads it.

### Static iOS colour constants

`packages/mobile/src/theme/ios-colors.ts` holds fixed hexes (`systemRed` `#FF3B30`, `systemGreen`
`#34C759`, `starGold` `#FFB800`, …) for the rare spots where a value is needed outside the provider —
animated styles, default props. Prefer `theme.systemColors` / `theme.brandColors` everywhere else.

### Colour helpers

From `colors.ts`:

- `withAlpha(color, alpha)` — applies an alpha to a `#RGB`/`#RRGGBB` hex, returning `rgba(...)`. Any
  non-hex input (already-`rgba()`, named colour, `PlatformColor`) is returned unchanged so it never
  produces an invalid colour.
- `blendOpaque(foreground, background, alpha)` — alpha-composites two hexes into an **opaque**
  `#RRGGBB`. For surfaces that float over arbitrary content and must stay opaque (e.g. a
  variant-tinted toast pill) where a translucent `rgba()` would let content bleed through.

### Overlays (fixed across schemes)

`tokens.ts` → `overlays`: `scrim` = `rgba(0,0,0,0.6)`, `onScrim` = `#FFFFFF`. Intentionally fixed
across light/dark — these are for chips/buttons over arbitrary content (board images, photos) that
need stable contrast regardless of the user's scheme.

---

## Typography

Source: `packages/mobile/src/theme/typography.ts`. Two scales, same keys, resolved per variant via
`theme.textStyles[variant]`. Liquid Glass uses the Apple HIG scale; Material uses the M3 (Roboto)
scale. System font only (San Francisco on iOS, Roboto on Android) — no custom font families.

| Variant key   | HIG (Liquid Glass) | M3 (Material) |
| ------------- | ------------------ | ------------- |
| `largeTitle`  | 34 / 700 / 41      | 28 / 400 / 36 |
| `title1`      | 28 / 700 / 34      | 24 / 400 / 32 |
| `title2`      | 22 / 700 / 28      | 22 / 400 / 28 |
| `title3`      | 20 / 600 / 25      | 22 / 500 / 28 |
| `headline`    | 17 / 600 / 22      | 16 / 500 / 24 |
| `body`        | 17 / 400 / 22      | 16 / 400 / 24 |
| `callout`     | 16 / 400 / 21      | 16 / 400 / 24 |
| `subheadline` | 15 / 400 / 20      | 14 / 400 / 20 |
| `footnote`    | 13 / 400 / 18      | 12 / 400 / 16 |
| `caption1`    | 12 / 400 / 16      | 11 / 500 / 16 |
| `caption2`    | 11 / 400 / 13      | 11 / 500 / 16 |

_(values are `fontSize / fontWeight / lineHeight`)_

The HIG scale intentionally sets `largeTitle`/`title1`/`title2` to bold (700) rather than HIG's
default regular — a deliberate brand choice. The M3 scale drops those display weights to regular,
since M3 reserves heavy weights for true display roles.

**Always render text through the `Text` primitive** (`components/Text.tsx`), never raw `RNText`. It
resolves the per-variant scale and defaults the colour to the adaptive `theme.systemColors.label`
(RN's default text colour is non-adaptive black and breaks in dark mode):

```tsx
export function Text({ variant = 'body', color, style, ...props }: TextProps) {
  const theme = useOptionalTheme();
  const resolvedColor = color ?? theme?.systemColors.label;
  const typeStyle = theme?.textStyles[variant] ?? variantStyles[variant];
  return <RNText allowFontScaling maxFontSizeMultiplier={1.5} style={[typeStyle /* color */, , style]} {...props} />;
}
```

**Dynamic Type.** `Text` defaults `maxFontSizeMultiplier` to `1.5`. Fixed-height glass chrome (the
queue capsule, the iOS 26 bottom accessory) caps labels at `CHROME_LABEL_MAX_FONT_SCALE` = `1.2` so
single-line names don't clip against rigid heights. Surfaces that grow with their content keep `1.5`.

---

## Spacing, radii, shadows, opacity

Source: `packages/mobile/src/theme/tokens.ts`. Read via `theme.spacing`, `theme.borderRadius`,
`theme.shadows`, `theme.opacity`.

**Spacing** (4pt grid):

| Token | px  |     | Token | px  |
| ----- | --- | --- | ----- | --- |
| `0`   | 0   |     | `5`   | 20  |
| `1`   | 4   |     | `6`   | 24  |
| `2`   | 8   |     | `8`   | 32  |
| `3`   | 12  |     | `10`  | 40  |
| `4`   | 16  |     | `12`  | 48  |
|       |     |     | `16`  | 64  |

**Border radius**: `none` 0 · `sm` 4 · `md` 8 · `lg` 12 · `xl` 16 · `full` 9999.

Cards stay `lg` (12) and pills/capsules stay `full` in **both** variants — the variants differ in
surface/elevation, not those silhouettes. The one corner that varies by variant is the **button**,
resolved via `theme.radii.button`: **10dp on Liquid Glass, 20dp on Material** (`radiiByVariant`).

**Shadows** (`shadows.xs`…`xl`) carry both iOS (`shadowOffset`/`shadowOpacity`/`shadowRadius`) and
Android (`elevation`) keys: `xs` (elevation 1) → `sm` (2) → `md` (4) → `lg` (8) → `xl` (12).

**Opacity**: `subtle` 0.7, `disabled` 0.5.

---

## Layout & chrome metrics

Source: `packages/mobile/src/theme/layout.ts`, plus sheet/material metrics in `tokens.ts`.

**Glass size ladder** — one height ladder for every floating FAB / capsule / pill so the chrome reads
as one deliberately-sized system. Every interactive tier is at or above the 44pt touch floor:

| Tier            | px  | Use                                                          |
| --------------- | --- | ------------------------------------------------------------ |
| `hero`          | 56  | One defining action per surface (log-ascent, create)         |
| `standard`      | 48  | Default floating FAB                                         |
| `capsule`       | 44  | Standalone floating capsule (4pt under sibling FABs)         |
| `inlinePrimary` | 48  | Primary action inside a sheet                                |
| `inline`        | 44  | Standard inline control                                      |
| `mini`          | 32  | Label-only pill (angle); carries 44pt hit-slop when tappable |

**Tab bar.** `TAB_BAR_HEIGHT` = 49 (Liquid Glass / native iOS). `MATERIAL_TAB_BAR_HEIGHT` = 80 (M3
80dp bar fitting the active-indicator pill + icon + label).

**Floating toolbar.** `TOOLBAR_FAB_SIZE` 48 · `TOOLBAR_CAPSULE_HEIGHT` 44 · `TOOLBAR_CAPSULE_MAX_WIDTH`
260 · `TOOLBAR_SIDE_MARGIN` 16 · `TOOLBAR_GAP` 8 · `TOOLBAR_GAP_ABOVE_TABBAR` 10 · `TOOLBAR_RESERVE`
66 (bottom padding screens reserve so the last row clears the toolbar). Material docks an opaque
active-context bar instead (`MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT` 48, `TABBAR_SEAM_OVERLAP` 1).

**Sheet chrome** resolves per variant via `theme.sheet` (`sheetChromeByVariant`), so `Sheet`,
`ModalSheet` and `PlayDrawer` never drift:

|               | Liquid Glass            | Material         |
| ------------- | ----------------------- | ---------------- |
| Scrim opacity | 0.4                     | 0.32             |
| Handle        | 36 × 5, radius 3        | 32 × 4, radius 2 |
| Top corners   | soft (glass background) | 28dp             |

**Material building blocks** (`tokens.ts` → `material`, Android branches only): nav active-indicator
pill 64 × 32 (radius 16), surface elevation 3, pressed state-layer opacity 0.12. `androidRipple(color,
borderless)` builds a Pressable `android_ripple` config at that state-layer opacity.

---

## iPad adaptive layout

iPad (only — no Android tablets) gets a multi-column shell; every iPhone, and an iPad in a narrow
split, falls through to the phone UI **verbatim**. The size class is pure and unit-tested in
`theme/size-class.ts` (`resolveDeviceLayout`), fed window width by `hooks/use-device-layout.ts`:

- **`compact`** — every iPhone, plus an iPad window narrower than `REGULAR_WIDTH_BREAKPOINT` (700pt:
  Slide Over / a narrow Split View). Renders today's phone UI; no phase may regress it.
- **`regular`** — an iPad window wide enough for the glass sidebar (`IpadSidebar`, replacing the bottom
  tab bar) + a content column + a detail pane. `expanded` (≥1024pt) is a flag on top.

**The right column is master-detail, not status.** At `regular` width the shell is
`sidebar · active-tab content · detail pane` (`(tabs)/_layout.tsx`). The detail pane (`IpadPlayPane` →
`PlayDrawer presentation="pane"`) follows the user's **selection** — tapping a list row updates it —
mirroring Mail/Notes/Files. It is the SELECTION surface; do not repoint it at shared/live status (that
was the original bug). A `setAsCurrent:false` open (feed / beta / climb view) previews in the pane
without committing to the queue (`drawer-host-provider`'s `panePreviewItem`), so every climb-open entry
point populates the pane.

**The live wall is STATUS, with its own width-adaptive home** (`resolveWallSurface({ width, widthClass,
sidebarWidth })` → `'none' | 'strip' | 'column'`):

- Ambient `SidebarWallCell` in the rail footer (always, `regular`) — the glanceable cross-tab anchor.
- A dedicated **`column`** on the trailing edge in landscape, when sidebar + browse list (≥
  `WALL_COLUMN_CONTENT_FLOOR` 400pt) + detail pane (`DETAIL_PANE_WIDTH_WITH_WALL` 320pt) +
  `WALL_COLUMN_WIDTH` (300pt) all fit (≈≥1116pt → both 11" and 13" landscape).
- A compact **`strip`** docked atop the detail pane in portrait, where a 4th column would crush the
  list (11" 834pt / 13" 1032pt).

All three reuse `NowOnTheWallPanel` (extracted from `BoardSheet`, `variant: 'sheet' | 'column'`) and tap
through to the full `BoardSheet`. Rules when adding layout-sensitive iPad components:

- Decide column-vs-strip from the **computed width budget**, never a raw breakpoint — it stays correct
  across rotation / Split View / Stage Manager.
- Exactly **one wall surface per layout**: the shell passes `showWallCell={!showWallColumn}` to the
  sidebar so the rail cell and the column never both show.
- Inline columns/strips **own their safe-area insets** (`insets.top` for a top-of-shell column header,
  `insets.bottom` for a full-height column footer); a gorhom sheet handles its own. When a strip is
  docked above the pane, the shell sets `PlayDrawer paneTopInset={false}` so the inset isn't doubled.
- Status may **annotate** selection (the pane shows an "On the wall" chip when the selected climb is the
  lit one) — but never replace it.

---

## Motion & haptics

**Springs** (`theme/animations.ts`, for reanimated `withSpring`):

| Preset        | damping / stiffness / mass | Use                                                   |
| ------------- | -------------------------- | ----------------------------------------------------- |
| `snappy`      | 20 / 300 / 0.7             | UI controls (toggles, switches, tabs, press feedback) |
| `interactive` | 20 / 250 / 1.0             | Dragging, swiping, pressing                           |
| `gentle`      | 15 / 150 / 1.0             | Sheet presentations, layout changes                   |
| `bouncy`      | 10 / 200 / 0.7             | Playful overshoot (success, celebrations)             |

**Timing** (`withTiming`): `instant` 50ms · `fast` 150ms · `normal` 250ms · `slow` 350ms.

**Haptics** (`packages/mobile/src/lib/haptics.ts`, expo-haptics, no-ops where unsupported). Visual
press feedback is separate (that's `PressableSurface`); fire haptics from the handler:

- `hapticSelection()` — selection changes (pickers, segmented controls)
- `hapticLight()` — minor interactions (toggle, button press)
- `hapticMedium()` — standard interactions (swipe action)
- `hapticHeavy()` — significant interactions (drag-drop, destructive)
- `hapticSuccess()` / `hapticError()` / `hapticWarning()` — notification feedback (climb logged, etc.)

---

## Iconography

Source: `packages/mobile/src/components/Icon.tsx`, `icon-map.ts`. Use the `Icon` component with a
semantic `IconName`; never reference a platform glyph directly. `iconMap` maps each semantic name to
an **SF Symbol** (iOS, compile-time validated via `expo-symbols`) and a **Material Community** glyph
(Android):

```ts
favorite:        { ios: 'heart',           android: 'heart-outline' },
'favorite.fill': { ios: 'heart.fill',      android: 'heart' },
queue:           { ios: 'list.bullet',     android: 'playlist-play' },
lightbulb:       { ios: 'lightbulb',       android: 'lightbulb-on-outline' },
```

Filled/outline pairs follow the `name` / `name.fill` convention (e.g. `boards` / `boards.fill`). A
typo'd SF Symbol fails `vp run typecheck:mobile`.

**Liquid Glass chrome icon colour.** Bottom tabs, neutral glass header controls and ordinary
action-sheet row icons should use adaptive neutral glyphs: `systemColors.label` for selected or
primary actions, `systemColors.secondaryLabel` for inactive actions. Carry state with icon shape,
labels, badges, filled surfaces or selection affordances before reaching for brand colour. Keep
semantic colour for cases where colour is the content: destructive actions, warnings/errors, success
status summaries, connected-light state, grade colours, chart series, filled primary buttons and
glass controls floating over coloured/photo content where white is required for contrast.

---

## Theme consumption pattern

Source: `packages/mobile/src/providers/theme-provider.tsx`.

`useTheme()` returns the resolved theme; `useOptionalTheme()` returns `null` outside a provider (for
low-level primitives like `Text` that can render before providers mount — e.g. the root error
boundary). The theme object:

```ts
type Theme = {
  colorScheme: 'light' | 'dark';
  systemColors; // resolved per platform + variant
  brandColors; // resolved per scheme
  textStyles; // resolved per variant
  spacing;
  borderRadius;
  shadows;
  opacity;
  springs;
  timing;
  variant; // 'liquidGlass' | 'material' (already resolved from 'auto')
  radii; // variant corner radii (e.g. radii.button)
  sheet; // variant sheet chrome (scrim/handle/corners)
  m3; // MD3 colour roles (Material variant only)
  themeOverride;
  setThemeOverride; // light | dark | system
  uiVariantPreference;
  setUiVariant; // auto | liquidGlass | material
};
```

Read tokens at the top of the component and compose with `StyleSheet`. Brand colours, per-scheme
(`Button` glass branch):

```tsx
const { radii, brandColors: brand } = useTheme();
const fillColor = tintColor ?? brand.primaryFill; // #6D28D9 light · #7C3AED dark
const accentColor = tintColor ?? brand.primary; // #6D28D9 light · #A78BFA dark
const containerStyle = {
  borderRadius: radii.button, // 10 glass · 20 material
  ...(variant === 'filled' && { backgroundColor: fillColor }),
  ...(variant === 'outlined' && { borderWidth: 1, borderColor: accentColor }),
};
```

Surfaces from `systemColors` (`Card` glass branch):

```tsx
const { systemColors } = useTheme();
const backgroundStyle = { backgroundColor: systemColors.secondaryBackground };
// styles.card carries borderRadius.lg (12), padding 16, iOS shadow / Android elevation 2
```

**Touch feedback** goes through `PressableSurface` (`components/PressableSurface.tsx`): one API that
renders a native Material **ripple** on Android and a reanimated **scale/opacity spring** (`feedback`
= `'scale'` | `'opacity'` | `'none'`, `springs.snappy`) on iOS. Don't hand-roll an
`AnimatedPressable`.

**Canonical primitives** (exported from `components/index.ts`): `Text`, `Button`, `Card`, `ListRow`,
`Avatar`, `Badge`, `Separator`, `SectionHeader`, `Sheet`, `ModalSheet`, `GlassSurface`,
`GlassSheetBackground`, `Icon`, `SegmentedControl`, `StarRating`, `Toast`, `CollapsibleSection`,
`RadioGroup`, `SwitchRow`, `ActivityIndicator`, plus board/climb/queue components. Prefer these over
raw RN host components.

---

## Dark mode

- **iOS + Liquid Glass:** `PlatformColor` follows the native trait collection — system colours adapt
  with no app code.
- **Android / Material:** the provider selects `*[colorScheme]` from `androidFallbackColors` /
  `materialSurfaces`; `brandColors` switches to `brandColorsDark`.
- **User override:** `theme.setThemeOverride('light' | 'dark' | 'system')`. A non-`system` choice also
  drives the native `Appearance.setColorScheme(...)` so iOS `PlatformColor` flips too (it follows the
  native trait collection, not our JS `colorScheme`). This requires `userInterfaceStyle: 'automatic'`
  in `app.config.ts`.

Because `theme.systemColors` and `theme.brandColors` are already scheme-resolved, components written
against the theme get dark mode for free — there is no `isDark ? a : b` branching in component code.

---

## Legacy web palette (pending migration)

The web app (`packages/web`) has **not** moved to Velvet Send yet. Until it does, web uses the older
"warm organic" palette in `packages/web/app/theme/theme-config.ts` (exposed as CSS custom properties
in `packages/web/app/components/index.css`):

- Primary `#8C4A52` (dusty rose), success `#6B9080` (sage), error `#B8524C` (brick), warning `#C4943C`
  (amber), plus a 9-step neutral scale `#F9FAFB`…`#111827`.

This is legacy and slated to converge on Velvet Send — don't treat it as a second design language or
extend it. When you touch web visuals, prefer pulling toward the violet palette where it doesn't
break existing screens, and flag larger migrations rather than entrenching rose/sage.

**Shared across web and mobile:** only the climbing **grade colours** (`@boardsesh/board-constants`).
Those are tied to grade bands, not to either app's chrome, and stay shared.
