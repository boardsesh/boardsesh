type ErrorRecord = Record<string, unknown>;

function asErrorRecord(error: unknown): ErrorRecord | null {
  return typeof error === 'object' && error !== null ? (error as ErrorRecord) : null;
}

// drizzle-orm >= 0.44 wraps driver failures in a DrizzleQueryError whose
// `cause` holds the original PostgresError, so the code/constraint fields no
// longer live on the thrown error itself. Walk the cause chain (bounded, in
// case of cycles) so unique-violation race handlers keep matching.
function* errorChain(error: unknown): Generator<ErrorRecord> {
  let currentRecord = asErrorRecord(error);
  let depth = 0;
  while (currentRecord && depth < 5) {
    yield currentRecord;
    currentRecord = asErrorRecord(currentRecord.cause);
    depth += 1;
  }
}

export function getPostgresErrorCode(error: unknown): string | undefined {
  for (const errorRecord of errorChain(error)) {
    if (typeof errorRecord.code === 'string') return errorRecord.code;
  }
  return undefined;
}

export function getPostgresConstraintName(error: unknown): string | undefined {
  for (const errorRecord of errorChain(error)) {
    const constraint = errorRecord.constraint ?? errorRecord.constraint_name;
    if (typeof constraint === 'string') return constraint;
  }
  return undefined;
}

export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  if (getPostgresErrorCode(error) !== '23505') return false;
  if (!constraintName) return true;
  return getPostgresConstraintName(error) === constraintName;
}
