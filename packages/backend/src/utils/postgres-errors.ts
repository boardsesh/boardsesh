type ErrorRecord = Record<string, unknown>;

function asErrorRecord(error: unknown): ErrorRecord | null {
  return typeof error === 'object' && error !== null ? (error as ErrorRecord) : null;
}

export function getPostgresErrorCode(error: unknown): string | undefined {
  const errorRecord = asErrorRecord(error);
  const code = errorRecord?.code;
  return typeof code === 'string' ? code : undefined;
}

export function getPostgresConstraintName(error: unknown): string | undefined {
  const errorRecord = asErrorRecord(error);
  const constraint = errorRecord?.constraint ?? errorRecord?.constraint_name;
  return typeof constraint === 'string' ? constraint : undefined;
}

export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  if (getPostgresErrorCode(error) !== '23505') return false;
  if (!constraintName) return true;
  return getPostgresConstraintName(error) === constraintName;
}
