/** Server-side row digests: credential values never cross the connection. */
import { sql, type SQL } from 'drizzle-orm';
import { ConsolidationError, consolidationDigest } from './planner';
import type { ConsolidationContext, ConsolidationTransaction } from './executor';

export interface ConsolidationTableState {
  readonly schema: string;
  readonly table: string;
  readonly present: boolean;
  readonly rows: number;
  readonly bytes: number;
  readonly schemaFingerprint: string;
  readonly fingerprint: string;
}
export interface ConsolidationGroupState {
  readonly tables: readonly ConsolidationTableState[];
  readonly fingerprint: string;
}
interface TableSelection {
  schema: string;
  table: string;
  columns: string[];
  jsonColumns: string[];
  emailColumn?: string;
  resource?: 'entity' | 'resource' | 'playlist' | 'session' | 'job';
}
const NON_FK: readonly TableSelection[] = [
  ...['comments', 'votes', 'vote_counts', 'feed_items', 'notifications', 'content_privacy'].map((table) => ({
    schema: 'public',
    table,
    columns: [],
    jsonColumns: [],
    resource: 'entity' as const,
  })),
  ...['resource_privacy', 'resource_grants'].map((table) => ({
    schema: 'public',
    table,
    columns: [],
    jsonColumns: [],
    resource: 'resource' as const,
  })),
  { schema: 'public', table: 'playlists', columns: [], jsonColumns: [], resource: 'playlist' },
  ...['session_workouts', 'session_health_kit_workouts', 'board_session_participants'].map((table) => ({
    schema: 'public',
    table,
    columns: [],
    jsonColumns: [],
    resource: 'session' as const,
  })),
  {
    schema: 'public',
    table: 'account_consolidation_members',
    columns: ['source_user_id', 'canonical_user_id'],
    jsonColumns: [],
  },
  ...[
    'account_consolidation_tick_aliases',
    'account_consolidation_import_aliases',
    'account_consolidation_session_aliases',
  ].map((table) => ({ schema: 'public', table, columns: ['target_user_id'], jsonColumns: [] })),
  { schema: 'public', table: 'verificationTokens', columns: [], jsonColumns: [], emailColumn: 'identifier' },
  { schema: 'public', table: 'logbook_changes', columns: ['user_id'], jsonColumns: [] },
  { schema: 'public', table: 'sync_deletions', columns: ['user_id'], jsonColumns: [] },
  { schema: 'public', table: 'auth_subject_cutoffs', columns: ['user_id'], jsonColumns: [] },
  { schema: 'public', table: 'auth_security_mutation_events', columns: ['user_id'], jsonColumns: [] },
  { schema: 'public', table: 'auth_email_reservation_members', columns: ['user_id'], jsonColumns: [] },
  {
    schema: 'public',
    table: 'auth_email_reservations',
    columns: ['owner_user_id'],
    jsonColumns: [],
    emailColumn: 'normalized_email',
  },
  { schema: 'public', table: 'auth_email_verification_state', columns: ['user_id'], jsonColumns: [] },
  { schema: 'public', table: 'auth_email_verification_tokens', columns: ['user_id'], jsonColumns: [] },
  { schema: 'public', table: 'auth_password_recovery_state', columns: ['user_id'], jsonColumns: [] },
  { schema: 'public', table: 'auth_password_recovery_tokens', columns: ['user_id'], jsonColumns: [] },
  { schema: 'public', table: 'background_job_runs', columns: [], jsonColumns: ['payload'] },
  { schema: 'pgboss', table: 'job', columns: [], jsonColumns: ['data'], resource: 'job' },
];
const LIMIT_ROWS = 100000;
const LIMIT_BYTES = 67108864;
function countOf(input: unknown): number {
  const parsed = typeof input === 'string' ? Number(input) : input;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new ConsolidationError('INVALID_EVIDENCE');
  return parsed;
}
function predicates(table: TableSelection, userIds: readonly string[]): SQL {
  const ids = sql.join(
    userIds.map((userId) => sql`${userId}`),
    sql`, `,
  );
  const clauses: SQL[] = table.columns.map((column) => sql`original.${sql.identifier(column)} IN (${ids})`);
  for (const column of table.jsonColumns)
    for (const userId of userIds)
      clauses.push(
        sql`pg_catalog.jsonb_path_exists(original.${sql.identifier(column)}, '$.** ? (@ == $subject)'::jsonpath, pg_catalog.jsonb_build_object('subject',${userId}::text))`,
      );
  if (table.emailColumn === 'identifier')
    clauses.push(
      sql`original.${sql.identifier(table.emailColumn)} IN (SELECT email FROM public.users WHERE id IN (${ids}) UNION SELECT 'password-reset:'||email FROM public.users WHERE id IN (${ids}))`,
    );
  else if (table.emailColumn)
    clauses.push(
      sql`original.${sql.identifier(table.emailColumn)} IN (SELECT pg_catalog.lower(pg_catalog.btrim(email)) FROM public.users WHERE id IN (${ids}))`,
    );
  if (table.resource === 'entity')
    clauses.push(
      sql`((original.entity_type='session' AND original.entity_id IN (SELECT id FROM public.board_sessions WHERE created_by_user_id IN (${ids}))) OR (original.entity_type='tick' AND original.entity_id IN (SELECT uuid FROM public.boardsesh_ticks WHERE user_id IN (${ids}))))`,
    );
  if (table.resource === 'resource')
    clauses.push(
      sql`original.kind='session' AND original.resource_id IN (SELECT id FROM public.board_sessions WHERE created_by_user_id IN (${ids}))`,
    );
  if (table.resource === 'session')
    clauses.push(
      sql`original.session_id IN (SELECT id FROM public.board_sessions WHERE created_by_user_id IN (${ids}))`,
    );
  if (table.resource === 'playlist')
    clauses.push(sql`original.id IN (SELECT playlist_id FROM public.playlist_ownership WHERE user_id IN (${ids}))`);
  if (table.resource === 'job')
    clauses.push(
      sql`original.data->>'runId' IN (SELECT id::text FROM public.background_job_runs WHERE ${sql.join(
        userIds.map(
          (userId) =>
            sql`pg_catalog.jsonb_path_exists(payload, '$.** ? (@ == $subject)'::jsonpath, pg_catalog.jsonb_build_object('subject',${userId}::text))`,
        ),
        sql` OR `,
      )})`,
    );
  if (!clauses.length) throw new ConsolidationError('UNSAFE_PLAN');
  return sql`(${sql.join(clauses, sql` OR `)})`;
}

/** Unknown user-FK tables are included, even when the mutation registry refuses them. */
export async function captureConsolidationGroupState(
  transaction: Pick<ConsolidationTransaction, 'execute'>,
  userIds: readonly string[],
  checkTime: () => void = () => {},
): Promise<ConsolidationGroupState> {
  if (userIds.length < 2 || userIds.length > 1000 || new Set(userIds).size !== userIds.length)
    throw new ConsolidationError('INVALID_EVIDENCE');
  await transaction.execute(
    sql`SELECT pg_catalog.set_config('TimeZone','UTC',true),pg_catalog.set_config('DateStyle','ISO, YMD',true)`,
  );
  const references = await transaction.execute<{
    schema: string;
    table: string;
    column: string;
  }>(sql`SELECT DISTINCT namespace.nspname::text AS schema,relation.relname::text AS table,column_row.attname::text AS column
 FROM pg_catalog.pg_constraint constraint_row JOIN pg_catalog.pg_class relation ON relation.oid=constraint_row.conrelid
 JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
 CROSS JOIN LATERAL ROWS FROM(pg_catalog.unnest(constraint_row.conkey),pg_catalog.unnest(constraint_row.confkey)) pair(attnum,referenced_attnum)
 JOIN pg_catalog.pg_attribute column_row ON column_row.attrelid=constraint_row.conrelid AND column_row.attnum=pair.attnum
 JOIN pg_catalog.pg_attribute target_column ON target_column.attrelid=constraint_row.confrelid AND target_column.attnum=pair.referenced_attnum
 WHERE constraint_row.contype='f' AND constraint_row.confrelid='public.users'::pg_catalog.regclass AND constraint_row.conparentid=0 AND target_column.attname='id'
 ORDER BY 1,2,3 LIMIT 1001`);
  if (references.length > 1000) throw new ConsolidationError('INPUT_LIMIT');
  const selections = new Map<string, TableSelection>();
  for (const reference of references) {
    const key = `${reference.schema}.${reference.table}`;
    const entry = selections.get(key) ?? {
      schema: reference.schema,
      table: reference.table,
      columns: [],
      jsonColumns: [],
    };
    if (!entry.columns.includes(reference.column)) entry.columns.push(reference.column);
    selections.set(key, entry);
  }
  // The canonical users row itself must also be protected from profile/email drift.
  selections.set('public.users', { schema: 'public', table: 'users', columns: ['id'], jsonColumns: [] });
  for (const configured of NON_FK) {
    const key = `${configured.schema}.${configured.table}`;
    const existing = selections.get(key);
    selections.set(key, {
      ...configured,
      columns: [...new Set([...(existing?.columns ?? []), ...configured.columns])],
    });
  }
  const tables: ConsolidationTableState[] = [];
  let totalRows = 0;
  let totalBytes = 0;
  for (const selection of [...selections.values()].sort((left, right) =>
    `${left.schema}.${left.table}`.localeCompare(`${right.schema}.${right.table}`),
  )) {
    checkTime();
    const relationName = `"${selection.schema.replaceAll('"', '""')}"."${selection.table.replaceAll('"', '""')}"`;
    const [presence] = await transaction.execute<{ present: boolean }>(
      sql`SELECT pg_catalog.to_regclass(${relationName}) IS NOT NULL AS present`,
    );
    if (presence?.present !== true) {
      tables.push({
        schema: selection.schema,
        table: selection.table,
        present: false,
        rows: 0,
        bytes: 0,
        schemaFingerprint: consolidationDigest('absent'),
        fingerprint: consolidationDigest('absent'),
      });
      continue;
    }
    const source = sql`${sql.identifier(selection.schema)}.${sql.identifier(selection.table)}`;
    const filter = predicates(selection, userIds);
    const [stats] = await transaction.execute<{
      rows: string;
      bytes: string;
      largest: string;
    }>(sql`SELECT pg_catalog.count(*)::text AS rows,COALESCE(pg_catalog.sum(pg_catalog.octet_length(row_text)),0)::text AS bytes,COALESCE(pg_catalog.max(pg_catalog.octet_length(row_text)),0)::text AS largest
  FROM(SELECT pg_catalog.to_jsonb(original)::text AS row_text FROM ${source} original WHERE ${filter} LIMIT ${LIMIT_ROWS + 1}) bounded`);
    const rows = countOf(stats?.rows);
    const bytes = countOf(stats?.bytes);
    const largest = countOf(stats?.largest);
    totalRows += rows;
    totalBytes += bytes;
    if (rows > LIMIT_ROWS || largest > 65536 || totalRows > LIMIT_ROWS || totalBytes > LIMIT_BYTES)
      throw new ConsolidationError('INPUT_LIMIT');
    const [schemaRow] = await transaction.execute<{
      fingerprint: string;
    }>(sql`SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
   'relation',(SELECT pg_catalog.jsonb_build_array(relkind,relowner,relrowsecurity,relforcerowsecurity,relacl) FROM pg_catalog.pg_class WHERE oid=${relationName}::pg_catalog.regclass),
   'defaults',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(adnum,pg_catalog.pg_get_expr(adbin,adrelid)) ORDER BY adnum) FROM pg_catalog.pg_attrdef WHERE adrelid=${relationName}::pg_catalog.regclass),
   'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(attname,atttypid,atttypmod,attnotnull,attgenerated,attidentity,attacl) ORDER BY attnum) FROM pg_catalog.pg_attribute WHERE attrelid=${relationName}::pg_catalog.regclass AND attnum>0 AND NOT attisdropped),
   'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.pg_get_constraintdef(oid) ORDER BY conname) FROM pg_catalog.pg_constraint WHERE conrelid=${relationName}::pg_catalog.regclass),
   'indexes',(SELECT pg_catalog.jsonb_agg(pg_catalog.pg_get_indexdef(indexrelid) ORDER BY indexrelid::pg_catalog.regclass::text) FROM pg_catalog.pg_index WHERE indrelid=${relationName}::pg_catalog.regclass),
   'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.pg_get_triggerdef(oid),pg_catalog.pg_get_functiondef(tgfoid)) ORDER BY tgname) FROM pg_catalog.pg_trigger WHERE tgrelid=${relationName}::pg_catalog.regclass AND NOT tgisinternal)
  )::text,'UTF8')),'hex') AS fingerprint`);
    const [digest] = await transaction.execute<{
      fingerprint: string;
    }>(sql`SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_text,E'\n' ORDER BY row_text),''),'UTF8')),'hex') AS fingerprint
  FROM(SELECT pg_catalog.to_jsonb(original)::text AS row_text FROM ${source} original WHERE ${filter}) bounded`);
    if (!schemaRow?.fingerprint || !digest?.fingerprint) throw new ConsolidationError('INVALID_EVIDENCE');
    tables.push({
      schema: selection.schema,
      table: selection.table,
      present: true,
      rows,
      bytes,
      schemaFingerprint: schemaRow.fingerprint,
      fingerprint: digest.fingerprint,
    });
  }
  checkTime();
  return { tables, fingerprint: consolidationDigest(JSON.stringify(tables)) };
}
export async function revalidateConsolidationGroupState(
  transaction: ConsolidationTransaction,
  context: ConsolidationContext,
) {
  if (!context.group.referenceState) throw new ConsolidationError('UNSAFE_PLAN');
  const current = await captureConsolidationGroupState(transaction, context.group.memberUserIds);
  if (current.fingerprint !== context.group.referenceState.fingerprint)
    throw new ConsolidationError('INVALID_EVIDENCE');
}
export async function captureAfterConsolidationGroupFingerprint(
  transaction: ConsolidationTransaction,
  context: ConsolidationContext,
) {
  return (await captureConsolidationGroupState(transaction, context.group.memberUserIds)).fingerprint;
}
