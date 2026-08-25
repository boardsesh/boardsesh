import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import path from 'path';

// Load environment from root or web package
config({ path: path.resolve(process.cwd(), '../../.boardsesh/dev-db.env') });
config({ path: path.resolve(process.cwd(), '../../.env.local') });
config({ path: path.resolve(process.cwd(), '../web/.env.local') });
config({ path: path.resolve(process.cwd(), '../web/.env.development.local') });

// Hostnames that can only be a developer machine or a compose service, so TLS
// would be pointless there. Anything else is a real database and gets TLS.
const LOCAL_POSTGRES_HOSTS = new Set(['', 'localhost', '127.0.0.1', '0.0.0.0', '::1', 'postgres', 'postgres-test']);

// Support both DATABASE_URL (Neon) and individual POSTGRES_* variables (local Docker)
const getDatabaseConfig = () => {
  if (process.env.DATABASE_URL) {
    return {
      url: process.env.DATABASE_URL,
    };
  }
  return {
    host: process.env.POSTGRES_HOST!,
    port: Number(process.env.POSTGRES_PORT!),
    user: process.env.POSTGRES_USER!,
    password: process.env.POSTGRES_PASSWORD!,
    database: process.env.POSTGRES_DATABASE!,
    // Strictly additive: every case that used to get TLS still does, plus any
    // host that is demonstrably not a developer machine. VERCEL_ENV was the only
    // "this is a real database" signal before, which meant drizzle-kit against a
    // remote database from anywhere that is not Vercel — a laptop included —
    // silently ran without TLS (#4651). This branch only runs when DATABASE_URL
    // is unset (the early return above), i.e. the local POSTGRES_* path.
    ssl:
      !LOCAL_POSTGRES_HOSTS.has((process.env.POSTGRES_HOST ?? '').trim().toLowerCase()) ||
      process.env.IS_CI === 'true' ||
      // TODO(#4656): retire with the Vercel project.
      process.env.VERCEL_ENV === 'production',
  };
};

export default defineConfig({
  out: './drizzle',
  schema: './dist/schema/index.js',
  dialect: 'postgresql',
  dbCredentials: getDatabaseConfig(),
});
