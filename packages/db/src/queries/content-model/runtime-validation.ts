export type ValidationErrorFactory = (message: string) => Error;

export interface RecordValidator {
  record(value: unknown, message?: string): Record<string, unknown>;
  nonEmptyString(record: Record<string, unknown>, field: string): string;
  finiteNumber(record: Record<string, unknown>, field: string): number;
  integer(record: Record<string, unknown>, field: string): number;
  boolean(record: Record<string, unknown>, field: string): boolean;
  nullableFiniteNumber(record: Record<string, unknown>, field: string): number | null;
  optionalFiniteNumber(record: Record<string, unknown>, field: string): number | null | undefined;
  optionalString(record: Record<string, unknown>, field: string): string | null | undefined;
}

/**
 * Build small runtime readers for untrusted JSON/JSONB records while leaving
 * each caller in control of its artifact-specific error prefix.
 */
export function createRecordValidator(errorFactory: ValidationErrorFactory): RecordValidator {
  const fail = (message: string): never => {
    throw errorFactory(message);
  };

  return {
    record(value, message = 'expected a JSON object') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return fail(message);
      }
      return value as Record<string, unknown>;
    },
    nonEmptyString(record, field) {
      const fieldValue = record[field];
      if (typeof fieldValue !== 'string' || fieldValue.length === 0) {
        return fail(`${field} must be a non-empty string`);
      }
      return fieldValue;
    },
    finiteNumber(record, field) {
      const fieldValue = record[field];
      if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
        return fail(`${field} must be a finite number`);
      }
      return fieldValue;
    },
    integer(record, field) {
      const fieldValue = record[field];
      if (typeof fieldValue !== 'number' || !Number.isInteger(fieldValue)) {
        return fail(`${field} must be an integer`);
      }
      return fieldValue;
    },
    boolean(record, field) {
      const fieldValue = record[field];
      if (typeof fieldValue !== 'boolean') {
        return fail(`${field} must be a boolean`);
      }
      return fieldValue;
    },
    nullableFiniteNumber(record, field) {
      const fieldValue = record[field];
      if (fieldValue === null) return null;
      if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
        return fail(`${field} must be a finite number or null`);
      }
      return fieldValue;
    },
    optionalFiniteNumber(record, field) {
      const fieldValue = record[field];
      if (fieldValue === undefined || fieldValue === null) return fieldValue;
      if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
        return fail(`${field} must be a finite number, null, or omitted`);
      }
      return fieldValue;
    },
    optionalString(record, field) {
      const fieldValue = record[field];
      if (fieldValue === undefined || fieldValue === null) return fieldValue;
      if (typeof fieldValue !== 'string') {
        return fail(`${field} must be a string, null, or omitted`);
      }
      return fieldValue;
    },
  };
}
