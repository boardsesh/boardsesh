/// <reference types="node" />
import postgres from 'postgres';

// Explicit development/CI-only adapter. Production never creates application
// roles implicitly, and still requires the separately reviewed admin step.
const adminUrl = process.env.SYNC_CUTOFF_ADMIN_DATABASE_URL;
if (process.env.SYNC_CUTOFF_DEVELOPMENT_BOOTSTRAP !== 'true' || !adminUrl) {
  throw new Error('Development bootstrap requires SYNC_CUTOFF_DEVELOPMENT_BOOTSTRAP=true and an explicit admin URL');
}
const hostname = new URL(adminUrl).hostname;
if (!['localhost', '127.0.0.1', 'postgres'].includes(hostname)) {
  throw new Error('Development cutoff bootstrap accepts only an isolated local PostgreSQL host');
}
if (!process.argv.includes('--apply')) throw new Error('Development bootstrap requires --apply');
const runtimeRole = process.env.SYNC_CUTOFF_RUNTIME_ROLE ?? 'boardsesh_runtime';
if (!/^[a-z_][a-z0-9_]*$/.test(runtimeRole)) throw new Error('Runtime role must be a simple PostgreSQL identifier');
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
try {
  const [role] = await admin<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${runtimeRole}) AS exists
  `;
  if (!role.exists) {
    await admin.unsafe(
      `CREATE ROLE "${runtimeRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`,
    );
  }
} finally {
  await admin.end();
}
await import('./bootstrap-sync-deletions-cutoff.js');
