import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Preserve mock history from setup and beforeAll when upgrading from Vitest 4.
    clearMocks: false,
    name: 'queue-react',
    globals: true,
    // Default to node: the factory (create-queue-mutations) is pure and needs no
    // renderer. The React-wrapper test (use-queue-mutations.test.ts) opts into
    // jsdom per-file via a `// @vitest-environment jsdom` docblock.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
