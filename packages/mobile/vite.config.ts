import { defineConfig } from 'vitest/config';

export default defineConfig({
  // React Native / Metro inject __DEV__ at runtime. Vitest evaluates in node,
  // where the symbol is undefined — replacing it here lets src/ files use
  // `if (__DEV__) { ... }` without guarding for the test environment.
  define: {
    __DEV__: 'true',
  },
  // The mobile package pins its own react, while the shared `@boardsesh/*-react`
  // packages resolve the workspace-root react. A test that renders a shared hook
  // (e.g. `useCreateClimb`) would otherwise load two React copies and trip
  // "Invalid hook call". Dedupe collapses them onto a single instance.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  test: {
    name: 'mobile',
    globals: true,
    environment: 'node',
    // .tsx test files can opt into a jsdom environment per file via the
    // `// @vitest-environment jsdom` pragma — needed to render React
    // providers in tests. Pure-logic tests stay node-env (faster).
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
