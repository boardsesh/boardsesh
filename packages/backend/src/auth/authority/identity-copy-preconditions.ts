import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { authAccount, authEmailProjection } from '@boardsesh/db/schema';
import { verifyFence } from '@boardsesh/db/auth-web-acl';
import type { AuthorityTransaction } from './adapter';
import { assertIdentityCopyGates } from './identity-copy-gates';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../current-store/foundation-context';
import {
  CREDENTIAL_WRITER_ROLE,
  credentialWriterContract,
  type CredentialDatabaseEnvironment,
} from '../credential-database-configuration';

/**
 * Why the identity mirror refuses to boot (or boots inert) and the import
 * refuses to run. Each code names one precondition and is the whole message:
 * no driver text, SQL, URL or identity leaves through it.
 * docs/auth/better-auth-identity-mirror.md and docs/auth/better-auth-identity-import.md
 * list them. The code gates in identity-copy-gates.ts and the activation gates
 * refuse with their own fixed codes.
 */
export type IdentityCopyRefusal =
  | 'MIRROR_SELECTOR_INVALID'
  | 'SET_PASSWORD_NOT_DELEGATED'
  | 'NATIVE_WRITERS_NOT_STAGED'
  | 'AUTHORITY_CONFIGURATION_INVALID'
  | 'CREDENTIAL_WRITER_UNQUALIFIED'
  | 'MIRROR_TABLES_MISSING'
  | 'AUTHORITY_NOT_ENFORCED'
  | 'AUTHORITY_NOT_CURRENT_STORE'
  | 'AUTHORITY_STALE'
  | 'WEB_FENCE_UNVERIFIED'
  | 'PRECONDITION_CHECK_UNAVAILABLE'
  | 'MIRROR_NOT_QUALIFIED';

export class IdentityCopyPreconditionError extends Error {
  constructor(readonly code: IdentityCopyRefusal) {
    super(code);
    this.name = 'IdentityCopyPreconditionError';
  }
}

/** The enforced manifest a copy was qualified under. */
export interface IdentityCopyAuthority {
  readonly projectionId: string;
  readonly epoch: number;
}

/** The current manifest as the precondition snapshot read it. */
export interface IdentityCopySnapshot extends IdentityCopyAuthority {
  readonly authority: 'current-store' | 'better-auth';
}

const sqlState = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * "Checked and failed" versus "could not check". A refusal from the qualifier,
 * a contract or target mismatch, or a rejected login (SQLSTATE class 28) is a
 * verdict on the LOGIN. A dropped connection, timeout or any other driver
 * error only means the check did not complete.
 */
export function writerQualificationRefusal(error: unknown): IdentityCopyPreconditionError {
  if (error instanceof IdentityCopyPreconditionError) return error;
  const verdict =
    (error instanceof Error && error.name === 'CredentialWriterQualificationError') ||
    (error instanceof Error &&
      ['CREDENTIAL_DATABASE_CONTRACT_MISMATCH', 'CREDENTIAL_DATABASE_TARGET_MISMATCH'].includes(error.message)) ||
    sqlState(error)?.startsWith('28') === true;
  return new IdentityCopyPreconditionError(
    verdict ? 'CREDENTIAL_WRITER_UNQUALIFIED' : 'PRECONDITION_CHECK_UNAVAILABLE',
  );
}

/**
 * `verifyFence` refuses with a bare upper-case code (UNSAFE_WEB_ROLE,
 * IDENTITY_WRITE_PATH, ...) and no SQLSTATE. Anything else came from the driver
 * or the server, so the fence was not judged.
 */
export function fenceRefusal(error: unknown): IdentityCopyPreconditionError {
  const verdict =
    error instanceof Error && sqlState(error) === undefined && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message);
  return new IdentityCopyPreconditionError(verdict ? 'WEB_FENCE_UNVERIFIED' : 'PRECONDITION_CHECK_UNAVAILABLE');
}

/**
 * Drizzle over one postgres.js transaction. postgres.js transaction handles omit
 * the parser metadata Drizzle reads, so expose only the client's.
 */
export function transactionDatabase(connection: postgres.TransactionSql, client: postgres.Sql): AuthorityTransaction {
  const transactionClient = new Proxy(connection, {
    get(target, property, receiver) {
      return property === 'options' ? client.options : Reflect.get(target, property, receiver);
    },
  });
  return drizzle(transactionClient as unknown as postgres.Sql) as unknown as AuthorityTransaction;
}

const COPIED_COLUMNS = [
  authAccount.id,
  authAccount.userId,
  authAccount.providerId,
  authAccount.accountId,
  authAccount.password,
  authAccount.sourceGeneration,
].map((column) => column.name);
const SUBJECT_KEY = [authAccount.providerId.name, authAccount.accountId.name].join(',');

/**
 * Catalog observation only: the columns the copy writes, the unique
 * (provider, subject) index its upsert relies on, and the manifest's authority
 * column (migration 0305 and the generation/authority columns after it).
 * A catalog that cannot be read is PRECONDITION_CHECK_UNAVAILABLE.
 * Runs before qualification, so an unmigrated database names itself.
 */
export async function assertIdentityCopyTables(client: postgres.Sql): Promise<void> {
  let present: Set<string>;
  let uniqueIndexes: readonly { columns: string }[];
  try {
    const columns = await client<{ name: string }[]>`
      SELECT attribute.attname AS name FROM pg_catalog.pg_attribute attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass('public.auth_account') AND attribute.attnum > 0 AND NOT attribute.attisdropped
      UNION ALL
      SELECT 'manifest:' || attribute.attname FROM pg_catalog.pg_attribute attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass('public.auth_email_projection')
        AND attribute.attname = 'writer_authority' AND NOT attribute.attisdropped`;
    uniqueIndexes = await client<{ columns: string }[]>`
      SELECT pg_catalog.array_to_string(ARRAY(
        SELECT attribute.attname FROM unnest(index_row.indkey::pg_catalog.int2[]) WITH ORDINALITY AS key(number, position)
        JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = index_row.indrelid AND attribute.attnum = key.number
        ORDER BY key.position), ',') AS columns
      FROM pg_catalog.pg_index index_row
      WHERE index_row.indrelid = pg_catalog.to_regclass('public.auth_account') AND index_row.indisunique
        AND index_row.indisvalid AND index_row.indpred IS NULL AND index_row.indexprs IS NULL`;
    present = new Set(columns.map(({ name }) => name));
  } catch (error) {
    // The first query on the writer LOGIN: a rejected login is a verdict, the rest is not.
    throw writerQualificationRefusal(error);
  }
  if (
    !COPIED_COLUMNS.every((name) => present.has(name)) ||
    !present.has('manifest:writer_authority') ||
    !uniqueIndexes.some((index) => index.columns === SUBJECT_KEY)
  )
    throw new IdentityCopyPreconditionError('MIRROR_TABLES_MISSING');
}

/**
 * One read-only snapshot: the current manifest is enforced under the current
 * normalizer and the web login's fence verifies against the live catalog. The
 * caller judges the authority and epoch it returns. Phase `enforced` is only
 * written by `auth-authority activate`, which refuses while its code gates are
 * open; the import checks those gates again because the phase is database state.
 */
export async function readIdentityCopySnapshot(client: postgres.Sql): Promise<IdentityCopySnapshot> {
  let manifest:
    | {
        projectionId: string;
        normalizerVersion: string;
        phase: string;
        writerEpoch: number;
        writerAuthority: 'current-store' | 'better-auth';
      }
    | undefined;
  let fence: { readonly verified: true } | { readonly verified: false; readonly error: unknown };
  try {
    [manifest, fence] = await client.begin('isolation level repeatable read read only', async (snapshot) => {
      const [current] = await transactionDatabase(snapshot, client)
        .select({
          projectionId: authEmailProjection.projectionId,
          normalizerVersion: authEmailProjection.normalizerVersion,
          phase: authEmailProjection.phase,
          writerEpoch: authEmailProjection.writerEpoch,
          writerAuthority: authEmailProjection.writerAuthority,
        })
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      // The fence is judged on the same snapshot; its verdict is kept, not thrown here.
      const verdict = await verifyFence(snapshot).then(
        () => ({ verified: true as const }),
        (error: unknown) => ({ verified: false as const, error }),
      );
      return [current, verdict] as const;
    });
  } catch {
    throw new IdentityCopyPreconditionError('PRECONDITION_CHECK_UNAVAILABLE');
  }
  if (!manifest || manifest.phase !== 'enforced' || manifest.normalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION)
    throw new IdentityCopyPreconditionError('AUTHORITY_NOT_ENFORCED');
  if (!fence.verified) throw fenceRefusal(fence.error);
  return Object.freeze({
    projectionId: manifest.projectionId,
    epoch: manifest.writerEpoch,
    authority: manifest.writerAuthority,
  });
}

/**
 * Everything the import checks before it reads or writes one identity row,
 * except the activation gates its command checks next. Its only connection must
 * authenticate as the dedicated credential LOGIN with exactly the reviewed
 * grants, so the qualified login is the one that copies. The code gates come
 * last, so a refusal there means every database precondition held.
 */
export async function qualifyIdentityImport(
  client: postgres.Sql,
  database: string,
  environment: CredentialDatabaseEnvironment,
): Promise<IdentityCopyAuthority> {
  let contract: ReturnType<typeof credentialWriterContract>;
  try {
    contract = credentialWriterContract(environment);
  } catch {
    throw new IdentityCopyPreconditionError('CREDENTIAL_WRITER_UNQUALIFIED');
  }
  await assertIdentityCopyTables(client);
  try {
    const { qualifyCredentialWriter } = await import('@boardsesh/db/credential-writer-acl');
    await qualifyCredentialWriter(client, {
      expectedRole: CREDENTIAL_WRITER_ROLE,
      expectedDatabase: database,
      contract,
    });
  } catch (error) {
    throw writerQualificationRefusal(error);
  }
  const snapshot = await readIdentityCopySnapshot(client);
  if (snapshot.authority !== 'current-store') throw new IdentityCopyPreconditionError('AUTHORITY_NOT_CURRENT_STORE');
  assertIdentityCopyGates();
  return Object.freeze({ projectionId: snapshot.projectionId, epoch: snapshot.epoch });
}
