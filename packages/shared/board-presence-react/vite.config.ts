import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'board-presence-react',
    globals: true,
    // The hook + provider drive a `useReducer` and need a renderer, so every
    // test uses @testing-library/react under jsdom.
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
