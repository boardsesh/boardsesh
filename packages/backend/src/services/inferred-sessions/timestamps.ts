/** climbed_at is a PostgreSQL timestamp without time zone, stored as UTC. */
export function parseClimbedAt(climbedAt: string): Date {
  const normalized = climbedAt.replace(' ', 'T');
  const parsed = new Date(/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(normalized) ? normalized : `${normalized}Z`);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid climb timestamp');
  return parsed;
}
