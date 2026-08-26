# Native UI with @expo/ui (mobile)

We're migrating `packages/mobile` UI controls from re-created React Native widgets
to real native ones via [`@expo/ui`](https://docs.expo.dev/versions/latest/sdk/ui/):
SwiftUI on iOS (`@expo/ui/swift-ui`), Jetpack Compose on Android
(`@expo/ui/jetpack-compose`). A native `Toggle` / `Switch` gets you the platform's
own look, motion, haptics, and accessibility for free — no re-skinning per OS.

This is the canonical pattern. The reference primitives are **`SwitchRow`**
(`src/components/SwitchRow.*`) and **`FilterChipRow`**
(`src/components/search/FilterChipRow.*`). Copy them.

## The platform-split file convention

`@expo/ui/swift-ui` and `@expo/ui/jetpack-compose` resolve native views **at module
load**. Importing the wrong one for the running platform crashes at runtime
("Unable to get view config"). So a native component is split so each platform's
native tree only ever loads on that platform. For a component `Foo`:

| File              | Purpose                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Foo.types.ts`    | The shared `FooProps` type. Imported by every other file. No native imports.                                     |
| `Foo.logic.ts`    | Pure, node-testable helpers shared by both platforms (e.g. the toggle handler). No native imports, no rendering. |
| `Foo.ios.tsx`     | The iOS implementation. The **only** place `@expo/ui/swift-ui*` may be imported.                                 |
| `Foo.android.tsx` | The Android implementation. The **only** place `@expo/ui/jetpack-compose*` may be imported.                      |
| `Foo.d.ts`        | Ambient declaration: `export declare const Foo: FC<FooProps>;`                                                   |

There is **no** `Foo.tsx`. Consumers import the extensionless `./Foo`:

- **Metro** resolves `./Foo` → `Foo.ios.tsx` / `Foo.android.tsx` by platform extension.
- **tsc** has no platform resolution, so the `Foo.d.ts` ambient declaration is what
  the extensionless import type-resolves to. Both platform impls are still compiled
  and type-checked on their own.

The public API (`FooProps`) must stay identical to whatever the component replaced,
so no consumer changes.

## Host: import from the root, one per standalone control

Always import `Host` (and the other universal components) from the package root:

```ts
import { Host } from '@expo/ui';
```

`Host` is the bridge between the React Native view tree and a native SwiftUI /
Compose tree. **Granularity rule:** one `Host` wraps one native tree. A whole
native form or list is a single `Host`; a standalone control used one-per-card
(like today's `SwitchRow`) gets its own `Host`.

> One `Host` per `SwitchRow` is intentional for now — `SwitchRow` is used
> one-per-card. A later pass consolidates entire settings screens into a single
> SwiftUI `Form` / Compose list under one `Host`. Don't consolidate piecemeal.

## Theming: bridge only the brand accent

Native controls already read system colours (iOS `PlatformColor`, Android Compose
Material theme). Only the **brand accent** needs bridging from our theme. That
mapping lives once in `src/theme/expo-ui-modifiers.ts`:

- `brandAccentColor(brandColors)` → the on-fill accent string for any control's
  tint (iOS `tint(...)`, Android Switch `checkedTrackColor`, Slider `color`, …).
- `switchBrandColors(brandColors)` → a plain Compose `SwitchColors` object.

Read `brandColors` from `useTheme()` at the call site (it's already resolved for
the colour scheme) and pass it to a bridge helper. The bridge file imports
**nothing** from `@expo/ui` — the lint guardrail (below) forbids native imports
outside platform files, and a shared module can't be platform-scoped. So the
helpers stay pure (plain values in, plain values / config objects out); the
platform file feeds them to its own native modifiers, e.g.
`tint(brandAccentColor(brandColors))`.

## Guardrail: native imports are platform-scoped

The rule, for `packages/mobile/**`:

- `@expo/ui/swift-ui` (and sub-paths) only from `*.ios.{ts,tsx}`.
- `@expo/ui/jetpack-compose` (and sub-paths) only from `*.android.{ts,tsx}`.
- `@expo/ui` (root, the universal `Host` etc.) and `@expo/ui/community/*` are unrestricted.

A misplaced import crashes the _other_ platform at runtime ("Unable to get view config").

Enforcement is the CI check **`vp run check:mobile-platform-imports`**
(`scripts/mobile-platform-imports-check.sh`), wired into `ci.yml` next to the other
`check:mobile-*` guards. `.oxlintrc.json` also carries the equivalent
`no-restricted-imports` rule so editors / raw oxlint flag it inline — **but
`vp check` runs a reduced oxlint ruleset that silently drops `no-restricted-imports`,
so `vp check` does NOT catch this.** The bash guard is the real backstop; run it
locally before pushing.

## Tests: alias the extensionless import to a passthrough stub

Vitest runs in node/jsdom and can't mount a native `@expo/ui` tree, and it doesn't
resolve `.ios`/`.android`. So any suite that transitively renders the component
would crash. Fix it once with a vite alias:

1. Add `test/foo-stub.tsx` — a **faithful passthrough** built from plain RN
   primitives (`Pressable`, `Text`, RN `Switch`, …) that keeps the public API and
   the accessibility role, so screen tests' label / role assertions keep passing.
   (Passthrough, not `null` — `null` breaks label assertions.)
2. Add a regex alias in `packages/mobile/vite.config.ts`, mirroring the existing
   entries:

   ```ts
   {
     find: /^(.*\/)?Foo$/,
     replacement: fileURLToPath(new URL('./test/foo-stub.tsx', import.meta.url)),
   },
   ```

A component test that asserts the component's own internals can register its own
`vi.mock`, which takes precedence over the alias.

Put the shared behaviour in `Foo.logic.ts` and unit-test that directly (node env),
rather than asserting against a rendered native control.

## Worked example: SwitchRow

```
src/components/SwitchRow.types.ts     # SwitchRowProps
src/components/SwitchRow.logic.ts     # makeToggleHandler (haptic + disabled guard)
src/components/SwitchRow.ios.tsx      # Host + SwiftUI Toggle (title/subtitle Text children)
src/components/SwitchRow.android.tsx  # Host + Compose Row/Column/Text/Switch, row owns `toggleable`
src/components/SwitchRow.d.ts         # ambient declaration for the extensionless import
test/switch-row-stub.tsx              # passthrough stub (RN Pressable + Switch)
```

- iOS: a single `Toggle` whose two `Text` children are title + subtitle (SwiftUI
  styles the second as secondary). Brand tint + disabled via modifiers; the native
  Toggle supplies the switch trait and on/off announcement.
- Android: a `Row` that owns the toggle via the `toggleable` modifier
  (`role: 'switch'`); the `Switch`'s own `onCheckedChange` is left undefined so a
  tap fires once. Brand on-track colour via `switchBrandColors`.
- Both call `makeToggleHandler(onValueChange, disabled)` so the haptic + disabled
  behaviour can't drift between platforms.

`FilterChipRow` is the second example — both sides are now built (SwiftUI menus on
iOS, Jetpack Compose `FilterChip`s + `DropdownMenu`s on Android), showing the same
split with a richer tree (menus, pickers / dropdowns) and the shared
`FilterChipRow.logic` label helpers. On Android the chip row is the climbs filtering
surface (it replaces the Material top-chrome filter button + grade control + summary).

`RadioGroup` (`src/components/RadioGroup.*`) is a third, two-platform example —
single-choice selection. iOS is a SwiftUI `Picker` with `pickerStyle('inline')` (each
option a `Text` carrying a `tag` modifier; string-guard `onSelectionChange`); Android is a
`Column`/`Row` of `RadioButton`s where the row owns the tap via
`selectable(..., 'radioButton')`. It's generic (`<T extends string>`), so its `.d.ts`
declares a function (like `SegmentedControl`), not a `const`. Selection logic is shared via
`makeRadioSelectHandler`.

### Whole-screen forms: MoreForm / FeatureFlagsForm / SwitcherForm

The settings screens consolidate an entire screen into ONE `Host` containing a single
SwiftUI `Form` (iOS) / Compose `LazyColumn` of cards (Android), instead of one `Host`
per control. The screen component owns the route guards, data hooks, `t()` calls,
confirm/Alert/haptics, then builds a plain view-model that the native tree renders —
`MoreForm.*`, `FeatureFlagsForm.*`, and `SwitcherForm.*` are the three. **Host sizing
differs from a standalone control:** a Form/LazyColumn is a scrolling container, so the
Host uses `style={{ flex: 1 }}` + (iOS) `useViewportSizeMeasurement` — NOT `matchContents`
(which sizes to content and clips the scroll).

`SwitcherForm` (`src/components/SwitcherForm.*`) backs the EAS preview-build branch switcher and
tester-only Sentry diagnostics (`BranchSwitcherScreen`, `SentryDiagnosticsScreen`) from one generic
sections-of-typed-rows model (`info`/`status`/`target`/`field`/`action`), the same shape
MoreForm uses. Its inline text field is a bare
native `TextField`/`OutlinedTextField` placed directly in the form (the standalone
`AuthTextInput` renders its own `Host` and can't nest inside another), reusing
`AuthTextInput.logic`'s pure prop→modifier mappers + `textFieldBrandColors`. Branch-row state is
derived once by `deriveSwitchRowState` (`SwitcherForm.logic.ts`) so iOS/Android can't drift.

## Buttons

**A button _inside_ an existing native @expo/ui tree should be a native button,
not an RN island.** When you add a button to a SwiftUI `Form`/`Host` or a Compose
tree we already own, use the platform's native button:

- **iOS** (`@expo/ui/swift-ui`): a native `Button`. Inside a `Form`/`Section` the
  default style reads as a Settings row (`MoreForm.ios.tsx`,
  `FeatureFlagsForm.ios.tsx`); a standalone capsule uses
  `buttonStyle('glass' | 'glassProminent')` (Liquid Glass, iOS 26+ —
  `FilterChipRow.ios.tsx`).
- **Android** (`@expo/ui/jetpack-compose`): the Material button family —
  `Button` / `FilledTonalButton` / `OutlinedButton` / `TextButton`
  (`MoreForm.android.tsx`, `FeatureFlagsForm.android.tsx`).

The **standalone** `Button` (`src/components/Button.*`) is itself a platform-split
native control — import the extensionless `./Button` like any RN component; Metro
resolves a SwiftUI `Button` on iOS and a Compose Material button on Android. Its
design (solid where legibility demands it, glass where it helps):

- **filled** — the brand CTA. A SOLID violet capsule on every surface and every
  iOS version (`buttonStyle('borderedProminent')` + brand `tint`). It never goes
  translucent, so it can't wash out over board art or in near-black dark mode.
- **outlined / tonal** — "glass as guest": a neutral Liquid Glass capsule on an
  opaque surface on iOS 26 (`buttonStyle('glass')`), an EXPLICIT `bordered`
  fallback below iOS 26 (branch on `useGlassCapability()`, never trusting
  @expo/ui's implicit glass→`.automatic` degradation), and a solid dark-scrim
  capsule when the region declares `over="content"` (board art). `tonal` aliases
  `outlined` on iOS; on Android it is a real MD3 `FilledTonalButton`.
- **text** — `borderless`, accent-tinted label.
- `role="destructive" | "cancel"` maps to the native button role (system red +
  destructive VoiceOver trait on iOS; error tokens on Android). `loading` swaps the
  leading icon for a native spinner (`ProgressView` / `CircularProgressIndicator`)
  and disables the button. A region drawing buttons over board art wraps them in
  `<ButtonSurfaceProvider surface="content">` (`Button.surface.tsx`) — the filled
  CTA is solid regardless; this only protects the middle/text tiers. Android icon
  drawables live in `assets/material-icons/*.xml` (mapped in `Button.android.tsx`).

**Keep these RN — do NOT migrate:**

- **`GlassIconButton`** (`src/components/GlassIconButton.tsx`) — already real glass
  via `GlassSurface`, plus a count badge, an icon cross-fade morph, a
  long-press-with-press-suppression gesture, and custom `accessibilityActions`,
  none of which the native `IconButton` / glass `Button` provides. Migrating it is
  a net loss.
- FlashList/FlatList rows, SVG board art, gifted-charts, gesture boards.

## Performance: memoize when a native control goes in a list

`SwitchRow` is used one-per-card, so rebuilding its handler and modifier arrays each
render is fine. A native control placed in a **`FlashList` row** is not: per the RN
performance rules (`docs/react-native-performance.md`), the row must be `React.memo`'d,
its handler `useCallback`'d, and the `renderItem` deps kept clean (no array `.length`,
no inline closures), or every native `Host` in the list re-creates on each scroll
frame. Don't copy the settings-row pattern into a list without adding the memoization.
