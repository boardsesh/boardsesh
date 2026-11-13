import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Preserve mock history from setup and beforeAll when upgrading from Vitest 4.
    clearMocks: false,
    name: 'playlists-react',
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
