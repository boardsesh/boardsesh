import { defineConfig } from 'vite-plus';

export default defineConfig({ test: { name: 'auth-protocol', environment: 'node', include: ['src/**/*.test.ts'] } });
