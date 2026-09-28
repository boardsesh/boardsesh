import { defineConfig } from 'vite-plus';
import { SERIAL_TEST_FILES } from './vitest-serial-files.ts';

/** The backend tests that must run one file at a time; see vitest-serial-files.ts. */
export default defineConfig({
  test: {
    name: 'backend-serial',
    globals: true,
    environment: 'node',
    include: SERIAL_TEST_FILES,
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: false,
    maxWorkers: 1,
    // fileParallelism only serializes files within this project. In a run with
    // other projects (the root `vp test`), a higher group order starts these
    // files only after every group-0 project (`backend` among them) finished.
    sequence: { groupOrder: 1 },
    globalSetup: ['./src/__tests__/global-setup.ts'],
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 10000,
    hookTimeout: 60000,
    env: {
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/boardsesh_backend_test',
    },
  },
});
