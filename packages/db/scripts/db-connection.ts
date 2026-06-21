import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment files (same as migrate.ts)
config({ path: path.resolve(__dirname, '../../../.boardsesh/dev-db.env') });
config({ path: path.resolve(__dirname, '../../../.env.local') });
config({ path: path.resolve(__dirname, '../../web/.env.local') });
config({ path: path.resolve(__dirname, '../../web/.env.development.local') });

export function getScriptDatabaseUrl(): string {
  const databaseUrl = process.env.DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL, POSTGRES_URL, or DB_URL is not set');
    process.exit(1);
  }

  const isLocalUrl =
    databaseUrl.includes('localhost') || databaseUrl.includes('localtest.me') || databaseUrl.includes('127.0.0.1');

  if (process.env.VERCEL && isLocalUrl) {
    console.error('Refusing to run with local DATABASE_URL in Vercel build');
    process.exit(1);
  }

  return databaseUrl;
}

type ScriptDb = ReturnType<typeof drizzle>;

export function createScriptDb(url?: string): { db: ScriptDb; close: () => Promise<void> } {
  const databaseUrl = url ?? getScriptDatabaseUrl();
  // Scripts are short-lived one-shots and target the direct (non-pooled) URL,
  // so a single connection is sufficient and avoids opening 10 by default.
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  return {
    db,
    close: async () => {
      await client.end();
    },
  };
}
