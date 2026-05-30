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
    // .tsx test files can opt into a jsdom environment per file via the
    // `// @vitest-environment jsdom` pragma — needed to render React
    // providers in tests. Pure-logic tests stay node-env (faster).
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
