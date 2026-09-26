import type { ErrorEvent, Event, EventHint } from '@sentry/nextjs';

export const POSTGRES_TOO_MANY_CONNECTIONS_CODE = '53300';

const MAX_CAUSE_DEPTH = 8;
const POSTGRES_SQLSTATE_CLASSES = new Set([
  '00',
  '01',
  '02',
  '03',
  '08',
  '09',
  '0A',
  '0B',
  '0F',
  '0L',
  '0P',
  '0Z',
  '20',
  '21',
  '22',
  '23',
  '24',
  '25',
  '26',
  '27',
  '28',
  '2B',
  '2D',
  '2F',
  '34',
  '38',
  '39',
  '3B',
  '3D',
  '3F',
  '40',
  '42',
  '44',
  '53',
  '54',
  '55',
  '57',
  '58',
  '72',
  'F0',
  'HV',
  'P0',
  'XX',
]);

type ErrorWithCause = {
  cause?: unknown;
  code?: unknown;
};

function asErrorWithCause(candidate: unknown): ErrorWithCause | null {
  if ((typeof candidate !== 'object' && typeof candidate !== 'function') || candidate === null) return null;
  return candidate as ErrorWithCause;
}

/**
 * Finds a PostgreSQL SQLSTATE without assuming the driver error is the value
 * Sentry received. Drizzle wraps postgres.js failures in `cause`, and other
 * request layers can add more wrappers, so walk a short cycle-safe chain.
 */
export function findPostgresErrorCode(error: unknown): string | null {
  const visited = new Set<ErrorWithCause>();
  let candidate = asErrorWithCause(error);

  for (let depth = 0; candidate && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (visited.has(candidate)) return null;
    visited.add(candidate);

    if (
      typeof candidate.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(candidate.code) &&
      POSTGRES_SQLSTATE_CLASSES.has(candidate.code.slice(0, 2))
    ) {
      return candidate.code;
    }
    candidate = asErrorWithCause(candidate.cause);
  }

  return null;
}

/** Adds stable Sentry tags used by the production connection-exhaustion alert. */
export function tagPostgresError(event: ErrorEvent, hint: EventHint): ErrorEvent;
export function tagPostgresError(event: Event, hint: EventHint): Event;
export function tagPostgresError(event: Event, hint: EventHint): Event {
  const postgresErrorCode = findPostgresErrorCode(hint.originalException);
  if (!postgresErrorCode) return event;

  return {
    ...event,
    tags: {
      ...event.tags,
      'postgres.error_code': postgresErrorCode,
      ...(postgresErrorCode === POSTGRES_TOO_MANY_CONNECTIONS_CODE ? { 'postgres.resource_exhaustion': 'true' } : {}),
    },
  };
}
