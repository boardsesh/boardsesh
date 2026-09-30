import { defineConfig } from 'vitest/config';

// Unit tests cover the app's pure TypeScript modules (workout engine, session
// store, filter mapping). They run in node, so they must not import react-native.
export default defineConfig({
  define: {
    __DEV__: 'true',
  },
  resolve: {
    dedupe: ['react'],
  },
  test: {
    name: 'boardz',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
