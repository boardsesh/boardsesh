import type { MoonBoardCollectionRow } from './moonboard-collection';

export type MoonBoardExportUser = {
  firstName?: string;
  lastName?: string;
  setterName?: string;
  username?: string;
  city?: string;
  country?: string;
};

export type MoonBoardExportLogRow = {
  lineNumber: number;
  /** Older exports identify problems by Moon's numeric id. */
  problemId?: number;
  /** Newer exports drop the id and only carry the problem name. */
  name?: string;
  /** Setter's name, when the export carries a setter column. */
  setter?: string;
  /** Moon's setup name, e.g. "MoonBoard 2016". */
  setup?: string;
  /** Board angle from the export's configuration column; absent means 40°. */
  angle?: number;
  isBenchmark?: boolean;
  comment?: string;
  grade: string;
  tries: string;
  attempts: number;
  rating: number | null;
  date: string;
};

export type StrippedMoonBoardExportData = {
  user: MoonBoardExportUser;
  logs: MoonBoardExportLogRow[];
};

export type MoonBoardExportPreview = {
  username: string;
  rows: number;
  sends: number;
  flashes: number;
  attempts: number;
  projects: number;
  fails: number;
  angles: number[];
};

export type ParsedMoonBoardExportResult = {
  data: StrippedMoonBoardExportData;
  preview: MoonBoardExportPreview;
};

export type MoonBoardLogRowClassification =
  | { status: 'flash'; attemptCount: 1 }
  | { status: 'send'; attemptCount: number }
  | { status: 'attempt'; attemptCount: number };

export type MoonBoardImportCounts = {
  imported: number;
  skipped: number;
  failed: number;
};

/**
 * How an export row was tied to a catalogue climb, most specific first. Each
 * name-based method only accepts a single unambiguous climb; otherwise the
 * importer falls through to the next one.
 */
export const MOONBOARD_CLIMB_MATCH_METHODS = ['id', 'nameSetterGrade', 'nameGrade', 'name'] as const;
export type MoonBoardClimbMatchMethod = (typeof MOONBOARD_CLIMB_MATCH_METHODS)[number];

export type MoonBoardImportResult = {
  ticks: MoonBoardImportCounts;
  ascents: MoonBoardImportCounts;
  attempts: MoonBoardImportCounts;
  unresolvedClimbs: string[];
  unresolvedAscentClimbs: string[];
  unresolvedAttemptClimbs: string[];
  /** Resolved rows per match method. */
  matchedBy?: Record<MoonBoardClimbMatchMethod, number>;
  partialError?: string;
};

export type MoonBoardImportProgressEvent =
  | { type: 'progress'; step: 'resolving'; current: number; total: number }
  | { type: 'progress'; step: 'importing'; current: number; total: number }
  | { type: 'progress'; step: 'recomputing'; message: string }
  | { type: 'complete'; results: MoonBoardImportResult }
  | { type: 'error'; error: string };

export const DEFAULT_MOONBOARD_IMPORT_ANGLE = 40;

export type MoonBoardExportColumn =
  | 'problemId'
  | 'name'
  | 'setter'
  | 'grade'
  | 'tries'
  | 'attempts'
  | 'rating'
  | 'date'
  | 'setup'
  | 'configuration'
  | 'benchmark'
  | 'comment'
  | 'active'
  | 'deleted';

// Moon builds these exports by hand, so column order and header wording drift
// between files. Headers are matched after stripping case, spaces and punctuation.
const COLUMN_ALIASES: Record<MoonBoardExportColumn, readonly string[]> = {
  problemId: ['problemid', 'id'],
  name: ['name', 'problemname', 'problem'],
  setter: ['setter', 'settername', 'setterusername', 'setby'],
  grade: ['grade'],
  tries: ['tries'],
  attempts: ['attempts'],
  rating: ['rating', 'stars'],
  date: ['date', 'dateclimbed', 'climbeddate'],
  setup: ['setup', 'layout'],
  configuration: ['configuration', 'angle'],
  benchmark: ['benchmark'],
  comment: ['comments', 'comment', 'notes'],
  active: ['active', 'isactive'],
  deleted: ['deleted', 'deletedat', 'datedeleted'],
};

const REQUIRED_COLUMNS: readonly MoonBoardExportColumn[] = ['grade', 'tries', 'date'];

export type MoonBoardColumnIndexes = Partial<Record<MoonBoardExportColumn, number>>;

export type MoonBoardCsvParseOptions = {
  /** Zero-based CSV record containing the column headers. */
  headerRowIndex?: number;
  /** Complete column mapping; omitted fields are not read. */
  columns?: MoonBoardColumnIndexes;
};

export type MoonBoardCsvInspection = {
  kind: 'logbook' | 'profile' | 'collection' | 'unknown';
  headers: string[];
  headerRowIndex: number;
  sampleRows: string[][];
  columns: MoonBoardColumnIndexes;
  rowCount: number;
};

export type ParsedMoonBoardCollectionResult = {
  rows: MoonBoardCollectionRow[];
  excluded: number;
};

const USER_METADATA_KEYS: Record<string, keyof MoonBoardExportUser> = {
  firstname: 'firstName',
  lastname: 'lastName',
  settername: 'setterName',
  username: 'username',
  city: 'city',
  country: 'country',
};

const PROFILE_METADATA_KEYS = new Set([
  ...Object.keys(USER_METADATA_KEYS),
  'email',
  'gender',
  'dob',
  'hasownmoonboard',
  'agreeterms',
  'cansharedata',
  'subscribetomarketingemails',
]);

function normalizeHeaderCell(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeMetadataKey(cell: string): string {
  return cell.trim().replace(/\s+/g, '').toLowerCase();
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const nextChar = csv[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== '') || rows.length === 0) rows.push(row);
  return rows;
}

function findColumnIndexes(row: string[]): MoonBoardColumnIndexes {
  const normalizedCells = row.map(normalizeHeaderCell);
  const indexes: MoonBoardColumnIndexes = {};
  for (const [column, aliases] of Object.entries(COLUMN_ALIASES) as [MoonBoardExportColumn, readonly string[]][]) {
    const index = normalizedCells.findIndex((cell) => aliases.includes(cell));
    if (index !== -1) indexes[column] = index;
  }

  return indexes;
}

function hasLogColumns(columns: MoonBoardColumnIndexes): boolean {
  return (
    REQUIRED_COLUMNS.every((column) => columns[column] != null) && (columns.problemId != null || columns.name != null)
  );
}

function isBlankRow(row: string[]): boolean {
  return row.every((cell) => cell.trim() === '');
}

function isProfileMetadataRow(row: string[]): boolean {
  return (
    PROFILE_METADATA_KEYS.has(normalizeMetadataKey(row[0] ?? '')) && row.slice(2).every((cell) => cell.trim() === '')
  );
}

function inspectCsvRows(rows: string[][], selectedHeaderRowIndex?: number): MoonBoardCsvInspection {
  if (
    selectedHeaderRowIndex != null &&
    (!Number.isInteger(selectedHeaderRowIndex) ||
      selectedHeaderRowIndex < 0 ||
      selectedHeaderRowIndex >= rows.length ||
      isBlankRow(rows[selectedHeaderRowIndex]))
  ) {
    throw new Error('invalid_header_row');
  }

  let headerRowIndex = selectedHeaderRowIndex ?? -1;
  if (headerRowIndex === -1) {
    // Prefer a complete log header, even when metadata or a cover table comes first.
    headerRowIndex = rows.findIndex((row) => hasLogColumns(findColumnIndexes(row)));
    if (headerRowIndex === -1) {
      headerRowIndex = rows.findIndex((row) => {
        const columns = findColumnIndexes(row);
        return columns.name != null && columns.grade != null;
      });
    }
    if (headerRowIndex === -1) {
      headerRowIndex = rows.findIndex(
        (row) => !isProfileMetadataRow(row) && row.filter((cell) => cell.trim() !== '').length >= 2,
      );
    }
    if (headerRowIndex === -1)
      headerRowIndex = Math.max(
        rows.findIndex((row) => !isBlankRow(row)),
        0,
      );
  }

  const headers = rows[headerRowIndex].map((cell) => cell.trim());
  const columns = findColumnIndexes(headers);
  let kind: MoonBoardCsvInspection['kind'] = 'unknown';
  if (hasLogColumns(columns)) {
    kind = 'logbook';
  } else if (columns.name != null && columns.grade != null) {
    kind = 'collection';
  } else if (
    rows.filter(isProfileMetadataRow).length >= 2 &&
    rows.every((row) => isBlankRow(row) || isProfileMetadataRow(row))
  ) {
    kind = 'profile';
  }

  const sampleRows: string[][] = [];
  let rowCount = 0;
  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    if (isBlankRow(rows[rowIndex])) continue;
    rowCount += 1;
    if (sampleRows.length < 5) sampleRows.push(rows[rowIndex]);
  }
  return {
    kind,
    headers,
    headerRowIndex,
    sampleRows,
    columns,
    rowCount,
  };
}

/** Inspects file contents without requiring a supported logbook schema. */
export function inspectMoonBoardExportCsv(csv: string, headerRowIndex?: number): MoonBoardCsvInspection {
  return inspectCsvRows(parseCsvRows(csv.replace(/^\uFEFF/, '')), headerRowIndex);
}

function validateColumnIndexes(columns: MoonBoardColumnIndexes, headerWidth: number): MoonBoardColumnIndexes {
  const usedIndexes = new Set<number>();
  for (const [column, index] of Object.entries(columns)) {
    if (index === undefined) continue;
    if (!Object.hasOwn(COLUMN_ALIASES, column) || !Number.isInteger(index) || index < 0 || index >= headerWidth) {
      throw new Error(`invalid_${column}_column`);
    }
    if (usedIndexes.has(index)) throw new Error(`duplicate_${column}_column`);
    usedIndexes.add(index);
  }
  return columns;
}

function requireColumns(columns: MoonBoardColumnIndexes, required: readonly MoonBoardExportColumn[]): void {
  for (const column of required) {
    if (columns[column] == null) throw new Error(`missing_${column}_column`);
  }
}

function cellAt(row: string[], index: number | undefined): string {
  return index == null ? '' : (row[index] ?? '').trim();
}

// Windows-1252 bytes 0x80-0x9F map to these code points; every other byte maps
// to itself (Latin-1). Moon's exports come out of Excel in this encoding.
const WINDOWS_1252_HIGH_CODE_POINTS = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

function isValidUtf8(bytes: Uint8Array): boolean {
  let index = 0;
  while (index < bytes.length) {
    const leadByte = bytes[index];
    let continuationCount: number;
    if (leadByte < 0x80) continuationCount = 0;
    else if (leadByte >= 0xc2 && leadByte <= 0xdf) continuationCount = 1;
    else if (leadByte >= 0xe0 && leadByte <= 0xef) continuationCount = 2;
    else if (leadByte >= 0xf0 && leadByte <= 0xf4) continuationCount = 3;
    else return false;

    if (index + continuationCount >= bytes.length && continuationCount > 0) return false;
    for (let offset = 1; offset <= continuationCount; offset += 1) {
      if ((bytes[index + offset] & 0xc0) !== 0x80) return false;
    }
    index += continuationCount + 1;
  }
  return true;
}

/**
 * Decodes a MoonBoard export file. Some exports are UTF-8, others are
 * Windows-1252 (Excel's default), where names like "Björk" or "DON’T BE SUBTLE"
 * would turn into replacement characters under a plain UTF-8 read.
 */
export function decodeMoonBoardExportBytes(bytes: Uint8Array): string {
  if (isValidUtf8(bytes)) return new TextDecoder('utf-8').decode(bytes);

  let decoded = '';
  for (const byte of bytes) {
    decoded += String.fromCharCode(byte >= 0x80 && byte <= 0x9f ? WINDOWS_1252_HIGH_CODE_POINTS[byte - 0x80] : byte);
  }
  return decoded;
}

function parseRequiredInteger(value: string, field: string, lineNumber: number): number {
  const trimmedValue = value.trim();
  if (!/^\d+$/.test(trimmedValue)) {
    throw new Error(`invalid_${field}_line_${lineNumber}`);
  }
  return Number(trimmedValue);
}

function parseOptionalRating(value: string, lineNumber: number): number | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) return null;
  const rating = parseRequiredInteger(trimmedValue, 'rating', lineNumber);
  if (rating === 0) return null;
  if (rating < 1 || rating > 5) {
    throw new Error(`invalid_rating_line_${lineNumber}`);
  }
  return rating;
}

function parseOptionalInteger(value: string, field: string, lineNumber: number): number | undefined {
  return value ? parseRequiredInteger(value, field, lineNumber) : undefined;
}

function parseAngle(configuration: string, lineNumber: number): number | undefined {
  if (!configuration) return undefined;
  // "40° MoonBoard", "25 degrees", or a bare "40". The degree sign is often
  // mangled by the export's encoding, so only the leading number is read.
  const match = configuration.match(/^\D*(\d{1,2})(?!\d)/);
  if (!match) throw new Error(`invalid_angle_line_${lineNumber}`);
  return Number(match[1]);
}

function parseBenchmark(value: string): boolean | undefined {
  const normalizedValue = value.toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(normalizedValue)) return true;
  if (['false', 'no', 'n', '0'].includes(normalizedValue)) return false;
  return undefined;
}

function normalizeTriesLabel(tries: string): string {
  return tries.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function classifyMoonBoardLogRow(row: MoonBoardExportLogRow): MoonBoardLogRowClassification {
  const label = normalizeTriesLabel(row.tries);
  if (label === 'flashed') {
    return { status: 'flash', attemptCount: 1 };
  }
  if (label === 'session flash') {
    return { status: 'send', attemptCount: 1 };
  }

  const tryMatch = label.match(/^(\d+)(?:st|nd|rd|th)? try$/);
  if (tryMatch) {
    const attemptCount = Number(tryMatch[1]);
    return attemptCount <= 1 ? { status: 'flash', attemptCount: 1 } : { status: 'send', attemptCount };
  }

  if (label === 'more than 3 tries' || label === '> 3 tries' || label === '>3 tries') {
    return { status: 'send', attemptCount: Math.max(row.attempts, 4) };
  }

  if (label === 'project' || label === 'fail') {
    return { status: 'attempt', attemptCount: Math.max(row.attempts, 1) };
  }

  throw new Error(`unsupported_tries_line_${row.lineNumber}`);
}

function buildPreview(data: StrippedMoonBoardExportData): MoonBoardExportPreview {
  let sends = 0;
  let flashes = 0;
  let attempts = 0;
  let projects = 0;
  let fails = 0;

  for (const row of data.logs) {
    const classification = classifyMoonBoardLogRow(row);
    const triesLabel = normalizeTriesLabel(row.tries);
    if (classification.status === 'attempt') {
      attempts += 1;
      if (triesLabel === 'project') projects += 1;
      if (triesLabel === 'fail') fails += 1;
    } else {
      sends += 1;
      if (classification.status === 'flash') flashes += 1;
    }
  }

  const angles = [...new Set(data.logs.map((row) => row.angle ?? DEFAULT_MOONBOARD_IMPORT_ANGLE))].sort(
    (first, second) => first - second,
  );

  return {
    username: data.user.username ?? data.user.setterName ?? '',
    rows: data.logs.length,
    sends,
    flashes,
    attempts,
    projects,
    fails,
    angles: angles.length > 0 ? angles : [DEFAULT_MOONBOARD_IMPORT_ANGLE],
  };
}

export function parseMoonBoardExportCsv(csv: string, options?: MoonBoardCsvParseOptions): ParsedMoonBoardExportResult {
  const rows = parseCsvRows(csv.replace(/^\uFEFF/, ''));
  const inspection = inspectCsvRows(rows, options?.headerRowIndex);
  if (options?.headerRowIndex == null && options?.columns == null && inspection.kind !== 'logbook') {
    throw new Error('missing_moonboard_log_header');
  }
  const headerIndex = inspection.headerRowIndex;
  const columns = validateColumnIndexes(options?.columns ?? inspection.columns, inspection.headers.length);
  requireColumns(columns, REQUIRED_COLUMNS);
  if (columns.problemId == null && columns.name == null) throw new Error('missing_problem_column');

  const user: MoonBoardExportUser = {};
  for (const row of rows.slice(0, headerIndex)) {
    const mappedKey = USER_METADATA_KEYS[normalizeMetadataKey(row[0] ?? '')];
    const value = (row[1] ?? '').trim();
    if (mappedKey && value && value.toLowerCase() !== 'null' && value !== '-') {
      user[mappedKey] = value;
    }
  }

  const logs: MoonBoardExportLogRow[] = [];
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.every((value) => value.trim() === '')) continue;

    const lineNumber = rowIndex + 1;
    const problemId = parseOptionalInteger(cellAt(row, columns.problemId), 'problem_id', lineNumber);
    const name = cellAt(row, columns.name);
    const setter = cellAt(row, columns.setter);
    const setup = cellAt(row, columns.setup);
    const angle = parseAngle(cellAt(row, columns.configuration), lineNumber);
    const isBenchmark = parseBenchmark(cellAt(row, columns.benchmark));
    const comment = cellAt(row, columns.comment);
    const grade = cellAt(row, columns.grade).toUpperCase();
    const tries = cellAt(row, columns.tries);
    const attempts = parseOptionalInteger(cellAt(row, columns.attempts), 'attempts', lineNumber) ?? 0;
    const rating = parseOptionalRating(cellAt(row, columns.rating), lineNumber);
    const date = cellAt(row, columns.date);

    if (problemId == null && !name) throw new Error(`missing_problem_line_${lineNumber}`);
    if (!grade) throw new Error(`missing_grade_line_${lineNumber}`);
    if (!tries) throw new Error(`missing_tries_line_${lineNumber}`);
    if (!date) throw new Error(`missing_date_line_${lineNumber}`);

    logs.push({
      lineNumber,
      ...(problemId != null ? { problemId } : {}),
      ...(name ? { name } : {}),
      ...(setter ? { setter } : {}),
      ...(setup ? { setup } : {}),
      ...(angle != null ? { angle } : {}),
      ...(isBenchmark != null ? { isBenchmark } : {}),
      ...(comment ? { comment } : {}),
      grade,
      tries,
      attempts,
      rating,
      date,
    });
  }

  const data: StrippedMoonBoardExportData = { user, logs };
  return {
    data,
    preview: buildPreview(data),
  };
}

/**
 * Reads problem references only. These rows never become logbook entries or
 * new climbs: the backend must match them to its existing catalogue.
 */
export function parseMoonBoardCollectionCsv(
  csv: string,
  options?: MoonBoardCsvParseOptions,
  includeInactive = false,
): ParsedMoonBoardCollectionResult {
  const records = parseCsvRows(csv.replace(/^\uFEFF/, ''));
  const inspection = inspectCsvRows(records, options?.headerRowIndex);
  const columns = validateColumnIndexes(options?.columns ?? inspection.columns, inspection.headers.length);
  requireColumns(columns, ['name', 'grade']);

  const rows: MoonBoardCollectionRow[] = [];
  let excluded = 0;
  for (let rowIndex = inspection.headerRowIndex + 1; rowIndex < records.length; rowIndex += 1) {
    const record = records[rowIndex];
    if (isBlankRow(record)) continue;
    const lineNumber = rowIndex + 1;
    const active = parseBenchmark(cellAt(record, columns.active));
    const deleted = cellAt(record, columns.deleted);
    const isDeleted =
      deleted !== '' && deleted.toLowerCase() !== 'null' && deleted !== '-' && parseBenchmark(deleted) !== false;
    if (isDeleted || (!includeInactive && active === false)) {
      excluded += 1;
      continue;
    }

    const name = cellAt(record, columns.name);
    const grade = cellAt(record, columns.grade).toUpperCase();
    const setter = cellAt(record, columns.setter);
    if (!name) throw new Error(`missing_name_line_${lineNumber}`);
    if (!grade) throw new Error(`missing_grade_line_${lineNumber}`);
    rows.push({ lineNumber, name, grade, ...(setter ? { setter } : {}) });
  }
  return { rows, excluded };
}
