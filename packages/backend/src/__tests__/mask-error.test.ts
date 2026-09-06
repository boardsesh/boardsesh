/**
 * Tests for the targeted graphql-yoga maskError (issues #3183 / #3603).
 *
 * The mask sanitizes ONLY raw database errors — drizzle's "Failed query: ..."
 * wrapper or anything carrying a PostgresError code — so internal SQL never
 * reaches clients, while every other error (including intentional GraphQLErrors
 * with a stable extensions.code) passes through untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GraphQLError } from 'graphql';
import { isDatabaseLeakError, maskDatabaseError } from '../graphql/mask-error';
import { markErrorReported, wasErrorReported } from '../utils/sentry-dedupe';

const { sentryCaptureMock } = vi.hoisted(() => ({ sentryCaptureMock: vi.fn() }));
vi.mock('@sentry/node', () => ({ captureException: sentryCaptureMock }));

function makePgError(code: string): Error {
  return Object.assign(new Error('canceling statement due to statement timeout'), { code });
}

function makeDrizzleError(cause: Error): Error {
  return Object.assign(new Error('Failed query: select "id" from "users" where "users"."id" = $1'), { cause });
}

describe('isDatabaseLeakError', () => {
  it('flags a bare drizzle "Failed query:" error', () => {
    expect(isDatabaseLeakError(makeDrizzleError(makePgError('57014')))).toBe(true);
  });

  it('flags a located GraphQLError wrapping a drizzle error', () => {
    const drizzle = makeDrizzleError(makePgError('40P01'));
    const located = new GraphQLError(drizzle.message, { originalError: drizzle });
    expect(isDatabaseLeakError(located)).toBe(true);
  });

  it('flags a bare PostgresError by its code even without the SQL prefix', () => {
    expect(isDatabaseLeakError(makePgError('23505'))).toBe(true);
  });

  it('does not flag an intentional GraphQLError with an extensions code', () => {
    expect(isDatabaseLeakError(new GraphQLError('Rate limited', { extensions: { code: 'RATE_LIMITED' } }))).toBe(false);
  });

  it('does not flag a plain resolver Error', () => {
    expect(isDatabaseLeakError(new Error('Board not found'))).toBe(false);
  });
});

describe('maskDatabaseError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces a DB-cause error with a generic, SQL-free GraphQLError', () => {
    const pgError = makePgError('57014');
    const drizzle = makeDrizzleError(pgError);
    const located = new GraphQLError(drizzle.message, { originalError: drizzle });

    const masked = maskDatabaseError(located);

    expect(masked).toBeInstanceOf(GraphQLError);
    expect(masked.message).not.toMatch(/select|Failed query|users/i);
    expect((masked as GraphQLError).extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    // An honest 503 on the wire (#4862): the mobile outbox drainer treats it as
    // "server unavailable, stop the cycle" instead of charging the queued write.
    expect((masked as GraphQLError).extensions?.http).toEqual({ status: 503 });

    // Captured the real pg cause with the code as a tag, and marked reported.
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    expect(sentryCaptureMock).toHaveBeenCalledWith(
      pgError,
      expect.objectContaining({ tags: expect.objectContaining({ source: 'graphql-yoga-mask', pgCode: '57014' }) }),
    );
    expect(wasErrorReported(located)).toBe(true);
  });

  it('does not re-capture an error already marked reported (idempotent / prior capture)', () => {
    // Guards the mask's own idempotency: if the same error passes through
    // maskError twice (envelop plugin + handleError), or a resolver already
    // captured and marked the raw DB error, the second pass must not re-report.
    const drizzle = makeDrizzleError(makePgError('57014'));
    markErrorReported(drizzle);

    maskDatabaseError(drizzle);

    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });

  it('passes an intentional GraphQLError through unchanged', () => {
    const intentional = new GraphQLError('Rate limited', { extensions: { code: 'RATE_LIMITED' } });

    const masked = maskDatabaseError(intentional);

    expect(masked).toBe(intentional);
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });

  it('passes a plain resolver Error through with its message intact', () => {
    const plain = new Error('Board not found');

    const masked = maskDatabaseError(plain);

    expect(masked).toBe(plain);
    expect(masked.message).toBe('Board not found');
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });
});

/**
 * #4105: the DSM-exhaustion issue could not be diagnosed because the mask
 * reported only `unwrapCause(error)` — the bare PostgresError — so every
 * resolver's DB failures collapsed into one anonymous Sentry issue with no SQL
 * and no field path. These assert the evidence is attached to the event while
 * the client-facing message stays SQL-free (#3183).
 */
describe('maskDatabaseError diagnostic context (#4105)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function captureOptions() {
    return sentryCaptureMock.mock.calls[0][1] as {
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
    };
  }

  it('tags the GraphQL field path so the offending resolver is named', () => {
    const drizzle = makeDrizzleError(makePgError('53100'));
    const located = new GraphQLError(drizzle.message, { originalError: drizzle, path: ['searchClimbs', 'totalCount'] });

    maskDatabaseError(located);

    expect(captureOptions().tags?.graphqlPath).toBe('searchClimbs.totalCount');
  });

  it('attaches the drizzle SQL that unwrapCause drops', () => {
    const drizzle = makeDrizzleError(makePgError('53100'));
    const located = new GraphQLError(drizzle.message, { originalError: drizzle, path: ['setterStats'] });

    maskDatabaseError(located);

    expect(captureOptions().extra?.failedQuery).toBe(drizzle.message);
  });

  it('still reports the pg cause itself, so the existing issue grouping is unchanged', () => {
    // Sentry fingerprints on the captured exception, not on tags/extra. Capturing
    // the cause (not the wrapper) is what keeps BOARDSESH-AK's history continuous.
    const pgError = makePgError('53100');
    const located = new GraphQLError('boom', { originalError: makeDrizzleError(pgError), path: ['trendingFeed'] });

    maskDatabaseError(located);

    expect(sentryCaptureMock).toHaveBeenCalledWith(pgError, expect.anything());
  });

  it('never leaks the SQL to the client even though it is on the Sentry event', () => {
    const drizzle = makeDrizzleError(makePgError('53100'));
    const located = new GraphQLError(drizzle.message, { originalError: drizzle, path: ['sessionGroupedFeed'] });

    const masked = maskDatabaseError(located);

    expect(captureOptions().extra?.failedQuery).toContain('select');
    expect(masked.message).toBe('Something went wrong on our end. Please try again.');
    expect(JSON.stringify(masked)).not.toMatch(/select|Failed query/i);
  });

  it('truncates a pathological query so the event cannot be dropped for size', () => {
    const huge = Object.assign(new Error(`Failed query: select * from t where id in (${'1,'.repeat(5000)})`), {
      cause: makePgError('53100'),
    });

    maskDatabaseError(huge);

    expect((captureOptions().extra?.failedQuery as string).length).toBe(2000);
  });

  it('omits the path tag for an error that never reached graphql-js', () => {
    maskDatabaseError(makeDrizzleError(makePgError('53100')));

    expect(captureOptions().tags).not.toHaveProperty('graphqlPath');
  });
});
