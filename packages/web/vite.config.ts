import { defineConfig } from 'vite-plus';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': '"test"',
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    globals: true,
    env: {
      NODE_ENV: 'test',
    },
    exclude: ['**/node_modules/**', '**/dist/**', 'backend/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      include: ['app/**/*.{ts,tsx}'],
      exclude: ['app/**/*.test.{ts,tsx}', 'app/**/*.spec.{ts,tsx}', 'app/**/types.ts', 'app/**/__tests__/**'],
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
  },
  resolve: {
    // Order matters: more-specific prefixes first so `@/lib/...` doesn't get
    // captured by the bare `@` alias and resolved against the package root.
    alias: [
      { find: '@/app', replacement: resolve(__dirname, './app') },
      { find: '@/lib', replacement: resolve(__dirname, './app/lib') },
      { find: '@/c', replacement: resolve(__dirname, './app/components') },
      { find: '@', replacement: resolve(__dirname, '.') },
    ],
  },
});
