import { defineConfig } from 'vite-plus';
import { SERIAL_TEST_FILES } from './vitest-serial-files.ts';

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
