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
    exclude: ['**/node_modules/**', '**/dist/**', 'backend/**', 'e2e/**', 'auth-prototype/**', 'partner-oauth-e2e/**'],
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
    // Mirror packages/web/tsconfig.json "paths". Order matters: vite matches the
    // first alias whose key prefixes the import, so the specific @/lib and @/c
    // aliases must come before the catch-all @ — otherwise @/lib/x resolves to
    // ./lib/x instead of ./app/lib/x.
    alias: {
      '@/lib': resolve(__dirname, './app/lib'),
      '@/c': resolve(__dirname, './app/components'),
      '@/app': resolve(__dirname, './app'),
      '@': resolve(__dirname, '.'),
    },
  },
});
