/**
 * What a family may log about an error its runner swallowed: the error's class
 * and, for a database error, its SQLSTATE (42501 is a missing grant). Never the
 * message: a provider error's message can carry the provider's response.
 */
export function boundedErrorFields(error: unknown): { errorName: string; sqlState?: string } {
  const errorName = error instanceof Error ? error.name : typeof error;
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const candidate = (cause ?? error) as { code?: unknown } | undefined;
  const sqlState =
    candidate && typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)
      ? candidate.code
      : undefined;
  return sqlState ? { errorName, sqlState } : { errorName };
}
