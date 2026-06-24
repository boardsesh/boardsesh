import { DEFAULT_LOGBOOK_ANGLE_RANGE, DEFAULT_LOGBOOK_FILTERS, DEFAULT_LOGBOOK_SORT } from './defaults';
import type {
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
const VALID_SORT_PRESETS: LogbookSortPreset[] = ['recent', 'hardest'];

const sanitizeDifficulty = (value: unknown): number | '' =>
  typeof value === 'number' && Number.isFinite(value) ? value : '';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const sanitizeDate = (value: unknown): string => {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return '';
  // Reject shape-valid but impossible dates (e.g. month 13) — the picker never
  // produces them, but a corrupted/hand-edited payload might, and they'd flow
  // straight into the backend's date comparison.
  return Number.isNaN(new Date(`${value}T00:00:00`).getTime()) ? '' : value;
};

const sanitizeBoolean = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

function sanitizeAngleRange(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    return DEFAULT_LOGBOOK_ANGLE_RANGE;
  }
  const rawMin = typeof value[0] === 'number' ? value[0] : DEFAULT_LOGBOOK_ANGLE_RANGE[0];
  const rawMax = typeof value[1] === 'number' ? value[1] : DEFAULT_LOGBOOK_ANGLE_RANGE[1];
  const min = Math.max(0, Math.min(70, rawMin));
  const max = Math.max(min, Math.min(70, rawMax));
  return [min, max];
}

/**
 * Coerce untrusted persisted/serialized state into a valid filter object,
 * falling back to defaults per field. At least one of sends/attempts stays on,
 * and flash-only is cleared when sends are excluded (it only applies to sends).
 */
export function sanitizeLogbookFilters(value: unknown): LogbookFilterState {
  const source = value && typeof value === 'object' ? (value as Partial<LogbookFilterState>) : {};
  const sanitized: LogbookFilterState = {
    includeSends: sanitizeBoolean(source.includeSends, DEFAULT_LOGBOOK_FILTERS.includeSends),
    includeAttempts: sanitizeBoolean(source.includeAttempts, DEFAULT_LOGBOOK_FILTERS.includeAttempts),
    flashOnly: sanitizeBoolean(source.flashOnly, DEFAULT_LOGBOOK_FILTERS.flashOnly),
    minGrade: sanitizeDifficulty(source.minGrade),
    maxGrade: sanitizeDifficulty(source.maxGrade),
    fromDate: sanitizeDate(source.fromDate),
    toDate: sanitizeDate(source.toDate),
    angleRange: sanitizeAngleRange(source.angleRange),
    benchmarkOnly: sanitizeBoolean(source.benchmarkOnly, DEFAULT_LOGBOOK_FILTERS.benchmarkOnly),
  };
  if (!sanitized.includeSends && !sanitized.includeAttempts) {
    sanitized.includeSends = true;
  }
  if (!sanitized.includeSends) {
    sanitized.flashOnly = false;
  }
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
