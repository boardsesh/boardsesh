import postgres from 'postgres';
import { expect, it, vi } from 'vite-plus/test';
import { createNativeHttpFixture } from './http-fixture';

// Force a failure AFTER fresh DB creation and schema setup, with an invocation
// UUID fixed only inside this isolated test module so ownership stays exact.
const startupState = vi.hoisted(() => ({ handlerImportReached: false }));
const invocationId = vi.hoisted(() => globalThis.crypto.randomUUID());
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: () => invocationId,
}));
vi.mock('../../handlers/native-auth', () => {
  startupState.handlerImportReached = true;
  throw new Error('Synthetic native handler startup failure');
});

it('a failed startup removes only its newly-created synthetic database', async () => {
  const adminUrl = process.env.NATIVE_CONTRACT_DATABASE_URL;
  if (!adminUrl || !['127.0.0.1', 'localhost'].includes(new URL(adminUrl).hostname))
    throw new Error('Explicit loopback synthetic admin URL required');
  const databaseName = `native_contract_${invocationId.replaceAll('-', '')}`;
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    expect(await admin`SELECT datname FROM pg_database WHERE datname = ${databaseName}`).toHaveLength(0);
    await expect(createNativeHttpFixture()).rejects.toThrow();
    expect(startupState.handlerImportReached).toBe(true);
    expect(await admin`SELECT datname FROM pg_database WHERE datname = ${databaseName}`).toHaveLength(0);
  } finally {
    await admin.end();
  }
});
