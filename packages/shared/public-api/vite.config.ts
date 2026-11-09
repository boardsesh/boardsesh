import { defineConfig } from 'vite-plus';

export default defineConfig({ test: { name: 'public-api', environment: 'node', include: ['src/**/*.test.ts'] } });
