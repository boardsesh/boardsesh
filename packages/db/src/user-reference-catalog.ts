import { createHash } from 'node:crypto';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';

export type ReferentialAction = 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';

/** A semantic FK contract. Physical OIDs and generated trigger names are separate evidence. */
export interface UserReference {
  schema: string;
  table: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: ReferentialAction;
  onDelete: ReferentialAction;
  match: 'simple' | 'full' | 'partial';
  validated: boolean;
  deferrable: boolean;
  initiallyDeferred: boolean;
  deleteSetColumns: string[] | null;
}

export interface PhysicalUserReference extends UserReference {
  oid: number;
  name: string;
  parentConstraint: string | null;
  definition: string;
}

export interface ReferenceDifference {
  kind: 'missing' | 'unexpected' | 'different';
  identity: string;
  expected: UserReference | null;
  observed: UserReference | null;
}

export interface CatalogTrigger {
  identity: string;
  schema: string;
  table: string;
  name: string;
  internal: boolean;
  enabled: string;
  type: number;
  deferrable: boolean;
  initiallyDeferred: boolean;
  constraint: string | null;
  functionIdentity: string;
  functionDefinitionHash: string;
  arguments: string;
  definition: string;
}

export interface CatalogRoutine {
  identity: string;
  kind: string;
  owner: string;
  language: string;
  securityDefiner: boolean;
  volatility: string;
  strict: boolean;
  parallel: string;
  configuration: string[];
  acl: string[];
  definition: string;
  extension: string | null;
}

export interface CatalogDependency {
  objectType: string;
  objectSchema: string | null;
  objectIdentity: string;
  referencedType: string;
  referencedSchema: string | null;
  referencedIdentity: string;
  kind: string;
}

export interface CatalogRelation {
  schema: string;
  table: string;
  kind: string;
  owner: string;
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  partitionKey: string | null;
  parents: string[];
}

/** The connection the caller claims. The collector rejects a claim the server does not confirm. */
export type CatalogTransport = 'unix-socket' | 'tcp';

/**
 * What the server reported about this connection. The owned fixture is a primary
 * reached over a Unix socket; a TCP run may be a primary or a standby, and a
 * restricted role may be unable to read the cluster's system identifier.
 */
export type CatalogConnectionEvidence =
  | { transport: 'unix-socket'; recovery: false; clientAddress: null; systemIdentifier: string }
  | { transport: 'tcp'; recovery: boolean; clientAddress: string; systemIdentifier: string | null };

export interface UserReferenceCatalog {
  version: 1;
  physical: {
    database: string;
    databaseOid: number;
    usersOid: number;
    serverVersion: number;
  } & CatalogConnectionEvidence;
  snapshot: {
    isolation: 'repeatable read';
    readOnly: 'on';
    rowSecurity: 'off';
  };
  references: PhysicalUserReference[];
  triggers: CatalogTrigger[];
  routines: CatalogRoutine[];
  eventTriggers: {
    name: string;
    owner: string;
    event: string;
    enabled: string;
    functionIdentity: string;
    tags: string[];
  }[];
  dependencies: CatalogDependency[];
  relations: CatalogRelation[];
  extensions: { name: string; version: string; schema: string; owner: string }[];
  extensionRoutineCounts: { extension: string; count: number }[];
  policies: { schema: string; table: string; name: string; definition: string }[];
  defaultPrivileges: { owner: string; schema: string | null; type: string; acl: string[] }[];
  ledgers: {
    public: { hash: string; createdAt: string }[];
    drizzle: { hash: string; createdAt: string }[];
  };
}

/** Kept outside Drizzle because generated migrations previously dropped this manual FK. */
export const MANUAL_USER_REFERENCES: readonly UserReference[] = [
  {
    schema: 'public',
    table: 'board_beta_links',
    columns: ['created_by_user_id'],
    referencedSchema: 'public',
    referencedTable: 'users',
    referencedColumns: ['id'],
    onUpdate: 'no action',
    onDelete: 'set null',
    match: 'simple',
    validated: true,
    deferrable: false,
    initiallyDeferred: false,
    deleteSetColumns: null,
  },
];

/** 0041 creates an inline FK; 0052 retains it and adds the separately named canonical FK. */
const LEGACY_DUPLICATE_USER_REFERENCES: readonly UserReference[] = [
  {
    schema: 'public',
    table: 'esp32_controllers',
    columns: ['user_id'],
    referencedSchema: 'public',
    referencedTable: 'users',
    referencedColumns: ['id'],
    onUpdate: 'no action',
    onDelete: 'cascade',
    match: 'simple',
    validated: true,
    deferrable: false,
    initiallyDeferred: false,
    deleteSetColumns: null,
  },
];

export function readExpectedUserReferences(schemaExports: Record<string, unknown>): UserReference[] {
  const references: UserReference[] = [];
  const visitedTables = new Set<PgTable>();
  for (const exported of Object.values(schemaExports)) {
    if (!is(exported, PgTable) || visitedTables.has(exported)) continue;
    visitedTables.add(exported);
    const table = getTableConfig(exported);
    for (const foreignKey of table.foreignKeys) {
      const reference = foreignKey.reference();
      const referencedTable = getTableConfig(reference.foreignTable);
      if (referencedTable.name !== 'users' || (referencedTable.schema ?? 'public') !== 'public') continue;
      references.push({
        schema: table.schema ?? 'public',
        table: table.name,
        columns: reference.columns.map((column) => column.name),
        referencedSchema: referencedTable.schema ?? 'public',
        referencedTable: referencedTable.name,
        referencedColumns: reference.foreignColumns.map((column) => column.name),
        onUpdate: foreignKey.onUpdate ?? 'no action',
        onDelete: foreignKey.onDelete ?? 'no action',
        match: 'simple',
        validated: true,
        deferrable: false,
        initiallyDeferred: false,
        deleteSetColumns: null,
      });
    }
  }
  if (references.length === 0) throw new Error('No canonical user references found');
  // A future canonical declaration replaces the exception, rather than duplicating it.
  for (const manual of MANUAL_USER_REFERENCES) {
    if (!references.some((reference) => referenceIdentity(reference) === referenceIdentity(manual))) {
      references.push({ ...manual, columns: [...manual.columns], referencedColumns: [...manual.referencedColumns] });
    }
  }
  for (const legacy of LEGACY_DUPLICATE_USER_REFERENCES) {
    const canonicalMatches = references.filter(
      (reference) => referenceIdentity(reference) === referenceIdentity(legacy),
    );
    // An absent declaration does not manufacture a supported legacy relation.
    // If a future schema declares both constraints, do not count the artifact again.
    if (canonicalMatches.length === 1) {
      references.push({ ...legacy, columns: [...legacy.columns], referencedColumns: [...legacy.referencedColumns] });
    }
  }
  return references.sort((left, right) => referenceIdentity(left).localeCompare(referenceIdentity(right)));
}

export function referenceIdentity(reference: UserReference): string {
  return JSON.stringify([
    reference.schema,
    reference.table,
    reference.columns,
    reference.referencedSchema,
    reference.referencedTable,
    reference.referencedColumns,
  ]);
}

function semanticReference(reference: UserReference): UserReference {
  return {
    schema: reference.schema,
    table: reference.table,
    columns: reference.columns,
    referencedSchema: reference.referencedSchema,
    referencedTable: reference.referencedTable,
    referencedColumns: reference.referencedColumns,
    onUpdate: reference.onUpdate,
    onDelete: reference.onDelete,
    match: reference.match,
    validated: reference.validated,
    deferrable: reference.deferrable,
    initiallyDeferred: reference.initiallyDeferred,
    deleteSetColumns: reference.deleteSetColumns,
  };
}

/** Multiset comparison: duplicate constraints cannot hide behind one matching identity. */
export function compareUserReferences(
  expected: readonly UserReference[],
  observed: readonly UserReference[],
): ReferenceDifference[] {
  const remaining = observed.map(semanticReference);
  const differences: ReferenceDifference[] = [];
  for (const expectedReference of expected) {
    const identity = referenceIdentity(expectedReference);
    const exact = remaining.findIndex(
      (reference) => JSON.stringify(reference) === JSON.stringify(semanticReference(expectedReference)),
    );
    if (exact !== -1) {
      remaining.splice(exact, 1);
      continue;
    }
    const sameIdentity = remaining.findIndex((reference) => referenceIdentity(reference) === identity);
    const observedReference = sameIdentity === -1 ? null : remaining.splice(sameIdentity, 1)[0];
    differences.push({
      kind: observedReference ? 'different' : 'missing',
      identity,
      expected: semanticReference(expectedReference),
      observed: observedReference,
    });
  }
  for (const observedReference of remaining) {
    differences.push({
      kind: 'unexpected',
      identity: referenceIdentity(observedReference),
      expected: null,
      observed: observedReference,
    });
  }
  return differences;
}

/** Compare fresh fixtures without confusing allocation-dependent OIDs with schema drift. */
export function portableCatalogDigest(catalog: UserReferenceCatalog): string {
  const internalTriggers = new Map(
    catalog.triggers
      .filter((trigger) => trigger.internal)
      .map((trigger) => [
        trigger.identity,
        JSON.stringify([trigger.schema, trigger.table, trigger.constraint, trigger.functionIdentity, trigger.type]),
      ]),
  );
  const replaceTrigger = (type: string, identity: string): string =>
    type === 'trigger' ? (internalTriggers.get(identity) ?? identity) : identity;
  const portable = {
    ...catalog,
    physical: undefined,
    references: catalog.references.map(({ oid: _oid, ...reference }) => reference),
    triggers: catalog.triggers
      .map((trigger) =>
        trigger.internal ? { ...trigger, identity: undefined, name: undefined, definition: undefined } : trigger,
      )
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    // Internal RI names contain allocation OIDs. Preserve their semantic identity in dependencies.
    dependencies: catalog.dependencies
      .map((dependency) => {
        return {
          ...dependency,
          objectIdentity: replaceTrigger(dependency.objectType, dependency.objectIdentity),
          referencedIdentity: replaceTrigger(dependency.referencedType, dependency.referencedIdentity),
        };
      })
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
  return createHash('sha256').update(JSON.stringify(portable)).digest('hex');
}

export interface CatalogLimits {
  maximumRows?: number;
  maximumBytes?: number;
  statementTimeoutMs?: number;
}

const APPLICATION_NAMESPACE = "namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'";

type FieldRule = 'string' | 'number' | 'boolean' | 'strings' | 'nullableString' | 'nullableStrings' | readonly string[];

/** Catalog results are untrusted runtime input, even when the query has a TypeScript annotation. */
export function decodeCatalogRow<Row>(input: unknown, shape: Record<keyof Row, FieldRule>): Row {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Malformed catalog row');
  const record = input as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== Object.keys(shape).length ||
    keys.some((key) => typeof key !== 'string' || !Object.hasOwn(shape, key))
  ) {
    throw new Error('Malformed catalog row');
  }
  for (const [field, rule] of Object.entries(shape) as [string, FieldRule][]) {
    if (!Object.hasOwn(record, field)) throw new Error('Malformed catalog row');
    const fieldContents = record[field];
    const valid = Array.isArray(rule)
      ? rule.includes(fieldContents as string)
      : rule === 'nullableString'
        ? fieldContents === null || typeof fieldContents === 'string'
        : rule === 'nullableStrings' && fieldContents === null
          ? true
          : rule === 'strings' || rule === 'nullableStrings'
            ? Array.isArray(fieldContents) && fieldContents.every((entry) => typeof entry === 'string')
            : rule === 'number'
              ? typeof fieldContents === 'number' && Number.isSafeInteger(fieldContents) && fieldContents >= 0
              : typeof fieldContents === rule;
    if (!valid) throw new Error('Malformed catalog row');
  }
  return record as Row;
}

const REFERENCE_SHAPE: Record<keyof PhysicalUserReference, FieldRule> = {
  oid: 'number',
  name: 'string',
  schema: 'string',
  table: 'string',
  columns: 'strings',
  referencedSchema: 'string',
  referencedTable: 'string',
  referencedColumns: 'strings',
  onUpdate: ['no action', 'restrict', 'cascade', 'set null', 'set default'],
  onDelete: ['no action', 'restrict', 'cascade', 'set null', 'set default'],
  match: ['simple', 'full', 'partial'],
  validated: 'boolean',
  deferrable: 'boolean',
  initiallyDeferred: 'boolean',
  parentConstraint: 'nullableString',
  definition: 'string',
  deleteSetColumns: 'nullableStrings',
};

export interface CatalogServerState {
  database: string;
  databaseOid: number;
  systemIdentifier: string | null;
  usersOid: number | null;
  serverVersion: number;
  recovery: boolean;
  clientAddress: string | null;
  isolation: string;
  readOnly: string;
  rowSecurity: string;
}

/** Both transports require this same read-only snapshot; only the connection evidence differs. */
export function readCatalogPhysical(
  state: CatalogServerState | undefined,
  transport: CatalogTransport,
): UserReferenceCatalog['physical'] {
  if (
    !state ||
    typeof state.database !== 'string' ||
    !state.database ||
    !Number.isSafeInteger(state.databaseOid) ||
    state.databaseOid <= 0 ||
    (state.systemIdentifier !== null &&
      (typeof state.systemIdentifier !== 'string' || !/^\d+$/.test(state.systemIdentifier))) ||
    !Number.isSafeInteger(state.usersOid) ||
    !state.usersOid ||
    state.usersOid <= 0 ||
    !Number.isSafeInteger(state.serverVersion) ||
    state.serverVersion < 180000 ||
    state.isolation !== 'repeatable read' ||
    state.readOnly !== 'on' ||
    state.rowSecurity !== 'off'
  )
    throw new Error('Catalog requires a read-only snapshot with public.users');
  const server = {
    database: state.database,
    databaseOid: state.databaseOid,
    usersOid: state.usersOid,
    serverVersion: state.serverVersion,
  };
  if (transport === 'unix-socket') {
    if (state.recovery !== false || state.clientAddress !== null || state.systemIdentifier === null)
      throw new Error('Catalog requires a primary Unix-socket read-only snapshot with public.users');
    return { ...server, transport, recovery: false, clientAddress: null, systemIdentifier: state.systemIdentifier };
  }
  if (typeof state.recovery !== 'boolean' || typeof state.clientAddress !== 'string' || !state.clientAddress)
    throw new Error('Catalog requires a read-only TCP snapshot with public.users');
  return {
    ...server,
    transport,
    recovery: state.recovery,
    clientAddress: state.clientAddress,
    systemIdentifier: state.systemIdentifier,
  };
}

/**
 * Borrows the caller's client. Only fixed catalog SELECTs and transaction-local settings execute.
 * Defaults to the owned fixture's Unix socket; a read-only TCP run must ask for it explicitly.
 */
export async function collectUserReferenceCatalog(
  client: postgres.Sql,
  limits: CatalogLimits = {},
  transport: CatalogTransport = 'unix-socket',
): Promise<UserReferenceCatalog> {
  const maximumRows = limits.maximumRows ?? 50_000;
  const maximumBytes = limits.maximumBytes ?? 32 * 1024 * 1024;
  const statementTimeoutMs = limits.statementTimeoutMs ?? 10_000;
  for (const [limit, maximum] of [
    [maximumRows, 50_000],
    [maximumBytes, 32 * 1024 * 1024],
    [statementTimeoutMs, 10_000],
  ]) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximum) throw new Error('Invalid catalog limit');
  }
  return client.begin('isolation level repeatable read read only', async (transaction) => {
    await transaction`SELECT pg_catalog.set_config('search_path', 'pg_catalog', true),
      pg_catalog.set_config('row_security', 'off', true),
      pg_catalog.set_config('statement_timeout', ${String(statementTimeoutMs)}, true),
      pg_catalog.set_config('lock_timeout', '1000', true)`;
    const [state] = await transaction<Omit<CatalogServerState, 'systemIdentifier'>[]>`
      SELECT pg_catalog.current_database() AS database,
      (SELECT oid::integer FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()) AS "databaseOid",
      pg_catalog.to_regclass('public.users')::oid::integer AS "usersOid",
      pg_catalog.current_setting('server_version_num')::integer AS "serverVersion",
      pg_catalog.pg_is_in_recovery() AS recovery, pg_catalog.inet_client_addr()::text AS "clientAddress",
      pg_catalog.current_setting('transaction_isolation') AS isolation,
      pg_catalog.current_setting('transaction_read_only') AS "readOnly",
      pg_catalog.current_setting('row_security') AS "rowSecurity"`;
    // pg_control_system is revoked from PUBLIC on the hardened roles. PostgreSQL
    // checks the ACL when it initializes the call, so a CASE cannot guard it: ask first.
    // The owned fixture still fails with insufficient_privilege, as its proof expects.
    const [controlDataAccess] =
      transport === 'tcp'
        ? await transaction<{ readable: boolean }[]>`
            SELECT pg_catalog.has_function_privilege('pg_catalog.pg_control_system()', 'EXECUTE') AS readable`
        : [{ readable: true }];
    const [controlData] = controlDataAccess?.readable
      ? await transaction<{ systemIdentifier: string }[]>`
          SELECT system_identifier::text AS "systemIdentifier" FROM pg_catalog.pg_control_system()`
      : [];
    const physical = readCatalogPhysical(
      state && { ...state, systemIdentifier: controlData?.systemIdentifier ?? null },
      transport,
    );

    let bytes = 0;
    let rowCount = 0;
    const select = async <Row>(statement: string, shape: Record<keyof Row, FieldRule>): Promise<Row[]> => {
      const rows: Row[] = [];
      // A single routine body must never allocate unbounded memory in the driver.
      // The portal fetches at most 16 SQL-capped records before checking cumulative budgets.
      const query = transaction.unsafe<{ payload: string | null }[]>(`
        SELECT CASE WHEN pg_catalog.octet_length(pg_catalog.row_to_json(catalog_row)::text) <= 65536
          THEN pg_catalog.row_to_json(catalog_row)::text ELSE NULL END AS payload
        FROM (${statement} LIMIT ${maximumRows + 1}) AS catalog_row`);
      for await (const batch of query.cursor(16)) {
        for (const row of batch) {
          if (typeof row.payload !== 'string') throw new Error('Catalog row exceeds text budget');
          bytes += Buffer.byteLength(row.payload);
          rowCount += 1;
          if (rowCount > maximumRows || bytes > maximumBytes) throw new Error('Catalog budget exceeded');
          rows.push(decodeCatalogRow<Row>(JSON.parse(row.payload) as unknown, shape));
        }
      }
      return rows;
    };

    const references = await select<PhysicalUserReference>(
      `
      SELECT constraint_row.oid::integer AS oid, constraint_row.conname AS name,
        namespace.nspname AS schema, relation.relname AS table,
        ARRAY(SELECT attribute.attname FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
          ORDER BY key.position) AS columns,
        target_namespace.nspname AS "referencedSchema", target.relname AS "referencedTable",
        ARRAY(SELECT attribute.attname FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = target.oid AND attribute.attnum = key.attnum
          ORDER BY key.position) AS "referencedColumns",
        CASE constraint_row.confupdtype WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict' WHEN 'c' THEN 'cascade'
          WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' END AS "onUpdate",
        CASE constraint_row.confdeltype WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict' WHEN 'c' THEN 'cascade'
          WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' END AS "onDelete",
        CASE constraint_row.confmatchtype WHEN 's' THEN 'simple' WHEN 'f' THEN 'full' WHEN 'p' THEN 'partial' END AS match,
        constraint_row.convalidated AS validated, constraint_row.condeferrable AS deferrable,
        constraint_row.condeferred AS "initiallyDeferred",
        CASE WHEN constraint_row.confdelsetcols IS NULL THEN NULL ELSE
          ARRAY(SELECT attribute.attname FROM unnest(constraint_row.confdelsetcols) WITH ORDINALITY AS key(attnum, position)
            JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
            ORDER BY key.position) END AS "deleteSetColumns",
        CASE WHEN parent.oid IS NULL THEN NULL ELSE parent_namespace.nspname || '.' || parent_relation.relname || '.' || parent.conname END AS "parentConstraint",
        pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS definition
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_class AS target ON target.oid = constraint_row.confrelid
      JOIN pg_catalog.pg_namespace AS target_namespace ON target_namespace.oid = target.relnamespace
      LEFT JOIN pg_catalog.pg_constraint AS parent ON parent.oid = constraint_row.conparentid
      LEFT JOIN pg_catalog.pg_class AS parent_relation ON parent_relation.oid = parent.conrelid
      LEFT JOIN pg_catalog.pg_namespace AS parent_namespace ON parent_namespace.oid = parent_relation.relnamespace
      WHERE constraint_row.contype = 'f' AND constraint_row.confrelid = 'public.users'::pg_catalog.regclass
      ORDER BY namespace.nspname, relation.relname, constraint_row.conname`,
      REFERENCE_SHAPE,
    );
    for (const reference of references) {
      if (
        reference.oid <= 0 ||
        reference.columns.length === 0 ||
        reference.columns.length !== reference.referencedColumns.length ||
        reference.referencedSchema !== 'public' ||
        reference.referencedTable !== 'users'
      ) {
        throw new Error('Malformed catalog reference');
      }
    }

    const triggers = await select<CatalogTrigger>(
      `
      SELECT namespace.nspname AS schema, relation.relname AS table, trigger_row.tgname AS name,
        (SELECT identity FROM pg_catalog.pg_identify_object('pg_catalog.pg_trigger'::pg_catalog.regclass, trigger_row.oid, 0)) AS identity,
        trigger_row.tgisinternal AS internal, trigger_row.tgenabled::text AS enabled,
        trigger_row.tgtype::integer AS type, trigger_row.tgdeferrable AS deferrable,
        trigger_row.tginitdeferred AS "initiallyDeferred",
        CASE WHEN constraint_row.oid IS NULL THEN NULL ELSE constraint_namespace.nspname || '.' || constraint_relation.relname || '.' || constraint_row.conname END AS constraint,
        routine_namespace.nspname || '.' || routine.proname || '(' || pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')' AS "functionIdentity",
        pg_catalog.md5(pg_catalog.pg_get_functiondef(routine.oid)) AS "functionDefinitionHash",
        pg_catalog.encode(trigger_row.tgargs, 'hex') AS arguments,
        pg_catalog.pg_get_triggerdef(trigger_row.oid, true) AS definition
      FROM pg_catalog.pg_trigger AS trigger_row
      JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_proc AS routine ON routine.oid = trigger_row.tgfoid
      JOIN pg_catalog.pg_namespace AS routine_namespace ON routine_namespace.oid = routine.pronamespace
      LEFT JOIN pg_catalog.pg_constraint AS constraint_row ON constraint_row.oid = trigger_row.tgconstraint
      LEFT JOIN pg_catalog.pg_class AS constraint_relation ON constraint_relation.oid = constraint_row.conrelid
      LEFT JOIN pg_catalog.pg_namespace AS constraint_namespace ON constraint_namespace.oid = constraint_relation.relnamespace
      WHERE ${APPLICATION_NAMESPACE}
      ORDER BY namespace.nspname, relation.relname, routine_namespace.nspname, routine.proname,
        constraint_row.conname NULLS FIRST, trigger_row.tgtype, trigger_row.tgname`,
      {
        identity: 'string',
        schema: 'string',
        table: 'string',
        name: 'string',
        internal: 'boolean',
        enabled: ['O', 'D', 'R', 'A'],
        type: 'number',
        deferrable: 'boolean',
        initiallyDeferred: 'boolean',
        constraint: 'nullableString',
        functionIdentity: 'string',
        functionDefinitionHash: 'string',
        arguments: 'string',
        definition: 'string',
      },
    );

    const routines = await select<CatalogRoutine>(
      `
      SELECT namespace.nspname || '.' || routine.proname || '(' || pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')' AS identity,
        routine.prokind::text AS kind, pg_catalog.pg_get_userbyid(routine.proowner) AS owner,
        language.lanname AS language, routine.prosecdef AS "securityDefiner", routine.provolatile::text AS volatility,
        routine.proisstrict AS strict, routine.proparallel::text AS parallel,
        coalesce(routine.proconfig, ARRAY[]::text[]) AS configuration,
        ARRAY(SELECT privilege::text FROM unnest(coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) AS privilege ORDER BY privilege::text) AS acl,
        CASE WHEN routine.prokind <> 'a' THEN pg_catalog.pg_get_functiondef(routine.oid) ELSE
          ((pg_catalog.to_jsonb(aggregate_row) - ARRAY['aggfnoid', 'aggtransfn', 'aggfinalfn', 'aggcombinefn',
            'aggserialfn', 'aggdeserialfn', 'aggmtransfn', 'aggminvtransfn', 'aggmfinalfn', 'aggsortop', 'aggtranstype', 'aggmtranstype'])
          || pg_catalog.jsonb_build_object(
            'arguments', pg_catalog.pg_get_function_arguments(routine.oid),
            'result', pg_catalog.pg_get_function_result(routine.oid),
            'transition', aggregate_row.aggtransfn::pg_catalog.regprocedure::text,
            'final', aggregate_row.aggfinalfn::pg_catalog.regprocedure::text,
            'combine', aggregate_row.aggcombinefn::pg_catalog.regprocedure::text,
            'serialize', aggregate_row.aggserialfn::pg_catalog.regprocedure::text,
            'deserialize', aggregate_row.aggdeserialfn::pg_catalog.regprocedure::text,
            'movingTransition', aggregate_row.aggmtransfn::pg_catalog.regprocedure::text,
            'movingInverse', aggregate_row.aggminvtransfn::pg_catalog.regprocedure::text,
            'movingFinal', aggregate_row.aggmfinalfn::pg_catalog.regprocedure::text,
            'sortOperator', aggregate_row.aggsortop::pg_catalog.regoperator::text,
            'transitionType', pg_catalog.format_type(aggregate_row.aggtranstype, NULL),
            'movingType', pg_catalog.format_type(aggregate_row.aggmtranstype, NULL)))::text END AS definition,
        extension.extname AS extension
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      JOIN pg_catalog.pg_language AS language ON language.oid = routine.prolang
      LEFT JOIN pg_catalog.pg_aggregate AS aggregate_row ON aggregate_row.aggfnoid = routine.oid
      LEFT JOIN pg_catalog.pg_depend AS dependency ON dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND dependency.objid = routine.oid AND dependency.deptype = 'e'
        AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      LEFT JOIN pg_catalog.pg_extension AS extension ON extension.oid = dependency.refobjid
      WHERE ${APPLICATION_NAMESPACE} AND routine.prokind IN ('f', 'p', 'w', 'a')
      ORDER BY namespace.nspname, routine.proname, pg_catalog.pg_get_function_identity_arguments(routine.oid)`,
      {
        identity: 'string',
        kind: ['f', 'p', 'w', 'a'],
        owner: 'string',
        language: 'string',
        securityDefiner: 'boolean',
        volatility: ['i', 's', 'v'],
        strict: 'boolean',
        parallel: ['s', 'r', 'u'],
        configuration: 'strings',
        acl: 'strings',
        definition: 'string',
        extension: 'nullableString',
      },
    );

    const relations = await select<CatalogRelation>(
      `
      SELECT namespace.nspname AS schema, relation.relname AS table, relation.relkind::text AS kind,
        pg_catalog.pg_get_userbyid(relation.relowner) AS owner, relation.relrowsecurity AS "rowSecurity",
        relation.relforcerowsecurity AS "forceRowSecurity", pg_catalog.pg_get_partkeydef(relation.oid) AS "partitionKey",
        ARRAY(SELECT parent_namespace.nspname || '.' || parent.relname FROM pg_catalog.pg_inherits AS inheritance
          JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
          JOIN pg_catalog.pg_namespace AS parent_namespace ON parent_namespace.oid = parent.relnamespace
          WHERE inheritance.inhrelid = relation.oid ORDER BY inheritance.inhseqno) AS parents
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE ${APPLICATION_NAMESPACE} AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      ORDER BY namespace.nspname, relation.relname`,
      {
        schema: 'string',
        table: 'string',
        kind: ['r', 'p', 'v', 'm', 'f'],
        owner: 'string',
        rowSecurity: 'boolean',
        forceRowSecurity: 'boolean',
        partitionKey: 'nullableString',
        parents: 'strings',
      },
    );

    const extensions = await select<UserReferenceCatalog['extensions'][number]>(
      `
      SELECT extension.extname AS name, extension.extversion AS version, namespace.nspname AS schema,
        pg_catalog.pg_get_userbyid(extension.extowner) AS owner
      FROM pg_catalog.pg_extension AS extension
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace ORDER BY extension.extname`,
      {
        name: 'string',
        version: 'string',
        schema: 'string',
        owner: 'string',
      },
    );
    const extensionRoutineCounts = await select<UserReferenceCatalog['extensionRoutineCounts'][number]>(
      `
      SELECT extension.extname AS extension, count(*)::integer AS count FROM pg_catalog.pg_depend AS dependency
      JOIN pg_catalog.pg_extension AS extension ON extension.oid = dependency.refobjid
      WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass AND dependency.deptype = 'e'
      GROUP BY extension.extname ORDER BY extension.extname`,
      { extension: 'string', count: 'number' },
    );
    const policies = await select<UserReferenceCatalog['policies'][number]>(
      `
      SELECT schemaname AS schema, tablename AS table, policyname AS name,
        pg_catalog.jsonb_build_object('permissive', permissive, 'roles', roles, 'cmd', cmd, 'qual', qual, 'with_check', with_check)::text AS definition
      FROM pg_catalog.pg_policies WHERE schemaname <> 'information_schema' AND schemaname !~ '^pg_'
      ORDER BY schemaname, tablename, policyname`,
      { schema: 'string', table: 'string', name: 'string', definition: 'string' },
    );
    const defaultPrivileges = await select<UserReferenceCatalog['defaultPrivileges'][number]>(
      `
      SELECT pg_catalog.pg_get_userbyid(privilege.defaclrole) AS owner, namespace.nspname AS schema,
        privilege.defaclobjtype::text AS type,
        ARRAY(SELECT entry::text FROM unnest(privilege.defaclacl) AS entry ORDER BY entry::text) AS acl
      FROM pg_catalog.pg_default_acl AS privilege
      LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = privilege.defaclnamespace
      ORDER BY owner, schema NULLS FIRST, type`,
      { owner: 'string', schema: 'nullableString', type: 'string', acl: 'strings' },
    );
    const eventTriggers = await select<UserReferenceCatalog['eventTriggers'][number]>(
      `
      SELECT event.evtname AS name, pg_catalog.pg_get_userbyid(event.evtowner) AS owner,
        event.evtevent AS event, event.evtenabled::text AS enabled,
        namespace.nspname || '.' || routine.proname || '(' || pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')' AS "functionIdentity",
        coalesce(event.evttags, ARRAY[]::text[]) AS tags
      FROM pg_catalog.pg_event_trigger AS event
      JOIN pg_catalog.pg_proc AS routine ON routine.oid = event.evtfoid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      ORDER BY event.evtname`,
      {
        name: 'string',
        owner: 'string',
        event: 'string',
        enabled: ['O', 'D', 'R', 'A'],
        functionIdentity: 'string',
        tags: 'strings',
      },
    );
    const dependencies = await select<CatalogDependency>(
      `
      WITH non_pinned AS MATERIALIZED (
        SELECT * FROM pg_catalog.pg_depend WHERE classid <> 0 AND objid <> 0
      )
      SELECT object.type AS "objectType", object.schema AS "objectSchema", object.identity AS "objectIdentity",
        referenced.type AS "referencedType", referenced.schema AS "referencedSchema",
        referenced.identity AS "referencedIdentity", dependency.deptype::text AS kind
      FROM non_pinned AS dependency
      CROSS JOIN LATERAL pg_catalog.pg_identify_object(dependency.classid, dependency.objid, dependency.objsubid) AS object
      CROSS JOIN LATERAL pg_catalog.pg_identify_object(dependency.refclassid, dependency.refobjid, dependency.refobjsubid) AS referenced
      WHERE (object.schema <> 'information_schema' AND object.schema !~ '^pg_')
        OR dependency.classid IN ('pg_catalog.pg_event_trigger'::pg_catalog.regclass,
          'pg_catalog.pg_default_acl'::pg_catalog.regclass, 'pg_catalog.pg_extension'::pg_catalog.regclass)
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE ${APPLICATION_NAMESPACE} AND relation.oid = CASE dependency.classid
            WHEN 'pg_catalog.pg_trigger'::pg_catalog.regclass THEN
              (SELECT tgrelid FROM pg_catalog.pg_trigger WHERE oid = dependency.objid)
            WHEN 'pg_catalog.pg_policy'::pg_catalog.regclass THEN
              (SELECT polrelid FROM pg_catalog.pg_policy WHERE oid = dependency.objid)
            WHEN 'pg_catalog.pg_rewrite'::pg_catalog.regclass THEN
              (SELECT ev_class FROM pg_catalog.pg_rewrite WHERE oid = dependency.objid)
            WHEN 'pg_catalog.pg_attrdef'::pg_catalog.regclass THEN
              (SELECT adrelid FROM pg_catalog.pg_attrdef WHERE oid = dependency.objid)
            ELSE NULL END
        )
      ORDER BY object.type, object.schema NULLS FIRST, object.identity,
        referenced.type, referenced.schema NULLS FIRST, referenced.identity, dependency.deptype`,
      {
        objectType: 'string',
        objectSchema: 'nullableString',
        objectIdentity: 'string',
        referencedType: 'string',
        referencedSchema: 'nullableString',
        referencedIdentity: 'string',
        kind: 'string',
      },
    );
    const publicLedger = await select<{ hash: string; createdAt: string }>(
      `
      SELECT hash, created_at::text AS "createdAt" FROM public.__drizzle_migrations ORDER BY id`,
      { hash: 'string', createdAt: 'string' },
    );
    const drizzleLedger = await select<{ hash: string; createdAt: string }>(
      `
      SELECT hash, created_at::text AS "createdAt" FROM drizzle.__drizzle_migrations ORDER BY id`,
      { hash: 'string', createdAt: 'string' },
    );
    return {
      version: 1,
      physical,
      snapshot: { isolation: 'repeatable read', readOnly: 'on', rowSecurity: 'off' },
      references,
      triggers,
      routines,
      eventTriggers,
      dependencies,
      relations,
      extensions,
      extensionRoutineCounts,
      policies,
      defaultPrivileges,
      ledgers: { public: publicLedger, drizzle: drizzleLedger },
    };
  });
}
