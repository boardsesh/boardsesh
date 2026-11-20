import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { authEmailProjection } from '@boardsesh/db/schema';
import { createDbOnPool, createDedicatedPoolFromUrl, type PoolInstance } from '@boardsesh/db/client';
import { isPrivateHostname } from '@boardsesh/db/client/config';
import type { CredentialWriterContract } from '@boardsesh/db/credential-writer-acl';
import { prepareProjectionUnderUsersTableLock } from '../../../current-store/email-reservations';
import type { CurrentStoreTransaction } from '../../../current-store/foundation-context';
import { ensureOwnedCredentialLogins, grantOwnedCredentialWriterCapabilities } from './credential-writer-environment';

/** What the browser-session harness reads the result after (`SEED_OUTPUT_PREFIX` in packages/web/e2e/browser-session/stack.ts). */
const SEED_OUTPUT_PREFIX = 'BROWSER_SESSION_E2E_SEED=';

/**
 * What `AUTH_BROWSER_SESSION_MODE=better-auth` needs in the database before
 * the backend can serve a browser session, made the way the backend's own
 * tests make it and never by hand-written SQL (#7596 B7b). The browser-session
 * e2e harness (packages/web/e2e/browser-session/global-setup.ts) runs it with
 * tsx before it starts the servers:
 *
 * - the dedicated credential LOGIN `boardsesh_identity_writer` with the
 *   reviewed grants of one contract, from the credential-writer fixture that
 *   CI's `test-credential-writer` job uses (`ensureOwnedCredentialLogins`,
 *   `grantOwnedCredentialWriterCapabilities`). The private web commands open
 *   their database only through that LOGIN and never fall back.
 * - an enforced authority manifest: `prepareProjectionUnderUsersTableLock`,
 *   the operator's `prepare`, then the phase set to `enforced`, as the backend
 *   suites do. `activate` itself stays closed by its code gates, and the
 *   staged writers only need the enforced phase with the configured projection
 *   id and writer epoch. A manifest already prepared is enforced, and one
 *   already enforced is reused.
 *
 * Both change the database for good: the grant step revokes PUBLIC grants on
 * every table. So it runs only on a disposable database: CI's dev-database
 * service, or a local one with BROWSER_SESSION_E2E_PREPARE_DATABASE=1
 * (reset with `docker compose down -v && vp run db:up`). Prints the values
 * the two services need.
 */

/** The widest reviewed contract: the canonical schema (0313 onward) refuses the narrower web profiles. */
export const CREDENTIAL_WRITER_CONTRACT: CredentialWriterContract = 'private-first-password-v1';
const PROJECTION_ID_PREFIX = 'browser-session-e2e-';

function assertDisposable(databaseUrl: URL): void {
  const disposable =
    (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true') ||
    process.env.BROWSER_SESSION_E2E_PREPARE_DATABASE === '1';
  if (!disposable || !isPrivateHostname(databaseUrl.hostname.toLowerCase())) {
    throw new Error(
      'The better-auth run changes database grants and the authority manifest. It runs on CI, or locally with ' +
        'BROWSER_SESSION_E2E_PREPARE_DATABASE=1 on a dev database you can recreate.',
    );
  }
}

async function enforcedManifest(owner: PoolInstance): Promise<{ projectionId: string; writerEpoch: number }> {
  const database = createDbOnPool(owner, { logger: false });
  return database.transaction(async (transaction) => {
    const [current] = await transaction
      .select()
      .from(authEmailProjection)
      .where(eq(authEmailProjection.isCurrent, true));
    if (current?.phase === 'enforced') return { projectionId: current.projectionId, writerEpoch: current.writerEpoch };
    if (current?.phase === 'prepared') {
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
      return { projectionId: current.projectionId, writerEpoch: current.writerEpoch };
    }
    if (current) throw new Error(`The current authority manifest is ${current.phase}; recreate the dev database.`);
    const prepared = await prepareProjectionUnderUsersTableLock(transaction as unknown as CurrentStoreTransaction, {
      projectionId: `${PROJECTION_ID_PREFIX}${randomUUID()}`,
    });
    await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    return { projectionId: prepared.projectionId, writerEpoch: prepared.writerEpoch };
  });
}

async function main(): Promise<void> {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? 'postgresql://unset');
  assertDisposable(databaseUrl);
  const owner = createDedicatedPoolFromUrl(databaseUrl.toString(), 1);
  try {
    const { writerPassword } = await ensureOwnedCredentialLogins(owner);
    await grantOwnedCredentialWriterCapabilities(owner, CREDENTIAL_WRITER_CONTRACT);
    const manifest = await enforcedManifest(owner);
    const identityDatabaseUrl = new URL(databaseUrl);
    identityDatabaseUrl.username = 'boardsesh_identity_writer';
    identityDatabaseUrl.password = writerPassword;
    process.stdout.write(
      `${SEED_OUTPUT_PREFIX}${JSON.stringify({
        ...manifest,
        identityDatabaseUrl: identityDatabaseUrl.toString(),
        contract: CREDENTIAL_WRITER_CONTRACT,
      })}\n`,
    );
  } finally {
    await owner.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
