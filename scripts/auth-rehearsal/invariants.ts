import { keyedReference, RehearsalSafetyError } from './target-guard';
import type { OwnedDatabase } from './database';

export interface IdentityInvariant {
  readonly identityDigest: string;
  readonly userCount: number;
  readonly providerCount: number;
  readonly referenceColumns: number;
  readonly referenceRows: number;
  readonly referenceDigest: string;
}
/** Counts the fixture's actual FK catalog; this is not the restored production 79-reference audit. */
export async function identityInvariant(database: OwnedDatabase): Promise<IdentityInvariant> {
  await database.assertMarker();
  const users = await database.client`SELECT id, email, "emailVerified", name FROM users ORDER BY id`;
  const providers =
    await database.client`SELECT "userId", provider, "providerAccountId" FROM accounts ORDER BY "userId", provider, "providerAccountId"`;
  const references = await database.client<{ table_name: string; column_name: string }[]>`
    SELECT relation.relname AS table_name, attribute.attname AS column_name
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attnum = constraint_row.conkey[1]
    WHERE constraint_row.contype = 'f' AND constraint_row.confrelid = 'public.users'::regclass
      AND namespace.nspname = 'public' AND cardinality(constraint_row.conkey) = 1
    ORDER BY relation.relname, attribute.attname`;
  const counts: { table: string; column: string; count: number }[] = [];
  for (const reference of references) {
    if (
      !/^[A-Za-z_][A-Za-z_0-9]*$/.test(reference.table_name) ||
      !/^[A-Za-z_][A-Za-z_0-9]*$/.test(reference.column_name)
    )
      throw new RehearsalSafetyError('OWNED_REFERENCE_CATALOG_REFUSED');
    const rows = await database.client.unsafe<{ count: number }[]>(
      `SELECT count(*)::integer AS count FROM "${reference.table_name}" WHERE "${reference.column_name}" IS NOT NULL`,
    );
    counts.push({ table: reference.table_name, column: reference.column_name, count: rows[0].count });
  }
  // Exact fixture mutation registry: every other users-FK count must remain unchanged.
  const mutableReferenceTables = new Set([
    'auth_session',
    'auth_credential_lineage',
    'auth_subject_cutoffs',
    'auth_security_mutation_events',
    'mobile_refresh_tokens',
    'user_activity_days',
  ]);
  const stableCounts = counts.filter((reference) => !mutableReferenceTables.has(reference.table));
  return {
    identityDigest: keyedReference(database.target.secrets.reportKey, JSON.stringify({ users, providers })),
    userCount: users.length,
    providerCount: providers.length,
    referenceColumns: references.length,
    referenceRows: stableCounts.reduce((total, reference) => total + reference.count, 0),
    referenceDigest: keyedReference(database.target.secrets.reportKey, JSON.stringify(stableCounts)),
  };
}
