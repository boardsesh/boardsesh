import { createRequire } from 'node:module';
import { defineConfig } from 'vite-plus';
import { SERIAL_TEST_FILES } from './vitest-serial-files.ts';

// Vite resolves a bare `graphql` import to its `module` field (index.mjs), while
// `@graphql-tools/schema` and the servers stay externalised on Node's resolution
// (index.js). Two copies of graphql-js in one process means `execute` rejects the
// schema as "from another module or realm", so inlined code is pointed at the
// same CommonJS entry the app actually runs on under tsx.
const graphqlEntry = createRequire(import.meta.url).resolve('graphql');

export default defineConfig({
  test: {
    name: 'backend',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // These run one at a time in the backend-serial project (vite.serial.config.ts).
    // The auth-prototype project (vite.auth-prototype.config.ts) owns the prototype
    // folder and the identity audit files that use its disposable databases.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'src/auth/prototype/**',
      'src/auth/__tests__/identity-audit*.test.ts',
      ...SERIAL_TEST_FILES,
    ],
    alias: [{ find: /^graphql$/, replacement: graphqlEntry }],
    globalSetup: ['./src/__tests__/global-setup.ts'],
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 10000,
    hookTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.test.ts'],
    },
    env: {
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/boardsesh_backend_test',
    },
  },
});
