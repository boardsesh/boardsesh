import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // React Native / Metro inject __DEV__ at runtime. Vitest evaluates in node,
  // where the symbol is undefined — replacing it here lets src/ files use
  // `if (__DEV__) { ... }` without guarding for the test environment.
  define: {
    __DEV__: 'true',
  },
  test: {
    name: 'mobile',
    globals: true,
    environment: 'node',
    alias: [
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
    ],
    // .tsx test files can opt into a jsdom environment per file via the
    // `// @vitest-environment jsdom` pragma — needed to render React
    // providers in tests. Pure-logic tests stay node-env (faster).
    // app/** covers Expo Router layout/screen tests (e.g. (tabs)/__tests__/).
    include: ['src/**/*.test.{ts,tsx}', 'app/**/*.test.{ts,tsx}'],
  },
});
