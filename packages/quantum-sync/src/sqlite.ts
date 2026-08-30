import { open } from 'node:fs/promises';
import {
  QUANTUM_REQUIRED_COLUMNS,
  QUANTUM_REQUIRED_COLUMN_TYPES,
  QUANTUM_SQLITE_USER_VERSION,
  type QuantumTableName,
} from './constants';
import { QuantumSyncError } from './errors';
import type {
  QuantumDiodeRow,
  QuantumModelCode,
  QuantumModelRow,
  QuantumRouteLightRow,
  QuantumRouteModelRow,
  QuantumRouteRow,
  QuantumSnapshotRows,
  QuantumSnapshotValidationSummary,
} from './types';
import { createPrivateQuantumTempFile, writeAllToFile } from './temp-file';

const SQLITE_HEADER = Uint8Array.from(Buffer.from('SQLite format 3\0', 'ascii'));

export type QuantumSqliteColumn = Readonly<{
  name: string;
  declaredType: string;
  primaryKeyPosition: number;
}>;

export type QuantumSqliteReader = {
  getUserVersion(): number | Promise<number>;
  getIntegrityCheck(): readonly string[] | Promise<readonly string[]>;
  getTableNames(): readonly string[] | Promise<readonly string[]>;
  getTableColumns(table: QuantumTableName): readonly QuantumSqliteColumn[] | Promise<readonly QuantumSqliteColumn[]>;
  getUniqueColumnSets(
    table: QuantumTableName,
  ): readonly (readonly string[])[] | Promise<readonly (readonly string[])[]>;
  readRows(
    table: QuantumTableName,
    columns: readonly string[],
  ): Iterable<Readonly<Record<string, unknown>>> | AsyncIterable<Readonly<Record<string, unknown>>>;
  close(): void | Promise<void>;
};

export type OpenQuantumSqlite = (filePath: string) => QuantumSqliteReader | Promise<QuantumSqliteReader>;

export type QuantumSqliteRowLimits = Readonly<{
  quantum_models: number;
  quantum_diodes: number;
  quantum_routes: number;
  quantum_route_models: number;
  quantum_route_lights: number;
}>;

export const DEFAULT_QUANTUM_SQLITE_ROW_LIMITS: QuantumSqliteRowLimits = Object.freeze({
  quantum_models: 5,
  // Five fixed grids contain fewer than 1,000 physical positions today. This
  // leaves an order of magnitude for future hardware without accepting a
  // source that can inflate the in-memory uniqueness indexes without bound.
  quantum_diodes: 10_000,
  quantum_routes: 100_000,
  quantum_route_models: 500_000,
  quantum_route_lights: 1_000_000,
});

export type ValidateQuantumSqliteOptions = {
  openSqlite?: OpenQuantumSqlite;
  rowLimits?: Partial<QuantumSqliteRowLimits>;
};

export type ValidatedQuantumRows = Readonly<{
  rows: QuantumSnapshotRows;
  summary: QuantumSnapshotValidationSummary;
}>;

const EXPECTED_MODELS: Readonly<
  Record<
    QuantumModelCode,
    Readonly<{ layoutId: number; productSizeId: number; columns: number; rows: number; forcedType: string }>
  >
> = {
  xl: { layoutId: 9101, productSizeId: 9201, columns: 15, rows: 15, forcedType: 'big' },
  l: { layoutId: 9102, productSizeId: 9202, columns: 15, rows: 12, forcedType: 'medium' },
  m: { layoutId: 9103, productSizeId: 9203, columns: 12, rows: 12, forcedType: 'small' },
  s: { layoutId: 9104, productSizeId: 9204, columns: 8, rows: 12, forcedType: 'xsmall' },
  belay: { layoutId: 9105, productSizeId: 9205, columns: 8, rows: 12, forcedType: 'belay' },
};

export async function validateQuantumSqliteSnapshot(
  bytes: Uint8Array,
  options: ValidateQuantumSqliteOptions = {},
): Promise<ValidatedQuantumRows> {
  const temporary = await createPrivateQuantumTempFile('boardsesh-quantum-snapshot-', 'snapshot.sqlite3');
  try {
    await writeAllToFile(temporary.handle, bytes);
    await temporary.close();
    return await validateQuantumSqliteFile(temporary.path, options);
  } finally {
    await temporary.dispose();
  }
}

/** Validate a decompressed snapshot in place without reading it into memory. */
export async function validateQuantumSqliteFile(
  filePath: string,
  options: ValidateQuantumSqliteOptions = {},
): Promise<ValidatedQuantumRows> {
  if (!(await fileHasPrefix(filePath, SQLITE_HEADER))) {
    throw new QuantumSyncError('SQLITE_INVALID', 'Quantum snapshot does not have a SQLite 3 header.');
  }
  const rowLimits = resolveRowLimits(options.rowLimits);
  let reader: QuantumSqliteReader | undefined;
  try {
    reader = await (options.openSqlite ?? openNodeQuantumSqlite)(filePath);
    await validateSqliteSchema(reader);
    return await readAndValidateRows(reader, rowLimits);
  } catch (error) {
    if (error instanceof QuantumSyncError) throw error;
    throw new QuantumSyncError('SQLITE_INVALID', 'Quantum SQLite snapshot validation failed.', { cause: error });
  } finally {
    await reader?.close();
  }
}

async function validateSqliteSchema(reader: QuantumSqliteReader): Promise<void> {
  const userVersion = await reader.getUserVersion();
  if (userVersion !== QUANTUM_SQLITE_USER_VERSION) {
    throw new QuantumSyncError('SQLITE_INVALID', `Quantum SQLite user_version must be ${QUANTUM_SQLITE_USER_VERSION}.`);
  }
  const integrityRows = await reader.getIntegrityCheck();
  if (integrityRows.length !== 1 || integrityRows[0]?.toLowerCase() !== 'ok') {
    throw new QuantumSyncError('SQLITE_INVALID', 'Quantum SQLite integrity_check did not return ok.');
  }
  const tableNames = new Set(await reader.getTableNames());

  for (const table of Object.keys(QUANTUM_REQUIRED_COLUMNS) as QuantumTableName[]) {
    if (!tableNames.has(table)) {
      throw new QuantumSyncError('SQLITE_INVALID', `Quantum SQLite is missing required table ${table}.`);
    }
    const columns = await reader.getTableColumns(table);
    const requiredNames = QUANTUM_REQUIRED_COLUMNS[table];
    if (
      columns.length !== requiredNames.length ||
      columns.some((column, index) => column.name !== requiredNames[index])
    ) {
      throw new QuantumSyncError('SQLITE_INVALID', `Quantum SQLite table ${table} has an unsupported column layout.`);
    }
    for (const column of columns) {
      const requiredType = QUANTUM_REQUIRED_COLUMN_TYPES[table][column.name];
      if (column.declaredType.toUpperCase() !== requiredType) {
        throw new QuantumSyncError(
          'SQLITE_INVALID',
          `Quantum SQLite column ${table}.${column.name} must have type ${requiredType}.`,
        );
      }
    }
  }

  await requirePrimaryKey(reader, 'quantum_models', 'model');
  await requirePrimaryKey(reader, 'quantum_routes', 'uuid');
  const routeModelUniqueSets = await reader.getUniqueColumnSets('quantum_route_models');
  if (!routeModelUniqueSets.some((columnSet) => columnSet.length === 1 && columnSet[0] === 'app_uuid')) {
    throw new QuantumSyncError('SQLITE_INVALID', 'Quantum SQLite route-model app_uuid must have a unique constraint.');
  }
}

async function requirePrimaryKey(
  reader: QuantumSqliteReader,
  table: QuantumTableName,
  columnName: string,
): Promise<void> {
  const columns = await reader.getTableColumns(table);
  const primaryColumns = columns.filter((column) => column.primaryKeyPosition > 0);
  if (
    primaryColumns.length !== 1 ||
    primaryColumns[0]?.name !== columnName ||
    primaryColumns[0].primaryKeyPosition !== 1
  ) {
    throw new QuantumSyncError(
      'SQLITE_INVALID',
      `Quantum SQLite table ${table} must use ${columnName} as its primary key.`,
    );
  }
}

async function readAndValidateRows(
  reader: QuantumSqliteReader,
  rowLimits: QuantumSqliteRowLimits,
): Promise<ValidatedQuantumRows> {
  const models: QuantumModelRow[] = [];
  const modelCodes = new Set<QuantumModelCode>();
  const modelsByCode = new Map<QuantumModelCode, QuantumModelRow>();
  for await (const record of boundedRows(reader, 'quantum_models', rowLimits.quantum_models)) {
    const model = normalizeModel(record);
    if (modelCodes.has(model.model)) {
      throw new QuantumSyncError('SQLITE_INVALID', `Quantum model ${model.model} is duplicated.`);
    }
    modelCodes.add(model.model);
    modelsByCode.set(model.model, model);
    models.push(model);
  }
  if (models.length !== Object.keys(EXPECTED_MODELS).length) {
    throw new QuantumSyncError(
      'SQLITE_INVALID',
      'Quantum SQLite must contain exactly the five supported board models.',
    );
  }
  for (const expectedModel of Object.keys(EXPECTED_MODELS) as QuantumModelCode[]) {
    if (!modelCodes.has(expectedModel)) {
      throw new QuantumSyncError('SQLITE_INVALID', `Quantum SQLite is missing model ${expectedModel}.`);
    }
  }

  const diodes: QuantumDiodeRow[] = [];
  const diodeKeys = new Set<string>();
  const placementKeys = new Set<string>();
  const autocadKeys = new Set<string>();
  const modelsWithDiodes = new Set<QuantumModelCode>();
  for await (const record of boundedRows(reader, 'quantum_diodes', rowLimits.quantum_diodes)) {
    const diode = normalizeDiode(record, modelsByCode);
    requireUnique(diodeKeys, `${diode.model}\0${diode.diodeUuid}`, 'Quantum diode UUID');
    requireUnique(placementKeys, `${diode.model}\0${diode.placementId}`, 'Quantum placement id');
    requireUnique(autocadKeys, `${diode.model}\0${diode.autocadId}`, 'Quantum autocad id');
    modelsWithDiodes.add(diode.model);
    diodes.push(diode);
  }
  for (const model of modelCodes) {
    if (!modelsWithDiodes.has(model)) {
      throw new QuantumSyncError('SQLITE_INVALID', `Quantum model ${model} has no diodes.`);
    }
  }

  const routes: QuantumRouteRow[] = [];
  const routeUuids = new Set<string>();
  for await (const record of boundedRows(reader, 'quantum_routes', rowLimits.quantum_routes)) {
    const route = normalizeRoute(record);
    requireUnique(routeUuids, route.uuid, 'Quantum route UUID');
    routes.push(route);
  }
  if (routes.length === 0) {
    throw new QuantumSyncError('SQLITE_INVALID', 'Quantum SQLite contains no routes.');
  }

  const routeModels: QuantumRouteModelRow[] = [];
  const routeModelKeys = new Set<string>();
  const appUuids = new Set<string>();
  const routesWithModels = new Set<string>();
  for await (const record of boundedRows(reader, 'quantum_route_models', rowLimits.quantum_route_models)) {
    const routeModel = normalizeRouteModel(record, routeUuids, modelCodes);
    const routeModelKey = `${routeModel.routeUuid}\0${routeModel.model}`;
    requireUnique(routeModelKeys, routeModelKey, 'Quantum route/model pair');
    requireUnique(appUuids, routeModel.appUuid, 'Quantum app UUID');
    routesWithModels.add(routeModel.routeUuid);
    routeModels.push(routeModel);
  }
  for (const routeUuid of routeUuids) {
    if (!routesWithModels.has(routeUuid)) {
      throw new QuantumSyncError('SQLITE_INVALID', `Quantum route ${routeUuid} has no model mapping.`);
    }
  }

  const routeLights: QuantumRouteLightRow[] = [];
  const routeLightKeys = new Set<string>();
  const lightCounts = new Map<string, number>();
  for await (const record of boundedRows(reader, 'quantum_route_lights', rowLimits.quantum_route_lights)) {
    const routeLight = normalizeRouteLight(record, routeModelKeys, diodeKeys);
    const routeModelKey = `${routeLight.routeUuid}\0${routeLight.model}`;
    requireUnique(routeLightKeys, `${routeModelKey}\0${routeLight.diodeUuid}`, 'Quantum route light diode mapping');
    const nextCount = (lightCounts.get(routeModelKey) ?? 0) + 1;
    if (nextCount > 92) {
      throw new QuantumSyncError('SQLITE_INVALID', `Quantum route/model ${routeModelKey} exceeds 92 lights.`);
    }
    lightCounts.set(routeModelKey, nextCount);
    routeLights.push(routeLight);
  }
  for (const routeModelKey of routeModelKeys) {
    if (!lightCounts.has(routeModelKey)) {
      throw new QuantumSyncError('SQLITE_INVALID', `Quantum route/model ${routeModelKey} has no lights.`);
    }
  }

  const frozenRows = Object.freeze({
    models: freezeRows(models),
    diodes: freezeRows(diodes),
    routes: freezeRows(routes),
    routeModels: freezeRows(routeModels),
    routeLights: freezeRows(routeLights),
  });
  const summary = Object.freeze({
    models: models.length,
    diodes: diodes.length,
    routes: routes.length,
    routeModels: routeModels.length,
    routeLights: routeLights.length,
  });
  return Object.freeze({ rows: frozenRows, summary });
}

async function* boundedRows(
  reader: QuantumSqliteReader,
  table: QuantumTableName,
  maximumRows: number,
): AsyncIterable<Readonly<Record<string, unknown>>> {
  let rowCount = 0;
  for await (const row of reader.readRows(table, QUANTUM_REQUIRED_COLUMNS[table])) {
    rowCount += 1;
    if (rowCount > maximumRows) {
      throw new QuantumSyncError('SQLITE_INVALID', `Quantum SQLite table ${table} exceeds its row cap.`);
    }
    yield row;
  }
}

function normalizeModel(record: Readonly<Record<string, unknown>>): QuantumModelRow {
  const model = requireModelCode(record.model);
  const expected = EXPECTED_MODELS[model];
  const normalized = {
    model,
    layoutId: requireInteger(record.layout_id, 'quantum_models.layout_id'),
    productSizeId: requireInteger(record.product_size_id, 'quantum_models.product_size_id'),
    name: requireBoundedString(record.name, 'quantum_models.name'),
    columns: requireInteger(record.columns, 'quantum_models.columns'),
    rows: requireInteger(record.rows, 'quantum_models.rows'),
    forcedType: requireBoundedString(record.forced_type, 'quantum_models.forced_type'),
    edgeLeft: requireFiniteNumber(record.edge_left, 'quantum_models.edge_left'),
    edgeRight: requireFiniteNumber(record.edge_right, 'quantum_models.edge_right'),
    edgeBottom: requireFiniteNumber(record.edge_bottom, 'quantum_models.edge_bottom'),
    edgeTop: requireFiniteNumber(record.edge_top, 'quantum_models.edge_top'),
  };
  if (
    normalized.layoutId !== expected.layoutId ||
    normalized.productSizeId !== expected.productSizeId ||
    normalized.columns !== expected.columns ||
    normalized.rows !== expected.rows ||
    normalized.forcedType !== expected.forcedType
  ) {
    throw new QuantumSyncError(
      'SQLITE_INVALID',
      `Quantum model ${model} hardware dimensions, ids, or controller type are invalid.`,
    );
  }
  if (normalized.edgeLeft >= normalized.edgeRight || normalized.edgeBottom >= normalized.edgeTop) {
    throw new QuantumSyncError('SQLITE_INVALID', `Quantum model ${model} has invalid geometry edges.`);
  }
  return Object.freeze(normalized);
}

function normalizeDiode(
  record: Readonly<Record<string, unknown>>,
  modelsByCode: ReadonlyMap<QuantumModelCode, QuantumModelRow>,
): QuantumDiodeRow {
  const model = requireModelCode(record.model);
  const modelGeometry = modelsByCode.get(model);
  if (!modelGeometry) {
    throw new QuantumSyncError('SQLITE_INVALID', `Quantum diode references missing model ${model}.`);
  }
  const normalized = {
    model,
    diodeUuid: requireIdentifier(record.diode_uuid, 'quantum_diodes.diode_uuid'),
    placementId: requireNonNegativeInteger(record.placement_id, 'quantum_diodes.placement_id'),
    ledNode: requireBoundedString(record.led_node, 'quantum_diodes.led_node'),
    autocadId: parseAutocadId(record.autocad_id),
    holdType: requireBoundedString(record.hold_type, 'quantum_diodes.hold_type'),
    x: requireFiniteNumber(record.x, 'quantum_diodes.x'),
    y: requireFiniteNumber(record.y, 'quantum_diodes.y'),
    z: requireFiniteNumber(record.z, 'quantum_diodes.z'),
  };
  if (
    normalized.x < modelGeometry.edgeLeft ||
    normalized.x > modelGeometry.edgeRight ||
    normalized.y < modelGeometry.edgeBottom ||
    normalized.y > modelGeometry.edgeTop
  ) {
    throw new QuantumSyncError('SQLITE_INVALID', `Quantum diode ${normalized.diodeUuid} lies outside ${model} edges.`);
  }
  return Object.freeze(normalized);
}

function normalizeRoute(record: Readonly<Record<string, unknown>>): QuantumRouteRow {
  const createdAt = requireNonNegativeInteger(record.created_at, 'quantum_routes.created_at');
  const updatedAt = requireNonNegativeInteger(record.updated_at, 'quantum_routes.updated_at');
  if (updatedAt < createdAt) {
    throw new QuantumSyncError('SQLITE_INVALID', 'Quantum route updated_at precedes created_at.');
  }
  const angle = requireInteger(record.angle, 'quantum_routes.angle');
  if (angle < 0 || angle > 90) {
    throw new QuantumSyncError('SQLITE_INVALID', 'Quantum route angle must be between 0 and 90 degrees.');
  }
  const ascents = requireNonNegativeInteger(record.ascents, 'quantum_routes.ascents');
  const plays = requireNonNegativeInteger(record.plays, 'quantum_routes.plays');
  const rating = requireFiniteNumber(record.rating, 'quantum_routes.rating');
  if (rating < 0) {
    throw new QuantumSyncError('SQLITE_INVALID', 'Quantum route rating must be non-negative.');
  }
  return Object.freeze({
    uuid: requireCanonicalUuid(record.uuid, 'quantum_routes.uuid'),
    name: requireBoundedString(record.name, 'quantum_routes.name'),
    setter: optionalBoundedString(record.setter, 'quantum_routes.setter'),
    grade: requireBoundedString(record.grade, 'quantum_routes.grade'),
    angle,
    rating,
    ascents,
    plays,
    createdAt,
    updatedAt,
    disabled: normalizeBoolean(record.disabled, 'quantum_routes.disabled'),
    campusing: normalizeBoolean(record.campusing, 'quantum_routes.campusing'),
    edge: normalizeBoolean(record.edge, 'quantum_routes.edge'),
    kickplate: normalizeBoolean(record.kickplate, 'quantum_routes.kickplate'),
    matching: normalizeBoolean(record.matching, 'quantum_routes.matching'),
    standard: normalizeBoolean(record.standard, 'quantum_routes.standard'),
    tags: optionalBoundedString(record.tags, 'quantum_routes.tags', 1024 * 1024),
    tips: optionalBoundedString(record.tips, 'quantum_routes.tips', 1024 * 1024),
  });
}

function normalizeRouteModel(
  record: Readonly<Record<string, unknown>>,
  routeUuids: ReadonlySet<string>,
  modelCodes: ReadonlySet<QuantumModelCode>,
): QuantumRouteModelRow {
  const routeUuid = requireCanonicalUuid(record.route_uuid, 'quantum_route_models.route_uuid');
  const model = requireModelCode(record.model);
  if (!routeUuids.has(routeUuid) || !modelCodes.has(model)) {
    throw new QuantumSyncError('SQLITE_INVALID', 'Quantum route model contains a dangling reference.');
  }
  return Object.freeze({
    routeUuid,
    model,
    appUuid: requireCanonicalUuid(record.app_uuid, 'quantum_route_models.app_uuid'),
  });
}

function normalizeRouteLight(
  record: Readonly<Record<string, unknown>>,
  routeModelKeys: ReadonlySet<string>,
  diodeKeys: ReadonlySet<string>,
): QuantumRouteLightRow {
  const routeUuid = requireCanonicalUuid(record.route_uuid, 'quantum_route_lights.route_uuid');
  const model = requireModelCode(record.model);
  const diodeUuid = requireIdentifier(record.diode_uuid, 'quantum_route_lights.diode_uuid');
  if (!routeModelKeys.has(`${routeUuid}\0${model}`) || !diodeKeys.has(`${model}\0${diodeUuid}`)) {
    throw new QuantumSyncError('SQLITE_INVALID', 'Quantum route light contains a dangling reference.');
  }
  const step = requireInteger(record.step, 'quantum_route_lights.step');
  if (step < 0 || step > 255) {
    throw new QuantumSyncError('SQLITE_INVALID', 'Quantum route light step must fit an unsigned byte.');
  }
  return Object.freeze({ routeUuid, model, diodeUuid, step });
}

export async function openNodeQuantumSqlite(databasePath: string): Promise<QuantumSqliteReader> {
  const sqlite = await import('node:sqlite');
  const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
  } catch (error) {
    database.close();
    throw error;
  }
  const openedDatabase = database;
  let closed = false;
  return {
    getUserVersion() {
      const row = openedDatabase.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
      return requireInteger(row?.user_version, 'PRAGMA user_version');
    },
    getIntegrityCheck() {
      const rows = openedDatabase.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
      return rows.map((row) => {
        const result = Object.values(row)[0];
        return typeof result === 'string' ? result : '';
      });
    },
    getTableNames() {
      const rows = openedDatabase
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<Record<string, unknown>>;
      return rows.map((row) => String(row.name));
    },
    getTableColumns(table) {
      const rows = openedDatabase.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<
        Record<string, unknown>
      >;
      return rows.map((row) => ({
        name: String(row.name),
        declaredType: String(row.type),
        primaryKeyPosition: requireNonNegativeInteger(row.pk, `PRAGMA table_info(${table}).pk`),
      }));
    },
    getUniqueColumnSets(table) {
      const indexes = openedDatabase.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all() as Array<
        Record<string, unknown>
      >;
      return indexes
        .filter((index) => index.unique === 1)
        .map((index) => {
          const indexName = String(index.name);
          const columns = openedDatabase.prepare(`PRAGMA index_info(${quoteIdentifier(indexName)})`).all() as Array<
            Record<string, unknown>
          >;
          return columns
            .sort(
              (left, right) =>
                requireInteger(left.seqno, 'PRAGMA index_info.seqno') -
                requireInteger(right.seqno, 'PRAGMA index_info.seqno'),
            )
            .map((column) => String(column.name));
        });
    },
    readRows(table, columns) {
      const selectedColumns = columns.map(quoteIdentifier).join(', ');
      return openedDatabase
        .prepare(`SELECT ${selectedColumns} FROM ${quoteIdentifier(table)}`)
        .iterate() as unknown as Iterable<Readonly<Record<string, unknown>>>;
    },
    async close() {
      if (closed) return;
      closed = true;
      openedDatabase.close();
    },
  };
}

function resolveRowLimits(overrides: Partial<QuantumSqliteRowLimits> | undefined): QuantumSqliteRowLimits {
  const resolved = { ...DEFAULT_QUANTUM_SQLITE_ROW_LIMITS, ...overrides };
  for (const [table, maximumRows] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(maximumRows) || maximumRows <= 0) {
      throw new QuantumSyncError('CONFIG_INVALID', `Quantum row limit for ${table} must be a positive safe integer.`);
    }
  }
  return Object.freeze(resolved);
}

function requireModelCode(value: unknown): QuantumModelCode {
  if (value === 'xl' || value === 'l' || value === 'm' || value === 's' || value === 'belay') return value;
  throw new QuantumSyncError('SQLITE_INVALID', 'Quantum SQLite contains an unknown model code.');
}

function requireIdentifier(value: unknown, label: string): string {
  return requireBoundedString(value, label, 256);
}

function requireCanonicalUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new QuantumSyncError('SQLITE_INVALID', `${label} must be a lowercase canonical 16-byte UUID.`);
  }
  return value;
}

function requireBoundedString(value: unknown, label: string, maximumLength = 16_384): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw new QuantumSyncError('SQLITE_INVALID', `${label} must be a non-empty bounded string.`);
  }
  return value;
}

function optionalBoundedString(value: unknown, label: string, maximumLength = 16_384): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new QuantumSyncError('SQLITE_INVALID', `${label} must be a bounded string or null.`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new QuantumSyncError('SQLITE_INVALID', `${label} must be a finite number.`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);
  if (!Number.isSafeInteger(number)) {
    throw new QuantumSyncError('SQLITE_INVALID', `${label} must be a safe integer.`);
  }
  return number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const number = requireInteger(value, label);
  if (number < 0) {
    throw new QuantumSyncError('SQLITE_INVALID', `${label} must be non-negative.`);
  }
  return number;
}

function normalizeBoolean(value: unknown, label: string): boolean {
  if (value === null || value === undefined || value === 0) return false;
  if (value === 1) return true;
  throw new QuantumSyncError('SQLITE_INVALID', `${label} must be SQLite integer 0, 1, or null.`);
}

function parseAutocadId(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new QuantumSyncError('SQLITE_INVALID', 'quantum_diodes.autocad_id must be a decimal string.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new QuantumSyncError('SQLITE_INVALID', 'quantum_diodes.autocad_id must fit an unsigned 16-bit integer.');
  }
  return parsed;
}

function requireUnique(set: Set<string>, key: string, label: string): void {
  if (set.has(key)) {
    throw new QuantumSyncError('SQLITE_INVALID', `${label} is duplicated.`);
  }
  set.add(key);
}

function freezeRows<Row extends object>(rows: Row[]): readonly Readonly<Row>[] {
  for (const row of rows) Object.freeze(row);
  return Object.freeze(rows);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function fileHasPrefix(filePath: string, prefix: Uint8Array): Promise<boolean> {
  const file = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(prefix.byteLength);
    const { bytesRead } = await file.read(header, 0, prefix.byteLength, 0);
    return bytesRead === prefix.byteLength && prefix.every((byte, index) => header[index] === byte);
  } finally {
    await file.close();
  }
}
