/// <reference types="node" />

/**
 * Narrow, opt-in compatibility preparation for the real-PostgreSQL #3950 CI gate.
 *
 * The development image deliberately represents the production-shaped database,
 * including a historical gap in the Drizzle ledger.  Running migrations here
 * would therefore give CI a different failure mode from production.  This script
 * only supplies the four backwards-compatible playlist fields that the two
 * arbitration specifications need.  It never applies a migration or changes the
 * migration ledger.
 */

import { fileURLToPath } from 'node:url';

import postgres, { type TransactionSql } from 'postgres';

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export type PlaylistColumnDefinition = {
  readonly columnName: string;
  readonly dataType: string;
  readonly underlyingTypeSchema: string;
  readonly underlyingTypeName: string;
  readonly formattedType: string;
  readonly nullable: boolean;
};

export type PlaylistIndexDefinition = {
  readonly indexName: string;
  readonly relationSchema: string | null;
  readonly relationName: string | null;
  readonly relationKind: string | null;
  readonly accessMethod: string | null;
  readonly unique: boolean | null;
  readonly ready: boolean | null;
  readonly valid: boolean | null;
  readonly nullsNotDistinct: boolean | null;
  readonly predicate: string | null;
  readonly expressions: string | null;
  readonly keyColumnCount: number | null;
  readonly attributeCount: number | null;
  readonly keyColumns: readonly string[];
  readonly keyOpclasses: readonly string[];
  readonly keyCollations: readonly string[];
  readonly keyOptions: readonly number[];
};

export type LedgerSnapshot = {
  readonly row_count: string;
  readonly ordered_rows: string;
};

type ColumnRow = {
  readonly column_name: string;
  readonly data_type: string;
  readonly udt_schema: string;
  readonly udt_name: string;
  readonly formatted_type: string;
  readonly is_nullable: 'YES' | 'NO';
};

const REQUIRED_COLUMNS: readonly PlaylistColumnDefinition[] = [
  {
    columnName: 'kilter_type',
    dataType: 'text',
    underlyingTypeSchema: 'pg_catalog',
    underlyingTypeName: 'text',
    formattedType: 'text',
    nullable: true,
  },
  {
    columnName: 'kilter_id',
    dataType: 'text',
    underlyingTypeSchema: 'pg_catalog',
    underlyingTypeName: 'text',
    formattedType: 'text',
    nullable: true,
  },
  {
    columnName: 'kilter_synced_at',
    dataType: 'timestamp without time zone',
    underlyingTypeSchema: 'pg_catalog',
    underlyingTypeName: 'timestamp',
    formattedType: 'timestamp without time zone',
    nullable: true,
  },
  {
    columnName: 'generated_recommendation',
    dataType: 'text',
    underlyingTypeSchema: 'pg_catalog',
    underlyingTypeName: 'text',
    formattedType: 'text',
    nullable: true,
  },
];

const REQUIRED_INDEXES = [
  { indexName: 'playlists_kilter_id_idx', columnName: 'kilter_id' },
  { indexName: 'playlists_generated_recommendation_idx', columnName: 'generated_recommendation' },
] as const;

export function requireLocalDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for Aurora circuit integration preparation.');

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol.');
  }
  if (!LOCAL_DATABASE_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    throw new Error('Refusing Aurora circuit integration preparation against a non-local DATABASE_URL.');
  }
  return databaseUrl;
}

export function requireCompatibilityOptIn(environment: NodeJS.ProcessEnv): void {
  if (environment.ALLOW_AURORA_CIRCUIT_SCHEMA_COMPAT !== '1') {
    throw new Error('Set ALLOW_AURORA_CIRCUIT_SCHEMA_COMPAT=1 to allow the local CI schema compatibility gate.');
  }
}

export function columnMatchesCanonical(
  actualColumn: PlaylistColumnDefinition,
  expectedColumn: PlaylistColumnDefinition,
): boolean {
  return (
    actualColumn.columnName === expectedColumn.columnName &&
    actualColumn.dataType === expectedColumn.dataType &&
    actualColumn.underlyingTypeSchema === expectedColumn.underlyingTypeSchema &&
    actualColumn.underlyingTypeName === expectedColumn.underlyingTypeName &&
    actualColumn.formattedType === expectedColumn.formattedType &&
    actualColumn.nullable === expectedColumn.nullable
  );
}

export function indexMatchesCanonical(
  actualIndex: PlaylistIndexDefinition,
  expectedIndex: (typeof REQUIRED_INDEXES)[number],
): boolean {
  return (
    actualIndex.indexName === expectedIndex.indexName &&
    actualIndex.relationSchema === 'public' &&
    actualIndex.relationName === 'playlists' &&
    actualIndex.relationKind === 'i' &&
    actualIndex.accessMethod === 'btree' &&
    actualIndex.unique === true &&
    actualIndex.ready === true &&
    actualIndex.valid === true &&
    actualIndex.nullsNotDistinct === false &&
    actualIndex.predicate === null &&
    actualIndex.expressions === null &&
    actualIndex.keyColumnCount === 1 &&
    actualIndex.attributeCount === 1 &&
    actualIndex.keyColumns.length === 1 &&
    actualIndex.keyColumns[0] === expectedIndex.columnName &&
    actualIndex.keyOpclasses.length === 1 &&
    actualIndex.keyOpclasses[0] === 'pg_catalog.text_ops' &&
    actualIndex.keyCollations.length === 1 &&
    actualIndex.keyCollations[0] === 'pg_catalog.default' &&
    actualIndex.keyOptions.length === 1 &&
    actualIndex.keyOptions[0] === 0
  );
}

export function ledgerSnapshotsMatch(before: LedgerSnapshot, after: LedgerSnapshot): boolean {
  return before.row_count === after.row_count && before.ordered_rows === after.ordered_rows;
}

function expectedColumnByName(columnName: string): PlaylistColumnDefinition {
  const expectedColumn = REQUIRED_COLUMNS.find((column) => column.columnName === columnName);
  if (!expectedColumn) throw new Error(`No canonical definition exists for playlists.${columnName}.`);
  return expectedColumn;
}

function toPlaylistColumnDefinition(column: ColumnRow): PlaylistColumnDefinition {
  return {
    columnName: column.column_name,
    dataType: column.data_type,
    underlyingTypeSchema: column.udt_schema,
    underlyingTypeName: column.udt_name,
    formattedType: column.formatted_type,
    nullable: column.is_nullable === 'YES',
  };
}

function assertCanonicalColumn(column: PlaylistColumnDefinition): void {
  const expectedColumn = expectedColumnByName(column.columnName);
  if (!columnMatchesCanonical(column, expectedColumn)) {
    throw new Error(
      `playlists.${column.columnName} is ${column.formattedType} ${column.nullable ? 'NULL' : 'NOT NULL'}; expected ` +
        `${expectedColumn.formattedType} ${expectedColumn.nullable ? 'NULL' : 'NOT NULL'}.`,
    );
  }
}

function assertCanonicalIndex(index: PlaylistIndexDefinition, expectedIndex: (typeof REQUIRED_INDEXES)[number]): void {
  if (!indexMatchesCanonical(index, expectedIndex)) {
    throw new Error(
      `${expectedIndex.indexName} exists but is not the required unique public.playlists(${expectedIndex.columnName}) index.`,
    );
  }
}

async function snapshotLedger(transaction: TransactionSql): Promise<LedgerSnapshot> {
  const [ledger] = await transaction<LedgerSnapshot[]>`
    SELECT
      count(*)::text AS row_count,
      COALESCE(
        jsonb_agg(to_jsonb(migration_row) ORDER BY migration_row.id),
        '[]'::jsonb
      )::text AS ordered_rows
    FROM drizzle."__drizzle_migrations" AS migration_row
  `;
  if (!ledger) throw new Error('Could not snapshot drizzle.__drizzle_migrations.');
  return ledger;
}

async function readPlaylistColumns(transaction: TransactionSql): Promise<Map<string, PlaylistColumnDefinition>> {
  const columns = await transaction<ColumnRow[]>`
    SELECT
      columns.column_name,
      columns.data_type,
      columns.udt_schema,
      columns.udt_name,
      format_type(attribute.atttypid, attribute.atttypmod) AS formatted_type,
      columns.is_nullable
    FROM information_schema.columns AS columns
    JOIN pg_catalog.pg_namespace AS table_namespace
      ON table_namespace.nspname = columns.table_schema
    JOIN pg_catalog.pg_class AS table_class
      ON table_class.relnamespace = table_namespace.oid
      AND table_class.relname = columns.table_name
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = table_class.oid
      AND attribute.attname = columns.column_name
      AND NOT attribute.attisdropped
    WHERE columns.table_schema = 'public'
      AND columns.table_name = 'playlists'
      AND columns.column_name IN ('kilter_type', 'kilter_id', 'kilter_synced_at', 'generated_recommendation')
  `;
  return new Map(columns.map((column) => [column.column_name, toPlaylistColumnDefinition(column)]));
}

async function readNamedIndex(transaction: TransactionSql, indexName: string): Promise<PlaylistIndexDefinition | null> {
  const indexes = await transaction<PlaylistIndexDefinition[]>`
    SELECT
      index_class.relname AS "indexName",
      index_namespace.nspname AS "relationSchema",
      table_class.relname AS "relationName",
      index_class.relkind::text AS "relationKind",
      access_method.amname AS "accessMethod",
      index_data.indisunique AS unique,
      index_data.indisready AS ready,
      index_data.indisvalid AS valid,
      index_data.indnullsnotdistinct AS "nullsNotDistinct",
      pg_get_expr(index_data.indpred, index_data.indrelid) AS predicate,
      pg_get_expr(index_data.indexprs, index_data.indrelid) AS expressions,
      index_data.indnkeyatts::int AS "keyColumnCount",
      index_data.indnatts::int AS "attributeCount",
      COALESCE(
        array_agg(attribute.attname ORDER BY index_key.ordinality)
          FILTER (WHERE index_key.ordinality <= index_data.indnkeyatts),
        '{}'::text[]
      ) AS "keyColumns",
      COALESCE(
        array_agg(opclass_namespace.nspname || '.' || opclass.opcname ORDER BY index_key.ordinality)
          FILTER (WHERE index_key.ordinality <= index_data.indnkeyatts),
        '{}'::text[]
      ) AS "keyOpclasses",
      COALESCE(
        array_agg(collation_namespace.nspname || '.' || collation.collname ORDER BY index_key.ordinality)
          FILTER (WHERE index_key.ordinality <= index_data.indnkeyatts),
        '{}'::text[]
      ) AS "keyCollations",
      COALESCE(
        array_agg(index_data.indoption[index_key.ordinality::int - 1]::int ORDER BY index_key.ordinality)
          FILTER (WHERE index_key.ordinality <= index_data.indnkeyatts),
        '{}'::int[]
      ) AS "keyOptions"
    FROM pg_class AS index_class
    JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
    JOIN pg_am AS access_method ON access_method.oid = index_class.relam
    LEFT JOIN pg_index AS index_data ON index_data.indexrelid = index_class.oid
    LEFT JOIN pg_class AS table_class ON table_class.oid = index_data.indrelid
    LEFT JOIN LATERAL unnest(index_data.indkey::smallint[]) WITH ORDINALITY AS index_key(attnum, ordinality) ON true
    LEFT JOIN pg_attribute AS attribute
      ON attribute.attrelid = index_data.indrelid
      AND attribute.attnum = index_key.attnum
    LEFT JOIN pg_opclass AS opclass ON opclass.oid = index_data.indclass[index_key.ordinality::int - 1]
    LEFT JOIN pg_namespace AS opclass_namespace ON opclass_namespace.oid = opclass.opcnamespace
    LEFT JOIN pg_collation AS collation ON collation.oid = index_data.indcollation[index_key.ordinality::int - 1]
    LEFT JOIN pg_namespace AS collation_namespace ON collation_namespace.oid = collation.collnamespace
    WHERE index_namespace.nspname = 'public'
      AND index_class.relname = ${indexName}
    GROUP BY
      index_class.relname,
      index_namespace.nspname,
      table_class.relname,
      index_class.relkind,
      access_method.amname,
      index_data.indisunique,
      index_data.indisready,
      index_data.indisvalid,
      index_data.indnullsnotdistinct,
      index_data.indpred,
      index_data.indexprs,
      index_data.indnkeyatts,
      index_data.indnatts
  `;
  if (indexes.length > 1) throw new Error(`Found more than one public relation named ${indexName}.`);
  return indexes[0] ?? null;
}

async function ensurePlaylistExists(transaction: TransactionSql): Promise<void> {
  await transaction.unsafe('LOCK TABLE public.playlists IN ACCESS EXCLUSIVE MODE');
}

async function addMissingColumn(transaction: TransactionSql, column: PlaylistColumnDefinition): Promise<void> {
  const statements: Record<string, string> = {
    kilter_type: 'ALTER TABLE public.playlists ADD COLUMN kilter_type text',
    kilter_id: 'ALTER TABLE public.playlists ADD COLUMN kilter_id text',
    kilter_synced_at: 'ALTER TABLE public.playlists ADD COLUMN kilter_synced_at timestamp without time zone',
    generated_recommendation: 'ALTER TABLE public.playlists ADD COLUMN generated_recommendation text',
  };
  await transaction.unsafe(statements[column.columnName] ?? 'SELECT 1/0');
}

async function createCanonicalIndex(
  transaction: TransactionSql,
  index: (typeof REQUIRED_INDEXES)[number],
): Promise<void> {
  const statements: Record<(typeof REQUIRED_INDEXES)[number]['indexName'], string> = {
    playlists_kilter_id_idx: 'CREATE UNIQUE INDEX playlists_kilter_id_idx ON public.playlists USING btree (kilter_id)',
    playlists_generated_recommendation_idx:
      'CREATE UNIQUE INDEX playlists_generated_recommendation_idx ON public.playlists USING btree (generated_recommendation)',
  };
  await transaction.unsafe(statements[index.indexName]);
}

export async function prepareAuroraCircuitIntegrationDatabase(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    await client.begin(async (transaction) => {
      await ensurePlaylistExists(transaction);
      const ledgerBefore = await snapshotLedger(transaction);
      const columnsBefore = await readPlaylistColumns(transaction);

      for (const requiredColumn of REQUIRED_COLUMNS) {
        const existingColumn = columnsBefore.get(requiredColumn.columnName);
        if (existingColumn) assertCanonicalColumn(existingColumn);
      }
      for (const requiredColumn of REQUIRED_COLUMNS) {
        if (!columnsBefore.has(requiredColumn.columnName)) await addMissingColumn(transaction, requiredColumn);
      }

      const columnsAfter = await readPlaylistColumns(transaction);
      for (const requiredColumn of REQUIRED_COLUMNS) {
        const actualColumn = columnsAfter.get(requiredColumn.columnName);
        if (!actualColumn) throw new Error(`playlists.${requiredColumn.columnName} was not created.`);
        assertCanonicalColumn(actualColumn);
      }

      for (const requiredIndex of REQUIRED_INDEXES) {
        const existingIndex = await readNamedIndex(transaction, requiredIndex.indexName);
        if (existingIndex) {
          assertCanonicalIndex(existingIndex, requiredIndex);
        } else {
          await createCanonicalIndex(transaction, requiredIndex);
        }
      }
      for (const requiredIndex of REQUIRED_INDEXES) {
        const actualIndex = await readNamedIndex(transaction, requiredIndex.indexName);
        if (!actualIndex) throw new Error(`${requiredIndex.indexName} was not created.`);
        assertCanonicalIndex(actualIndex, requiredIndex);
      }

      const ledgerAfter = await snapshotLedger(transaction);
      if (!ledgerSnapshotsMatch(ledgerBefore, ledgerAfter)) {
        throw new Error('Aurora circuit schema preparation must not change the Drizzle migration ledger.');
      }
    });
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  requireCompatibilityOptIn(process.env);
  const databaseUrl = requireLocalDatabaseUrl(process.env.DATABASE_URL);
  await prepareAuroraCircuitIntegrationDatabase(databaseUrl);
  console.info('[aurora-circuit-schema-compat] playlist compatibility verified without applying migrations.');
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
