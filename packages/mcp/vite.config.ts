import { defineConfig } from 'vite-plus';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { name: 'mcp', environment: 'node', include: ['src/**/*.test.ts'] },
});
