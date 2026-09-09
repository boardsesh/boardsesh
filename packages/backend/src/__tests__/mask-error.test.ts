/**
 * Tests for the targeted graphql-yoga maskError (issues #3183 / #3603).
 *
 * The mask sanitizes ONLY raw database errors — drizzle's "Failed query: ..."
 * wrapper or anything carrying a PostgresError code — so internal SQL never
 * reaches clients, while every other error (including intentional GraphQLErrors
 * with a stable extensions.code) passes through untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GraphQLError, Kind, parse, type FieldNode } from 'graphql';
import {
  databaseErrorFingerprint,
  isDatabaseLeakError,
  isDatabaseUnavailableCode,
  maskDatabaseError,
} from '../graphql/mask-error';
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
    // 57014 (statement timeout) is a verdict on this one statement, not an
    // outage, so it keeps the plain masked 200 — no http status override.
    expect((masked as GraphQLError).extensions?.http).toBeUndefined();

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
describe('maskDatabaseError http status (#4862)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    '08006',
    '08001',
    '53300',
    '57P01',
    '57P04',
    'CONNECT_TIMEOUT',
    'ECONNREFUSED',
    'ECONNABORTED',
    'EPIPE',
    'EAI_AGAIN',
  ])('answers a connection-class failure (%s) with an honest 503', (code) => {
    const drizzle = makeDrizzleError(makePgError(code));
    const masked = maskDatabaseError(new GraphQLError(drizzle.message, { originalError: drizzle }));
    expect((masked as GraphQLError).extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    // graphql-yoga turns this into the response status. The mobile outbox
    // drainer reads a 503 as "server unavailable, end the cycle" instead of
    // charging the queued write, and the client fix for the masked 200 shape
    // lands separately in the #4862 mobile PR.
    expect((masked as GraphQLError).extensions?.http).toEqual({ status: 503 });
    expect(masked.message).not.toMatch(/select|Failed query|users/i);
  });

  it.each(['23505', '23503', '22P02', '42703', '40P01', '57014'])(
    'keeps a per-statement verdict (%s) on the masked 200 so clients can still give up on it',
    (code) => {
      const drizzle = makeDrizzleError(makePgError(code));
      const masked = maskDatabaseError(new GraphQLError(drizzle.message, { originalError: drizzle }));
      expect((masked as GraphQLError).extensions?.code).toBe('INTERNAL_SERVER_ERROR');
      expect((masked as GraphQLError).extensions?.http).toBeUndefined();
    },
  );

  it('classifies codes without a driver error in the way', () => {
    expect(isDatabaseUnavailableCode('08P01')).toBe(true);
    expect(isDatabaseUnavailableCode('53200')).toBe(true);
    expect(isDatabaseUnavailableCode('ENOTFOUND')).toBe(true);
    expect(isDatabaseUnavailableCode('23505')).toBe(false);
    expect(isDatabaseUnavailableCode(undefined)).toBe(false);
  });
});

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

  it('tags the response path so the exact failing position is locatable', () => {
    const drizzle = makeDrizzleError(makePgError('53100'));
    const located = new GraphQLError(drizzle.message, { originalError: drizzle, path: ['searchClimbs', 'totalCount'] });

    maskDatabaseError(located);

    expect(captureOptions().tags?.graphqlResponsePath).toBe('searchClimbs.totalCount');
  });

  it('attaches the drizzle SQL that unwrapCause drops', () => {
    const drizzle = makeDrizzleError(makePgError('53100'));
    const located = new GraphQLError(drizzle.message, { originalError: drizzle, path: ['setterStats'] });

    maskDatabaseError(located);

    expect(captureOptions().extra?.failedQuery).toBe(drizzle.message);
  });

  it('still reports the pg cause itself, not the drizzle wrapper', () => {
    // The event must carry the real PostgresError so its type, code and message
    // are the pg ones. Grouping no longer rides on that choice — an explicit
    // fingerprint decides it now (see the #4737 block below).
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

  it('omits both field tags for an error that never reached graphql-js', () => {
    maskDatabaseError(makeDrizzleError(makePgError('53100')));

    expect(captureOptions().tags).not.toHaveProperty('graphqlResponsePath');
    expect(captureOptions().tags).not.toHaveProperty('graphqlField');
  });
});

/**
 * #4737: with no explicit fingerprint, Sentry grouped on the captured exception —
 * always a PostgresError from the same two postgres.js frames — so every database
 * failure in the service landed in one issue (BOARDSESH-AK). Measured on that
 * issue over 90d it held 34 distinct (pgCode, field) pairs: 585 events of 53100
 * (disk-full) beside 6 of 42703 (undefined column). Sentry titled the whole
 * bucket from a 42703 sample, so the issue read as "presence_seq column missing,
 * 32 users" when the 32 users were the disk-full failures and the six 42703
 * events were one developer's local backend leaking as `environment: production`.
 *
 * The grouping key must split on cause, stay stable per cause, AND be bounded by
 * things the server controls. That last one is why these build their errors from
 * REAL parsed AST nodes: `GraphQLError.path` is made of response keys, so it
 * carries the client's alias, and a fingerprint keyed on it would let anyone mint
 * unlimited Sentry issues by rotating aliases — strictly worse than the single
 * bucket this replaces.
 */
describe('maskDatabaseError issue grouping (#4737)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function pgErrorWith(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
  }

  /**
   * The FieldNode graphql-js itself produces for `query`, so these tests exercise
   * the real AST shape rather than a hand-rolled stand-in. `{ zzAlias: gym }`
   * yields a node whose `name.value` is `gym` and whose `alias.value` is
   * `zzAlias` — the distinction the fingerprint depends on.
   */
  function fieldNodeFor(query: string): FieldNode {
    const [operation] = parse(query).definitions;
    if (operation.kind !== Kind.OPERATION_DEFINITION) throw new Error('expected an operation');
    const [selection] = operation.selectionSet.selections;
    if (selection.kind !== Kind.FIELD) throw new Error('expected a field selection');
    return selection;
  }

  type LocatedCase = { code: string; query: string; path?: (string | number)[]; message?: string };

  function fingerprintFor({ code, query, path, message = 'boom' }: LocatedCase): string[] {
    sentryCaptureMock.mockClear();
    const drizzle = makeDrizzleError(pgErrorWith(code, message));
    const node = fieldNodeFor(query);
    maskDatabaseError(
      new GraphQLError(drizzle.message, {
        originalError: drizzle,
        nodes: [node],
        path: path ?? [node.alias?.value ?? node.name.value],
      }),
    );
    const { fingerprint } = sentryCaptureMock.mock.calls[0][1] as { fingerprint?: string[] };
    expect(fingerprint).toBeDefined();
    return fingerprint as string[];
  }

  it('gives one resolver ONE key however the client aliases it', () => {
    // The regression that matters: response keys are client-chosen, so a
    // path-derived key would open a separate Sentry issue per alias and let a
    // client fragment the project without limit.
    const plain = fingerprintFor({ code: '53100', query: '{ similarClimbs { id } }' });
    const aliased = fingerprintFor({ code: '53100', query: '{ zzArbitraryAlias: similarClimbs { id } }' });
    const otherAlias = fingerprintFor({ code: '53100', query: '{ another_one_42: similarClimbs { id } }' });

    expect(aliased).toEqual(plain);
    expect(otherAlias).toEqual(plain);
    // And the key names the schema field, not whatever the client typed.
    expect(plain).toEqual(['graphql-yoga-mask', '53100', 'similarClimbs']);
  });

  it('is not fooled by an alias that impersonates another resolver', () => {
    // `{ mySmartPlaylistCounts: similarClimbs }` is a legal query. A path-derived
    // key would file it against the wrong resolver's issue.
    const impersonating = fingerprintFor({ code: '53100', query: '{ mySmartPlaylistCounts: similarClimbs { id } }' });
    const genuine = fingerprintFor({ code: '53100', query: '{ mySmartPlaylistCounts { id } }' });

    expect(impersonating).not.toEqual(genuine);
    expect(impersonating).toEqual(['graphql-yoga-mask', '53100', 'similarClimbs']);
  });

  it('tags the schema field and the alias-bearing path separately', () => {
    sentryCaptureMock.mockClear();
    const drizzle = makeDrizzleError(pgErrorWith('53100', 'boom'));
    maskDatabaseError(
      new GraphQLError(drizzle.message, {
        originalError: drizzle,
        nodes: [fieldNodeFor('{ zzArbitraryAlias: similarClimbs { id } }')],
        path: ['zzArbitraryAlias'],
      }),
    );
    const { tags } = sentryCaptureMock.mock.calls[0][1] as { tags?: Record<string, string> };

    // Resolver identity is the schema name; the response path keeps the alias so
    // one event can still be traced back to the exact query that sent it.
    expect(tags?.graphqlField).toBe('similarClimbs');
    expect(tags?.graphqlResponsePath).toBe('zzArbitraryAlias');
  });

  it('separates the undefined-column failure from the disk-full one that shared its issue', () => {
    // The exact pairing that produced #4737's false P2.
    const undefinedColumn = fingerprintFor({
      code: '42703',
      query: '{ board { id } }',
      message: 'column "presence_seq" does not exist',
    });
    const diskFull = fingerprintFor({
      code: '53100',
      query: '{ userGroupedAscentsFeed { id } }',
      message:
        'could not resize shared memory segment "/PostgreSQL.523119486" to 1048576 bytes: No space left on device',
    });

    expect(undefinedColumn).not.toEqual(diskFull);
  });

  it('separates one code across resolvers, so a broken field cannot hide behind a busy one', () => {
    expect(fingerprintFor({ code: '53100', query: '{ similarClimbs { id } }' })).not.toEqual(
      fingerprintFor({ code: '53100', query: '{ mySmartPlaylistCounts { id } }' }),
    );
  });

  it('separates codes within one resolver', () => {
    expect(fingerprintFor({ code: '57P01', query: '{ board { id } }' })).not.toEqual(
      fingerprintFor({ code: '42703', query: '{ board { id } }' }),
    );
  });

  it('keeps one cause in one issue even though the message carries a fresh id every time', () => {
    // The shared-memory segment id and byte count differ on every occurrence. A
    // message-derived key would turn 585 disk-full events into 585 issues.
    const first = fingerprintFor({
      code: '53100',
      query: '{ similarClimbs { id } }',
      message:
        'could not resize shared memory segment "/PostgreSQL.523119486" to 1048576 bytes: No space left on device',
    });
    const second = fingerprintFor({
      code: '53100',
      query: '{ similarClimbs { id } }',
      message:
        'could not resize shared memory segment "/PostgreSQL.1376362192" to 4194304 bytes: No space left on device',
    });

    expect(first).toEqual(second);
  });

  it('ignores list position, so one bad row cannot mint an issue per array index', () => {
    const thirdRow = fingerprintFor({ code: '53100', query: '{ climb { id } }', path: ['userTicks', 3, 'climb'] });
    const ninetiethRow = fingerprintFor({ code: '53100', query: '{ climb { id } }', path: ['userTicks', 90, 'climb'] });

    expect(thirdRow).toEqual(ninetiethRow);
    expect(thirdRow).not.toContain('3');
    expect(thirdRow).not.toContain('90');
  });

  it('gives an error that never reached graphql-js a stable key instead of an undefined one', () => {
    sentryCaptureMock.mockClear();
    maskDatabaseError(makeDrizzleError(makePgError('53100')));
    const { fingerprint } = sentryCaptureMock.mock.calls[0][1] as { fingerprint?: string[] };

    expect(fingerprint).toEqual(['graphql-yoga-mask', '53100', 'unknown']);
  });

  it('falls back to an explicit unknown code rather than a hole in the key', () => {
    expect(databaseErrorFingerprint(undefined, 'board')).toEqual(['graphql-yoga-mask', 'unknown', 'board']);
    expect(databaseErrorFingerprint('53100', undefined)).toEqual(['graphql-yoga-mask', '53100', 'unknown']);
    expect(databaseErrorFingerprint('53100', '')).toEqual(['graphql-yoga-mask', '53100', 'unknown']);
  });
});
