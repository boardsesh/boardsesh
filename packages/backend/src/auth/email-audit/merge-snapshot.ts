/** Read-only structural preflight. No result is ownership proof or merge approval. */
import { sql, type SQL } from 'drizzle-orm';
import type postgres from 'postgres';
import { normalizeAccountEmail } from '../normalize-email';
import { ACCOUNT_EMAIL_EVIDENCE_LIMITS, AccountEmailEvidenceError, type CollectedEvidence } from './evidence';
import {
  collectAccountEmailEvidenceWith,
  sqlAccountKey,
  type AccountEmailEvidenceSnapshotOptions,
  type EvidenceTransaction,
} from './evidence-snapshot';

export type MergeCollisionCount = {
  readonly address: string;
  readonly duplicateKeys: number;
  readonly rows: number;
};

export type MergeUniqueIndex = {
  readonly schema: string;
  readonly table: string;
  readonly index: string;
  readonly analysis: 'counted' | 'unsupported';
  readonly reason: string | null;
  readonly collisions: readonly MergeCollisionCount[];
};

export type MergeBoardMapping = {
  readonly address: string;
  readonly boardType: string;
  readonly accounts: number;
  readonly distinctUpstreamIdentities: number;
};

export type MergeConflictFacts = {
  readonly uniqueIndexes: readonly MergeUniqueIndex[];
  readonly tickCandidates: readonly MergeCollisionCount[];
  readonly boardMappings: readonly MergeBoardMapping[];
  readonly limitations: readonly string[];
};

type IndexCatalogRow = {
  schema: string;
  table: string;
  index: string;
  columns: (string | null)[];
  userColumns: string[];
  supported: boolean;
  nullsNotDistinct: boolean;
};

/**
 * The least ID is an internal equivalence-class symbol, never a proposed keeper.
 * Using an existing member ID also prevents collisions with unrelated real IDs.
 * No ID or email is sent as a parameter or returned in conflict facts.
 */
const MEMBER_MAP = sql`members AS (
  SELECT member.id, ${sqlAccountKey(sql`member.email`)} AS address,
    pg_catalog.min(member.id) OVER (PARTITION BY ${sqlAccountKey(sql`member.email`)}) AS canonical
  FROM public.users AS member
  WHERE ${sqlAccountKey(sql`member.email`)} IN (
    SELECT ${sqlAccountKey(sql`shared.email`)} FROM public.users AS shared GROUP BY 1 HAVING pg_catalog.count(*) > 1))`;

function safeCount(total: unknown): number {
  const parsed = typeof total === 'string' ? Number(total) : total;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new AccountEmailEvidenceError('INVALID_ROW');
  return parsed;
}

function checkedCollisions(
  rows: readonly MergeCollisionCount[],
  addresses: ReadonlySet<string>,
): MergeCollisionCount[] {
  if (rows.length > ACCOUNT_EMAIL_EVIDENCE_LIMITS.maxMembers) throw new AccountEmailEvidenceError('INPUT_LIMIT');
  const seen = new Set<string>();
  return rows.map((row) => {
    if (!addresses.has(row.address) || seen.has(row.address)) throw new AccountEmailEvidenceError('GROUPING_MISMATCH');
    seen.add(row.address);
    return { address: row.address, duplicateKeys: safeCount(row.duplicateKeys), rows: safeCount(row.rows) };
  });
}

/**
 * Counts duplicate projected keys without fetching key values. All user-FK
 * columns in a table are projected simultaneously, including non-key columns
 * and rows with an unrelated user in another endpoint. INCLUDE columns do not
 * participate in uniqueness. NULL handling follows indnullsnotdistinct.
 */
export function mergeIndexCollisionQuery(
  index: Pick<IndexCatalogRow, 'schema' | 'table' | 'columns' | 'userColumns' | 'nullsNotDistinct'>,
): SQL {
  const keys = index.columns.map((column, position) => {
    if (column === null) throw new AccountEmailEvidenceError('CATALOG_MISMATCH');
    const source = sql`source.${sql.identifier(column)}`;
    const userPosition = index.userColumns.indexOf(column);
    return {
      original: source,
      projected:
        userPosition < 0 ? source : sql`COALESCE(${sql.identifier(`member_${userPosition}`)}.canonical, ${source})`,
      alias: sql.identifier(`key_${position}`),
    };
  });
  const joins = index.userColumns.map(
    (column, position) => sql`LEFT JOIN members AS ${sql.identifier(`member_${position}`)}
    ON ${sql.identifier(`member_${position}`)}.id = source.${sql.identifier(column)}`,
  );
  const groupAddresses = index.userColumns.flatMap((column, position) =>
    index.columns.includes(column) ? [sql`${sql.identifier(`member_${position}`)}.address`] : [],
  );
  const affected = sql.join(
    groupAddresses.map((address) => sql`${address} IS NOT NULL`),
    sql` OR `,
  );
  const notNullKeys = sql.join(
    keys.map((key) => sql`${key.original} IS NOT NULL`),
    sql` AND `,
  );
  return sql`WITH ${MEMBER_MAP}, projected AS (
    SELECT ${sql.join(
      keys.map((key) => sql`${key.projected} AS ${key.alias}`),
      sql`, `,
    )},
      ARRAY[${sql.join(groupAddresses, sql`, `)}]::text[] AS affected
    FROM ${sql.identifier(index.schema)}.${sql.identifier(index.table)} AS source
    ${sql.join(joins, sql` `)}
    WHERE (${affected}) ${index.nullsNotDistinct ? sql`` : sql`AND ${notNullKeys}`}
  ), duplicate_keys AS (
    SELECT ${sql.join(
      keys.map((key) => key.alias),
      sql`, `,
    )}, pg_catalog.count(*) AS total,
      pg_catalog.array_agg(affected) AS affected
    FROM projected GROUP BY ${sql.join(
      keys.map((key) => key.alias),
      sql`, `,
    )} HAVING pg_catalog.count(*) > 1
  ) SELECT address, pg_catalog.count(*)::text AS "duplicateKeys", pg_catalog.sum(total)::text AS rows
    FROM duplicate_keys CROSS JOIN LATERAL (
      SELECT DISTINCT address FROM pg_catalog.unnest(duplicate_keys.affected) AS address WHERE address IS NOT NULL
    ) AS groups
    GROUP BY address ORDER BY address LIMIT ${ACCOUNT_EMAIL_EVIDENCE_LIMITS.maxMembers + 1}`;
}

async function collectMergeConflicts(
  transaction: EvidenceTransaction,
  evidence: CollectedEvidence,
  checkTime: () => void,
): Promise<MergeConflictFacts> {
  let retainedRows = 0;
  let retainedBytes = 0;
  const retain = (record: unknown, rows: number) => {
    retainedRows += rows;
    retainedBytes += Buffer.byteLength(JSON.stringify(record));
    if (retainedRows > 10000 || retainedBytes > ACCOUNT_EMAIL_EVIDENCE_LIMITS.maxWorksheetBytes)
      throw new AccountEmailEvidenceError('INPUT_LIMIT');
  };
  const addresses = new Set<string>();
  const counts = new Map<string, number>();
  for (const user of evidence.users) {
    const address = normalizeAccountEmail(user.email);
    counts.set(address, (counts.get(address) ?? 0) + 1);
  }
  for (const [address, total] of counts) if (total > 1) addresses.add(address);
  const catalog = await transaction.execute<IndexCatalogRow>(sql`WITH user_columns AS (
    SELECT constraint_row.conrelid AS relation,
      pg_catalog.array_agg(DISTINCT column_row.attname::text ORDER BY column_row.attname::text) AS columns
    FROM pg_catalog.pg_constraint AS constraint_row
    CROSS JOIN LATERAL ROWS FROM (pg_catalog.unnest(constraint_row.conkey), pg_catalog.unnest(constraint_row.confkey)) AS pair(attnum, referenced_attnum)
    JOIN pg_catalog.pg_attribute AS column_row ON column_row.attrelid = constraint_row.conrelid AND column_row.attnum = pair.attnum
    JOIN pg_catalog.pg_attribute AS target_column ON target_column.attrelid = constraint_row.confrelid AND target_column.attnum = pair.referenced_attnum
    WHERE constraint_row.contype = 'f' AND constraint_row.confrelid = 'public.users'::pg_catalog.regclass
      AND constraint_row.conparentid = 0 AND target_column.attname = 'id'
    GROUP BY constraint_row.conrelid
  ) SELECT namespace.nspname::text AS "schema", relation.relname::text AS "table", index_relation.relname::text AS "index",
    pg_catalog.jsonb_agg(key_column.attname::text ORDER BY key.position) AS columns,
    pg_catalog.to_jsonb(user_columns.columns) AS "userColumns", index_row.indnullsnotdistinct AS "nullsNotDistinct",
    (index_row.indisvalid AND index_row.indisready AND index_row.indexprs::text IS NULL AND index_row.indpred::text IS NULL
      AND access_method.amname = 'btree'
      AND pg_catalog.bool_and(operator_class.opcdefault AND key.collation_oid = key_column.attcollation
        AND key.collation_oid IN (0, 'pg_catalog.default'::pg_catalog.regcollation))) AS supported
  FROM pg_catalog.pg_index AS index_row
  JOIN user_columns ON user_columns.relation = index_row.indrelid
  JOIN pg_catalog.pg_class AS relation ON relation.oid = index_row.indrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
  JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_relation.relam
  CROSS JOIN LATERAL ROWS FROM (
    pg_catalog.unnest(index_row.indkey::smallint[]), pg_catalog.unnest(index_row.indclass::oid[]), pg_catalog.unnest(index_row.indcollation::oid[])
  ) WITH ORDINALITY AS key(attnum, operator_class_oid, collation_oid, position)
  LEFT JOIN pg_catalog.pg_attribute AS key_column ON key_column.attrelid = index_row.indrelid AND key_column.attnum = key.attnum
  LEFT JOIN pg_catalog.pg_opclass AS operator_class ON operator_class.oid = key.operator_class_oid
  WHERE index_row.indisunique AND key.position <= index_row.indnkeyatts
  GROUP BY namespace.nspname, relation.relname, index_relation.relname, user_columns.columns,
    index_row.indnullsnotdistinct, index_row.indisvalid, index_row.indisready, index_row.indexprs::text,
    index_row.indpred::text, access_method.amname
  HAVING pg_catalog.bool_or(key_column.attname::text = ANY(user_columns.columns)) OR index_row.indexprs::text IS NOT NULL OR index_row.indpred::text IS NOT NULL
  ORDER BY 1, 2, 3 LIMIT ${ACCOUNT_EMAIL_EVIDENCE_LIMITS.maxReferencingColumns + 1}`);
  if (catalog.length > ACCOUNT_EMAIL_EVIDENCE_LIMITS.maxReferencingColumns)
    throw new AccountEmailEvidenceError('INPUT_LIMIT');
  checkTime();
  const uniqueIndexes: MergeUniqueIndex[] = [];
  for (const index of catalog) {
    const identifier = (name: unknown): name is string =>
      typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 256;
    if (
      !identifier(index.schema) ||
      !identifier(index.table) ||
      !identifier(index.index) ||
      !Array.isArray(index.columns) ||
      index.columns.length < 1 ||
      index.columns.length > 1000 ||
      !index.columns.every((column) => column === null || identifier(column)) ||
      !Array.isArray(index.userColumns) ||
      index.userColumns.length < 1 ||
      index.userColumns.length > 1000 ||
      !index.userColumns.every(identifier) ||
      typeof index.nullsNotDistinct !== 'boolean' ||
      (typeof index.supported !== 'boolean' && index.supported !== null)
    )
      throw new AccountEmailEvidenceError('CATALOG_MISMATCH');
    const hasSensitiveKey = index.columns.some(
      (column) => column !== null && /password|token|secret|nonce|providerAccountId/i.test(column),
    );
    const supported = !hasSensitiveKey && index.supported === true && index.columns.every((column) => column !== null);
    const collisions = supported
      ? checkedCollisions(await transaction.execute<MergeCollisionCount>(mergeIndexCollisionQuery(index)), addresses)
      : [];
    retain(index, 1);
    retain(collisions, collisions.length);
    uniqueIndexes.push({
      schema: index.schema,
      table: index.table,
      index: index.index,
      analysis: supported ? 'counted' : 'unsupported',
      reason: supported
        ? null
        : hasSensitiveKey
          ? 'Sensitive index keys are not read by this preflight.'
          : 'Expression, partial, custom operator/collation, invalid or unsupported index requires manual analysis.',
      collisions,
    });
    checkTime();
  }
  const tickCandidates = checkedCollisions(
    await transaction.execute<MergeCollisionCount>(sql`WITH ${MEMBER_MAP}, candidates AS (
    SELECT members.address, pg_catalog.count(*) AS total
    FROM public.boardsesh_ticks AS tick JOIN members ON members.id = tick.user_id
    GROUP BY members.address, tick.board_type, tick.climb_uuid, tick.angle, tick.climbed_at
    HAVING pg_catalog.count(DISTINCT tick.user_id) > 1
  ) SELECT address, pg_catalog.count(*)::text AS "duplicateKeys", pg_catalog.sum(total)::text AS rows
    FROM candidates GROUP BY address ORDER BY address LIMIT ${ACCOUNT_EMAIL_EVIDENCE_LIMITS.maxMembers + 1}`),
    addresses,
  );
  retain(tickCandidates, tickCandidates.length);
  checkTime();
  const mappingRows = await transaction.execute<MergeBoardMapping>(sql`WITH ${MEMBER_MAP}
    SELECT members.address, CASE WHEN pg_catalog.octet_length(mapping.board_type) <= 4096 THEN mapping.board_type END AS "boardType", pg_catalog.count(*)::text AS accounts,
      pg_catalog.count(DISTINCT pg_catalog.jsonb_build_array(mapping.board_user_id, mapping.board_user_id_text))::text AS "distinctUpstreamIdentities"
    FROM public.user_board_mappings AS mapping JOIN members ON members.id = mapping.user_id
    GROUP BY members.address, mapping.board_type HAVING pg_catalog.count(*) > 1
    ORDER BY 1, 2 LIMIT ${ACCOUNT_EMAIL_EVIDENCE_LIMITS.maxMembers + 1}`);
  if (mappingRows.length > ACCOUNT_EMAIL_EVIDENCE_LIMITS.maxMembers) throw new AccountEmailEvidenceError('INPUT_LIMIT');
  const boardMappings = mappingRows.map((row) => {
    if (
      !addresses.has(row.address) ||
      typeof row.boardType !== 'string' ||
      row.boardType.length > ACCOUNT_EMAIL_EVIDENCE_LIMITS.maxFieldBytes
    )
      throw new AccountEmailEvidenceError('INVALID_ROW');
    return {
      address: row.address,
      boardType: row.boardType,
      accounts: safeCount(row.accounts),
      distinctUpstreamIdentities: safeCount(row.distinctUpstreamIdentities),
    };
  });
  retain(boardMappings, boardMappings.length);
  checkTime();
  return {
    uniqueIndexes,
    tickCandidates,
    boardMappings,
    limitations: [
      'No ownership proof, surviving-account selection or approved identity mapping is inferred.',
      'Check constraints, exclusion constraints, triggers and references without foreign keys require separate analysis.',
      'Tick candidates share board, climb, angle and climbed-at timestamp across accounts; they are not proven duplicates.',
      'Passwords, provider links, privacy, permissions, device outboxes, sync cursors and derived data need explicit merge policies.',
    ],
  };
}

export async function collectAccountEmailMergePreview(
  client: postgres.Sql,
  options: AccountEmailEvidenceSnapshotOptions,
): Promise<{ evidence: CollectedEvidence; conflicts: MergeConflictFacts }> {
  const { evidence, extra } = await collectAccountEmailEvidenceWith(client, options, collectMergeConflicts);
  return { evidence, conflicts: extra };
}
