import { describe, expect, it } from 'vite-plus/test';
import type { Event, EventHint } from '@sentry/nextjs';
import { findPostgresErrorCode, tagPostgresError } from '../postgres-error-tags';

describe('Postgres Sentry tags', () => {
  it('finds a postgres.js SQLSTATE through Drizzle cause wrappers', () => {
    const postgresError = Object.assign(new Error('remaining connection slots are reserved'), { code: '53300' });
    const drizzleError = Object.assign(new Error('Failed query'), { cause: postgresError });

    expect(findPostgresErrorCode(drizzleError)).toBe('53300');
  });

  it('ignores non-Postgres codes and cycle-safe cause chains', () => {
    const cyclicError = Object.assign(new Error('cycle'), { code: 'ECONNRESET', cause: undefined as unknown });
    cyclicError.cause = cyclicError;

    expect(findPostgresErrorCode(cyclicError)).toBeNull();
  });

  it('leaves events unchanged when originalException is null or undefined', () => {
    const event: Event = { tags: { route: 'climb-view' } };

    expect(tagPostgresError(event, { originalException: null })).toBe(event);
    expect(tagPostgresError(event, { originalException: undefined })).toBe(event);
  });

  it('tags 53300 events while preserving existing tags', () => {
    const event: Event = { tags: { route: 'climb-view' } };
    const hint: EventHint = {
      originalException: Object.assign(new Error('too many clients'), { code: '53300' }),
    };

    expect(tagPostgresError(event, hint).tags).toEqual({
      route: 'climb-view',
      'postgres.error_code': '53300',
      'postgres.resource_exhaustion': 'true',
    });
  });

  it('tags other PostgreSQL errors without calling them resource exhaustion', () => {
    const event = tagPostgresError({}, { originalException: { code: '42P01' } });

    expect(event.tags).toEqual({ 'postgres.error_code': '42P01' });
  });

  it('tags the PostgreSQL raise-exception SQLSTATE P0001 without resource exhaustion', () => {
    const event = tagPostgresError({}, { originalException: { code: 'P0001' } });

    expect(event.tags).toEqual({ 'postgres.error_code': 'P0001' });
  });
});
