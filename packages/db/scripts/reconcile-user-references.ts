/// <reference types="node" />
import postgres from 'postgres';
import * as schema from '../src/schema/index.js';
import {
  collectUserReferenceCatalog,
  compareUserReferences,
  readExpectedUserReferences,
} from '../src/user-reference-catalog.js';
import { scriptDatabaseConnectionOptions } from './db-connection.js';

const REPORTED_DIFFERENCE_LIMIT = 100;

/**
 * Compares the inbound foreign keys to `public.users` on a live database with
 * this checkout's Drizzle declarations, over a read-only TCP connection. It only
 * reads the catalog: the session defaults to read-only and the collector runs in
 * one REPEATABLE READ READ ONLY transaction. Exits nonzero on any difference.
 * It takes an explicit URL only, never the application's DATABASE_URL.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.USER_REFERENCE_CATALOG_DATABASE_URL;
  if (!databaseUrl) throw new Error('USER_REFERENCE_CATALOG_DATABASE_URL is not set');
  const client = postgres(databaseUrl, {
    ...scriptDatabaseConnectionOptions(databaseUrl),
    connect_timeout: 10,
    fetch_types: false,
    onnotice: () => {},
    connection: { application_name: 'boardsesh_user_reference_catalog', default_transaction_read_only: true },
  });
  try {
    const expected = readExpectedUserReferences(schema);
    const catalog = await collectUserReferenceCatalog(client, {}, 'tcp');
    const differences = compareUserReferences(expected, catalog.references);
    console.info(
      JSON.stringify({
        status: differences.length === 0 ? 'matched' : 'different',
        target: catalog.physical,
        snapshot: catalog.snapshot,
        expectedReferences: expected.length,
        observedReferences: catalog.references.length,
        differences: differences.slice(0, REPORTED_DIFFERENCE_LIMIT),
        omittedDifferences: Math.max(0, differences.length - REPORTED_DIFFERENCE_LIMIT),
      }),
    );
    if (differences.length > 0) process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  // Driver messages can repeat connection details, so report only the category.
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'failed';
  console.error(JSON.stringify({ status: 'incomplete', code }));
  process.exitCode = 1;
});
