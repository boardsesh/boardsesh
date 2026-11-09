import { defineConfig } from 'drizzle-kit';

// Separate from drizzle.config.ts: these tables never enter the product schema.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/auth-prototype/index.ts',
  out: './auth-prototype-migrations',
});
