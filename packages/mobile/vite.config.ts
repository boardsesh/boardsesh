import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // React Native / Metro inject __DEV__ at runtime. Vitest evaluates in node,
  // where the symbol is undefined — replacing it here lets src/ files use
  // `if (__DEV__) { ... }` without guarding for the test environment.
  define: {
    __DEV__: 'true',
  },
  // Several `@boardsesh/*-react` packages carry their own React devDependency so
  // they can run their own suites, which bun installs as a nested copy. Without
  // deduping, a mobile suite that renders a hook from one of them loads a second
  // React and every hook call throws "Cannot read properties of null".
  //
  // This mirrors production rather than diverging from it: metro.config.js already
  // forces the same singletons via SINGLETON_MODULES, so the app has never shipped
  // two Reacts. Two bundlers, one decision — change both.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  test: {
    name: 'mobile',
    globals: true,
    environment: 'node',
    alias: [
      // Gorhom is installed only in web-runtime so it stays outside the native
      // fingerprint graph. This resolver target lets adapter tests install a
      // hoisted module mock without making the real package visible to Vitest.
      {
        find: /^@gorhom\/bottom-sheet$/,
        replacement: fileURLToPath(new URL('./test/gorhom-bottom-sheet-stub.ts', import.meta.url)),
      },
      // The real `posthog-react-native` entry re-exports RN-native components
      // (PostHogProvider/PostHogMaskView) whose untransformed source throws a
      // `SyntaxError` under vitest's node env, breaking every suite that imports
      // `src/lib/analytics`. Analytics is a no-op in tests (isAnalyticsEnabled is
      // false), so a lightweight stub satisfies the static imports safely.
      {
        find: 'posthog-react-native',
        replacement: fileURLToPath(new URL('./test/posthog-react-native-stub.ts', import.meta.url)),
      },
      // react-native-paper's real entry throws a SyntaxError under vitest's node
      // env (untransformed RN-native source + react-native-vector-icons). Stub it
      // so any suite can import a Paper-backed primitive; component tests that
      // assert Paper props register their own vi.mock which takes precedence.
      {
        find: 'react-native-paper',
        replacement: fileURLToPath(new URL('./test/react-native-paper-stub.tsx', import.meta.url)),
      },
      // @react-native-async-storage/async-storage's ESM entry imports
      // `./createAsyncStorage` without a file extension, which fails to resolve
      // under vitest's node ESM env — breaking any suite that transitively loads
      // a storage-backed module (the active-board store via the bluetooth
      // provider, the preference store, etc.) even when it never touches
      // storage. A tiny in-memory stub satisfies the static imports; suites that
      // assert storage behaviour register their own vi.mock, which takes
      // precedence.
      {
        find: '@react-native-async-storage/async-storage',
        replacement: fileURLToPath(new URL('./test/async-storage-stub.ts', import.meta.url)),
      },
      // @react-native-masked-view/masked-view and @react-native-community/blur are
      // native modules that can't load under vitest's node/jsdom env. Stub them so
      // any suite can import a blur/glass primitive (GlassSurface, ProgressiveBlur)
      // without crashing; suites that assert their props register their own vi.mock,
      // which takes precedence over these aliases.
      {
        find: '@react-native-masked-view/masked-view',
        replacement: fileURLToPath(new URL('./test/masked-view-stub.tsx', import.meta.url)),
      },
      {
        find: '@react-native-community/blur',
        replacement: fileURLToPath(new URL('./test/community-blur-stub.tsx', import.meta.url)),
      },
      // @react-native-community/netinfo is a native module that can't load under
      // vitest's node env. The query provider wires it into React Query's
      // onlineManager at module load, so any suite that transitively imports the
      // provider would crash without this stub. Suites that assert connectivity
      // behaviour register their own vi.mock, which takes precedence.
      {
        find: '@react-native-community/netinfo',
        replacement: fileURLToPath(new URL('./test/netinfo-stub.ts', import.meta.url)),
      },
      // react-native-mmkv's react-native Flow entry throws a SyntaxError under
      // vitest's node env, and the settings store binds an instance at module
      // load — so any suite that transitively reaches `src/settings` would fail
      // to load. Suites that need to reset the store between tests register
      // their own vi.mock, which takes precedence.
      {
        find: 'react-native-mmkv',
        replacement: fileURLToPath(new URL('./test/react-native-mmkv-stub.ts', import.meta.url)),
      },
      // @sentry/react-native's real entry pulls in react-native's Promise.js,
      // which imports `promise/setimmediate/es6-extensions` (no extension) and
      // fails to resolve under vitest's node ESM env — breaking every suite that
      // transitively imports `src/lib/sentry`. Sentry is disabled in tests, so a
      // lightweight stub satisfies the static imports.
      {
        find: '@sentry/react-native',
        replacement: fileURLToPath(new URL('./test/sentry-react-native-stub.ts', import.meta.url)),
      },
      // expo-file-system and expo-image point their `main`/`exports` at TypeScript
      // source (src/index.ts). That source imports expo-modules-core native bindings
      // whose untransformed TS declarations throw `SyntaxError: Unexpected token
      // 'typeof'` in Vitest's module worker. Stub them so any suite that transitively
      // imports these packages (e.g. ClimbListThumbnail → use-native-climb-render →
      // expo-file-system, or LayeredClimbImage → expo-image) resolves cleanly.
      // Suites that assert real expo-file-system / expo-image behaviour can register
      // their own vi.mock which takes precedence over these aliases.
      {
        find: 'expo-file-system',
        replacement: fileURLToPath(new URL('./test/expo-file-system-stub.ts', import.meta.url)),
      },
      { find: 'expo-image', replacement: fileURLToPath(new URL('./test/expo-image-stub.tsx', import.meta.url)) },
      // expo-haptics' `main` is src/Haptics.ts (TS source), throwing the same
      // node-env SyntaxError as expo-image/expo-file-system. A no-op stub keeps
      // any suite that transitively imports src/lib/haptics (e.g. via the climbs
      // screen → FilterTokenRow / RecentFilterPills) from crashing.
      { find: 'expo-haptics', replacement: fileURLToPath(new URL('./test/expo-haptics-stub.ts', import.meta.url)) },
      // src/theme/animations.ts has `export type SpringPreset = keyof typeof springs`
      // and `export type TimingPreset = keyof typeof timing`. In CI's Rolldown worker
      // (Node.js 24), Rolldown's static analysis traverses into this file even when
      // the importing module is vi.mock()'d, and the TypeScript transform does not
      // strip `keyof typeof` before the parser sees it, producing
      // `SyntaxError: Unexpected token 'typeof'`. A path-regex alias redirects ALL
      // imports of this module (e.g. `../theme/animations`, `../../theme/animations`)
      // to a plain-JS stub before Rolldown reads the source, eliminating the error.
      // Suites that need specific animation values can register their own vi.mock
      // which takes precedence at runtime.
      {
        find: /^(.*\/)?theme\/animations$/,
        replacement: fileURLToPath(new URL('./test/theme-animations-stub.ts', import.meta.url)),
      },
      // Static image imports (.png/.jpg/.webp/...) resolve to a Metro asset id (a
      // number) at runtime. Vitest has no Metro asset pipeline and Rolldown's
      // static analysis chokes parsing the binary as a module, so redirect every
      // asset import to a dummy. Like the theme/animations alias, the regex must
      // match the WHOLE specifier (vite replaces only the matched part).
      {
        find: /^.*\.(png|jpe?g|gif|webp|svg)$/,
        replacement: fileURLToPath(new URL('./test/asset-stub.ts', import.meta.url)),
      },
      // FilterChipRow is platform-split (FilterChipRow.ios.tsx renders native
      // @expo/ui SwiftUI menus; FilterChipRow.android.tsx is a placeholder).
      // Vitest doesn't resolve `.ios`/`.android` extensions and can't mount the
      // SwiftUI host, so redirect the extensionless import to a null stub. Suites
      // that assert chip behaviour register their own vi.mock (takes precedence).
      {
        find: /^(.*\/)?search\/FilterChipRow$/,
        replacement: fileURLToPath(new URL('./test/filter-chip-row-stub.tsx', import.meta.url)),
      },
      // SwitchRow is platform-split (SwitchRow.ios.tsx renders a native @expo/ui
      // SwiftUI Toggle; SwitchRow.android.tsx a native Compose Switch). Vitest
      // doesn't resolve `.ios`/`.android` extensions and can't mount either native
      // tree, so redirect the extensionless import to a faithful passthrough stub
      // that keeps the public API + switch accessibility role. Suites that assert
      // SwitchRow internals register their own vi.mock (takes precedence).
      {
        find: /^(.*\/)?SwitchRow$/,
        replacement: fileURLToPath(new URL('./test/switch-row-stub.tsx', import.meta.url)),
      },
      // AuthTextInput is platform-split (AuthTextInput.ios.tsx renders a native
      // @expo/ui SwiftUI TextField/SecureField; AuthTextInput.android.tsx a native
      // Compose OutlinedTextField). Vitest doesn't resolve `.ios`/`.android`
      // extensions and can't mount either native tree, so redirect the
      // extensionless import to a faithful passthrough stub that keeps the public
      // API + ref.focus() + testIDs + reveal-toggle / error a11y. Suites that
      // assert AuthTextInput internals register their own vi.mock (takes
      // precedence — e.g. EditProfileScreen.test.tsx).
      {
        find: /^(.*\/)?AuthTextInput$/,
        replacement: fileURLToPath(new URL('./test/auth-text-input-stub.tsx', import.meta.url)),
      },
      // AuthFieldset groups credential fields in one iOS Host (so AutoFill pairs
      // email + password). Platform-split (ios.tsx = native SwiftUI VStack form;
      // android.tsx = per-field AuthTextInput). Vitest can't mount the native tree
      // and doesn't resolve `.ios`/`.android`, so redirect to a passthrough stub
      // that keeps the public API + per-field testID/a11y + focus chain. Suites
      // asserting AuthFieldset internals register their own vi.mock (precedence).
      {
        find: /^(.*\/)?AuthFieldset$/,
        replacement: fileURLToPath(new URL('./test/auth-fieldset-stub.tsx', import.meta.url)),
      },
      // SegmentedControl is platform-split (SegmentedControl.ios.tsx renders a
      // native @expo/ui SwiftUI segmented Picker; SegmentedControl.android.tsx a
      // native Compose SingleChoiceSegmentedButtonRow). Vitest doesn't resolve
      // `.ios`/`.android` extensions and can't mount either native tree, so
      // redirect the extensionless import to a faithful passthrough stub that
      // keeps the public API + radio/radiogroup accessibility roles. Suites that
      // assert SegmentedControl internals register their own vi.mock (takes
      // precedence).
      {
        find: /^(.*\/)?SegmentedControl$/,
        replacement: fileURLToPath(new URL('./test/segmented-control-stub.tsx', import.meta.url)),
      },
      // AngleSlider is platform-split (AngleSlider.ios.tsx renders a native
      // @expo/ui SwiftUI Slider; AngleSlider.android.tsx a native Compose Slider).
      // Vitest doesn't resolve `.ios`/`.android` extensions and can't mount either
      // native tree, so redirect the extensionless import (it lives in
      // play-drawer/, so consumers import `./AngleSlider` or `../play-drawer/
      // AngleSlider` — the basename regex matches both) to a faithful passthrough
      // stub that keeps the public API + `adjustable` accessibility role. Suites
      // that assert AngleSlider internals register their own vi.mock (takes
      // precedence).
      {
        find: /^(.*\/)?AngleSlider$/,
        replacement: fileURLToPath(new URL('./test/angle-slider-stub.tsx', import.meta.url)),
      },
      // RadioGroup is platform-split (RadioGroup.ios.tsx renders a native @expo/ui
      // SwiftUI inline Picker; RadioGroup.android.tsx a native Compose RadioButton
      // group). Vitest doesn't resolve `.ios`/`.android` extensions and can't mount
      // either native tree, so redirect the extensionless import to a faithful
      // passthrough stub that keeps the public API + radio/radiogroup accessibility
      // roles. Suites that assert RadioGroup internals register their own vi.mock
      // (takes precedence).
      {
        find: /^(.*\/)?RadioGroup$/,
        replacement: fileURLToPath(new URL('./test/radio-group-stub.tsx', import.meta.url)),
      },
      // FeatureFlagsForm is platform-split (FeatureFlagsForm.ios.tsx renders a
      // native @expo/ui SwiftUI `Form`; FeatureFlagsForm.android.tsx a native
      // Compose `LazyColumn` of cards). Vitest doesn't resolve `.ios`/`.android`
      // extensions and can't mount either native tree, so redirect the
      // extensionless import to a faithful passthrough stub that keeps the public
      // API + radio/radiogroup + button accessibility roles. Suites that assert
      // FeatureFlagsForm internals register their own vi.mock (takes precedence).
      {
        find: /^(.*\/)?FeatureFlagsForm$/,
        replacement: fileURLToPath(new URL('./test/feature-flags-form-stub.tsx', import.meta.url)),
      },
      // SwitcherForm is platform-split (SwitcherForm.ios.tsx renders a native
      // @expo/ui SwiftUI `Form`; SwitcherForm.android.tsx a native Compose
      // `LazyColumn` of cards) and backs both the OTA Channel + Branch switcher
      // screens. Vitest doesn't resolve `.ios`/`.android` extensions and can't mount
      // either native tree, so redirect the extensionless import to a faithful
      // passthrough stub that keeps the public API + button/field accessibility
      // roles. Suites that assert the switcher screens' model register their own
      // vi.mock (takes precedence).
      {
        find: /^(.*\/)?SwitcherForm$/,
        replacement: fileURLToPath(new URL('./test/switcher-form-stub.tsx', import.meta.url)),
      },
      // MoreForm is platform-split (MoreForm.ios.tsx renders a native @expo/ui
      // SwiftUI `Form`; MoreForm.android.tsx a native Compose `LazyColumn`).
      // Vitest doesn't resolve `.ios`/`.android` extensions and can't mount either
      // native tree, so redirect the extensionless import to a faithful
      // passthrough stub that keeps the public API + nav/button/switch/radio
      // accessibility roles. Suites that assert MoreForm internals register their
      // own vi.mock (takes precedence).
      {
        find: /^(.*\/)?MoreForm$/,
        replacement: fileURLToPath(new URL('./test/more-form-stub.tsx', import.meta.url)),
      },
      // LogbookChipRow is platform-split the same way as FilterChipRow
      // (LogbookChipRow.ios.tsx renders native @expo/ui SwiftUI glass chips;
      // LogbookChipRow.android.tsx is a placeholder). Vitest doesn't resolve
      // `.ios`/`.android` extensions and can't mount the SwiftUI host, so redirect
      // the extensionless import to a null stub. Suites that assert chip behaviour
      // register their own vi.mock (takes precedence).
      {
        find: /^(.*\/)?LogbookChipRow$/,
        replacement: fileURLToPath(new URL('./test/logbook-chip-row-stub.tsx', import.meta.url)),
      },
      // LogbookFacetRail is the iOS-glass chip row's inline rail (rendered below
      // the chips when a grade/angle/date facet is open). It pulls in Reanimated +
      // the native date picker, which can't mount under Vitest's react-native mock,
      // so redirect the extensionless import to a null stub. Suites that assert the
      // rail (logbook-tab-chips) register their own vi.mock (takes precedence).
      {
        find: /^(.*\/)?LogbookFacetRail$/,
        replacement: fileURLToPath(new URL('./test/logbook-facet-rail-stub.tsx', import.meta.url)),
      },
      // AppMenu is platform-split (AppMenu.ios.tsx renders a native @expo/ui SwiftUI
      // `Menu`; AppMenu.android.tsx a native Compose `DropdownMenu`). Vitest doesn't
      // resolve `.ios`/`.android` extensions and can't mount either native tree, so
      // redirect the extensionless import to a faithful passthrough stub that keeps
      // the public API + button accessibility roles (anchor + one button per action).
      // Suites that assert AppMenu internals register their own vi.mock (takes
      // precedence).
      {
        find: /^(.*\/)?AppMenu$/,
        replacement: fileURLToPath(new URL('./test/app-menu-stub.tsx', import.meta.url)),
      },
      // Button is platform-split (Button.ios.tsx renders a native @expo/ui SwiftUI
      // `Button`; Button.android.tsx the native Compose Material button family).
      // Vitest doesn't resolve `.ios`/`.android` extensions and can't mount either
      // native tree, so redirect the extensionless import to a faithful passthrough
      // stub that keeps the public API + the `button` accessibility role. Button is
      // the most-rendered primitive, so many screen/sheet suites hit this. Suites
      // that assert Button internals register their own vi.mock (takes precedence).
      {
        find: /^(.*\/)?Button$/,
        replacement: fileURLToPath(new URL('./test/button-stub.tsx', import.meta.url)),
      },
    ],
    // .tsx test files can opt into a jsdom environment per file via the
    // `// @vitest-environment jsdom` pragma — needed to render React
    // providers in tests. Pure-logic tests stay node-env (faster).
    // app/** covers Expo Router layout/screen tests (e.g. (tabs)/__tests__/).
    include: ['src/**/*.test.{ts,tsx}', 'app/**/*.test.{ts,tsx}'],
    exclude: [
      ...configDefaults.exclude,
      // hooks-dual-write.test.ts is the only suite that imports the REAL graphql
      // hooks barrel (for `useToggleFavorite`) rather than mocking it. The barrel
      // statically reaches `src/lib/auth.ts`, which does `import { Platform } from
      // 'react-native'`. Under RN 0.86, `react-native`'s entry is Flow source
      // (`import typeof * as ... from './index.js.flow'`); Rolldown's collection-time
      // scan parses that real source before any `vi.mock('react-native')` applies and
      // throws `SyntaxError: Unexpected token 'typeof'`. Unlike the local-module
      // `theme/animations` case above, a `react-native` alias can't intercept it —
      // node_modules `main` resolution bypasses vite aliases during the scan. The
      // dual-write control flow it covers is exercised at a lower level by the passing
      // mutation-queue + db suites (use-offline-mutations / drainer / connection).
      // TODO(offline-sync): restore once the RN-Flow scan-time parse is solved
      // (stub react-native at the Rolldown-scan level, or lazy-import the graphql
      // client so the auth chain leaves the static graph).
      '**/hooks-dual-write.test.ts',
    ],
  },
});
