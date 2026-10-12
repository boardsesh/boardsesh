import { BOARD_TYPE_LABELS } from '@boardsesh/board-constants';
import { DEFAULT_LOGBOOK_ANGLE_RANGE, DEFAULT_LOGBOOK_FILTERS, DEFAULT_LOGBOOK_SORT } from './defaults';
import { LOGBOOK_DATE_WINDOWS, parseLocalIsoDate } from './date-window';
import { repairLogbookStatus } from './status-segments';
import type {
  LogbookDateWindow,
  LogbookFilterState,
  LogbookSortDirection,
  LogbookSortField,
  LogbookSortPreset,
  LogbookSortState,
} from './types';

const VALID_SORT_FIELDS: Array<LogbookSortField | ''> = [
  '',
  'climbName',
  'loggedGrade',
  'consensusGrade',
  'date',
  'attemptCount',
];
const VALID_SORT_DIRECTIONS: LogbookSortDirection[] = ['asc', 'desc'];
const VALID_SORT_PRESETS: LogbookSortPreset[] = ['recent', 'hardest', 'easiest'];

/** Setter filters past this many are dropped (the picker never gets near it). */
export const MAX_LOGBOOK_SETTER_FILTERS = 20;
const MIN_QUALITY = 1;
const MAX_QUALITY = 5;
// Every board type the app knows (the label map covers SUPPORTED_BOARDS; a
// board-constants test pins that). The backend rejects any other value, so a
// stale or corrupted board would otherwise break the whole feed.
const KNOWN_BOARD_TYPES: ReadonlySet<string> = new Set(Object.keys(BOARD_TYPE_LABELS));

const sanitizeDifficulty = (value: unknown): number | '' =>
  typeof value === 'number' && Number.isFinite(value) ? value : '';

// Reject shape-valid but impossible dates (month 13, Feb 30): the picker never
// produces them, but a corrupted/hand-edited payload might, and Postgres throws
// on them in the backend's date comparison.
const sanitizeDate = (value: unknown): string => (typeof value === 'string' && parseLocalIsoDate(value) ? value : '');

const sanitizeBoolean = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

/**
 * A stored window, or the one an older payload implies: before the window
 * existed a picked from/to WAS the date filter, so it reads as Custom (keeping
 * the range); with neither it reads as Any time.
 */
function sanitizeDateWindow(value: unknown, fromDate: string, toDate: string): LogbookDateWindow {
  if (typeof value === 'string' && (LOGBOOK_DATE_WINDOWS as readonly string[]).includes(value)) {
    return value as LogbookDateWindow;
  }
  return fromDate || toDate ? 'custom' : 'any';
}

const sanitizeBoardType = (value: unknown): string =>
  typeof value === 'string' && KNOWN_BOARD_TYPES.has(value) ? value : '';

/** Positive integer layout ids, deduped and ascending (a stable query key). */
function sanitizeLayoutIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0);
  return Array.from(new Set(ids)).sort((left, right) => left - right);
}

/** Whole stars 1-5, or '' for any. Out-of-range numbers clamp to the scale. */
function sanitizeMinQuality(value: unknown): number | '' {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, Math.round(value)));
}

/** Trimmed, non-empty, de-duplicated setter usernames, first 20 kept. */
function sanitizeSetterUsernames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return Array.from(new Set(names)).slice(0, MAX_LOGBOOK_SETTER_FILTERS);
}

function sanitizeAngleRange(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    return DEFAULT_LOGBOOK_ANGLE_RANGE;
  }
  const rawMin = typeof value[0] === 'number' ? value[0] : DEFAULT_LOGBOOK_ANGLE_RANGE[0];
  const rawMax = typeof value[1] === 'number' ? value[1] : DEFAULT_LOGBOOK_ANGLE_RANGE[1];
  const min = Math.max(DEFAULT_LOGBOOK_ANGLE_RANGE[0], Math.min(DEFAULT_LOGBOOK_ANGLE_RANGE[1], rawMin));
  const max = Math.max(min, Math.min(DEFAULT_LOGBOOK_ANGLE_RANGE[1], rawMax));
  return [min, max];
}

/**
 * Coerce untrusted persisted/serialized state into a valid filter object,
 * falling back to defaults per field. At least one of sends/attempts stays on,
 * and flash-only is cleared when sends are excluded (it only applies to sends).
 * Payloads from before a field existed (no dateWindow, board, stars, setters)
 * read as that field's default, except a stored from/to, which reads as Custom.
 */
export function sanitizeLogbookFilters(value: unknown): LogbookFilterState {
  const source =
    value && typeof value === 'object' ? (value as Partial<Record<keyof LogbookFilterState, unknown>>) : {};
  const fromDate = sanitizeDate(source.fromDate);
  const toDate = sanitizeDate(source.toDate);
  const boardType = sanitizeBoardType(source.boardType);
  const sanitized: LogbookFilterState = {
    includeSends: sanitizeBoolean(source.includeSends, DEFAULT_LOGBOOK_FILTERS.includeSends),
    includeAttempts: sanitizeBoolean(source.includeAttempts, DEFAULT_LOGBOOK_FILTERS.includeAttempts),
    flashOnly: sanitizeBoolean(source.flashOnly, DEFAULT_LOGBOOK_FILTERS.flashOnly),
    minGrade: sanitizeDifficulty(source.minGrade),
    maxGrade: sanitizeDifficulty(source.maxGrade),
    dateWindow: sanitizeDateWindow(source.dateWindow, fromDate, toDate),
    fromDate,
    toDate,
    angleRange: sanitizeAngleRange(source.angleRange),
    benchmarkOnly: sanitizeBoolean(source.benchmarkOnly, DEFAULT_LOGBOOK_FILTERS.benchmarkOnly),
    boardType,
    // Layout ids only mean something inside one board type.
    layoutIds: boardType ? sanitizeLayoutIds(source.layoutIds) : [],
    minQuality: sanitizeMinQuality(source.minQuality),
    setterUsernames: sanitizeSetterUsernames(source.setterUsernames),
  };
  Object.assign(sanitized, repairLogbookStatus(sanitized));
  // Heal an inverted grade range (corrupted or migrated prefs). An un-swapped
  // min > max reaches the backend as `difficulty >= min AND <= max` and silently
  // returns nothing. (The angle range is already clamped to max >= min above.)
  if (
    typeof sanitized.minGrade === 'number' &&
    typeof sanitized.maxGrade === 'number' &&
    sanitized.minGrade > sanitized.maxGrade
  ) {
    [sanitized.minGrade, sanitized.maxGrade] = [sanitized.maxGrade, sanitized.minGrade];
  }
  // Same for a custom date range: ISO dates compare correctly as strings.
  if (sanitized.fromDate && sanitized.toDate && sanitized.fromDate > sanitized.toDate) {
    [sanitized.fromDate, sanitized.toDate] = [sanitized.toDate, sanitized.fromDate];
  }
  return sanitized;
}

/**
 * Coerce untrusted persisted/serialized state into a valid sort object. Each
 * field validates the actual value (not a defaulted one) so a missing or invalid
 * field falls back to the default rather than passing through as undefined.
 */
export function sanitizeLogbookSort(value: unknown): LogbookSortState {
  const source = value && typeof value === 'object' ? (value as Partial<LogbookSortState>) : {};
  return {
    mode: source.mode === 'custom' ? 'custom' : 'preset',
    preset: source.preset && VALID_SORT_PRESETS.includes(source.preset) ? source.preset : DEFAULT_LOGBOOK_SORT.preset,
    primaryField:
      source.primaryField && VALID_SORT_FIELDS.includes(source.primaryField)
        ? source.primaryField
        : DEFAULT_LOGBOOK_SORT.primaryField,
    primaryDirection:
      source.primaryDirection && VALID_SORT_DIRECTIONS.includes(source.primaryDirection)
        ? source.primaryDirection
        : DEFAULT_LOGBOOK_SORT.primaryDirection,
    // '' is a legitimate "no secondary sort" value, so allow it explicitly.
    secondaryField:
      source.secondaryField !== undefined && VALID_SORT_FIELDS.includes(source.secondaryField)
        ? source.secondaryField
        : DEFAULT_LOGBOOK_SORT.secondaryField,
    secondaryDirection:
      source.secondaryDirection && VALID_SORT_DIRECTIONS.includes(source.secondaryDirection)
        ? source.secondaryDirection
        : DEFAULT_LOGBOOK_SORT.secondaryDirection,
  };
}

/**
 * The filters as they should be written to storage. A from/to only means
 * something under the Custom window, so it is stored only there: an older app
 * build (an OTA rollback) has no window and would apply a leftover range under
 * "This month" or "Any time".
 */
export function logbookFiltersForStorage(filters: LogbookFilterState): LogbookFilterState {
  if (filters.dateWindow === 'custom') return filters;
  return { ...filters, fromDate: '', toDate: '' };
}
