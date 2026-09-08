/// <reference types="node" />

// The fixture contract itself: how a request becomes a key, what a manifest has
// to look like to be trusted, and the log grammar the capture gate reads. Every
// one of these is a silent-failure guard — a key that shifts with whitespace
// re-records the world on a formatter run, and a manifest field the validator
// skips is a fixture set that half-replays.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_SIZE_NOTE_BYTES,
  IGNORED_VARIABLE_PATHS,
  REDACTED_PER_RUN_VALUE,
  RE_RECORD_COMMAND,
  SCREENSHOT_BACKEND_LOG_PREFIX,
  canonicalJson,
  emptyManifest,
  findScreenshotBackendProblems,
  findSensitiveVariableKeys,
  fixtureSizeNote,
  formatScreenshotBackendLine,
  graphqlFixtureKey,
  normalizeDocument,
  parseScreenshotBackendLogLine,
  redactIgnoredVariablePaths,
  resolveOperationName,
  sortManifestEntries,
  sortedQueryString,
  staticFixtureKey,
  stripIgnoredVariablePaths,
  validateScreenshotFixtureManifest,
  variantCountNote,
  type ScreenshotBackendLogLine,
  type ScreenshotFixtureManifest,
} from '../lib/screenshot-fixtures';

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function validManifest(): ScreenshotFixtureManifest {
  return {
    formatVersion: 1,
    recordedAt: '2026-09-08T09:00:00Z',
    frozenNow: '2026-09-08T09:00:00Z',
    upstream: 'https://ws.boardsesh.com',
    accountEmail: 'shots@boardsesh.com',
    accountUserId: '11111111-2222-3333-4444-555555555555',
    flow: 'app-store',
    graphql: [
      {
        operationName: 'SyncTicks',
        documentHash: 'a'.repeat(64),
        variablesHash: 'b'.repeat(64),
        file: 'graphql/x.json',
      },
    ],
    static: [
      {
        path: '/static/avatars/marco.jpg',
        query: 'size=128&v=3',
        file: 'static/deadbeefdeadbeef.jpg',
        contentType: 'image/jpeg',
        bytes: 4096,
      },
    ],
  };
}

describe('normalizeDocument', () => {
  it('collapses every whitespace run to a single space and trims', () => {
    expect(normalizeDocument('\n  query Foo {\n    bar\n  }\n')).toBe('query Foo { bar }');
  });

  it('makes a reformatted document identical to the original', () => {
    const compact = 'query Foo($id: ID!) { climb(id: $id) { uuid name } }';
    const reflowed = `query Foo($id: ID!) {\n\tclimb(id: $id) {\n\t\tuuid\n\t\tname\n\t}\n}`;
    expect(normalizeDocument(reflowed)).toBe(normalizeDocument(compact));
  });
});

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ zebra: 1, alpha: { yak: 2, bison: 3 } })).toBe('{"alpha":{"bison":3,"yak":2},"zebra":1}');
  });

  it('drops undefined properties so an omitted argument and an absent one match', () => {
    expect(canonicalJson({ limit: 10, cursor: undefined })).toBe(canonicalJson({ limit: 10 }));
  });

  it('keeps null, and keeps array order', () => {
    expect(canonicalJson({ setIds: [3, 1, 2], layoutId: null })).toBe('{"layoutId":null,"setIds":[3,1,2]}');
  });

  it('canonicalises objects nested inside arrays', () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('renders a bare undefined as null rather than nothing', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('stripIgnoredVariablePaths', () => {
  it('documents only client-generated per-run values', () => {
    // The same APNs push token under all four names it is sent as: the two JS
    // operations and the two the Swift Live Activity module declares itself.
    expect(IGNORED_VARIABLE_PATHS).toEqual({
      RegisterActivityPushToken: ['token'],
      UnregisterActivityPushToken: ['token'],
      RegisterToken: ['token'],
      UnregisterToken: ['token'],
    });
  });

  it('removes a listed path without mutating the caller variables', () => {
    const variables = { token: 'device-abc', platform: 'ios' };
    expect(stripIgnoredVariablePaths('RegisterActivityPushToken', variables)).toEqual({ platform: 'ios' });
    expect(variables.token).toBe('device-abc');
  });

  it('tolerates a listed path the request never carried', () => {
    expect(stripIgnoredVariablePaths('RegisterActivityPushToken', { platform: 'ios' })).toEqual({ platform: 'ios' });
  });

  it('leaves operations with no ignore list untouched', () => {
    expect(stripIgnoredVariablePaths('SyncTicks', { token: 'kept' })).toEqual({ token: 'kept' });
  });

  it('walks a nested dot path, and leaves a request whose parent is missing alone', () => {
    // The shipped map has no nested path yet, so add one for the length of this
    // test — the walk itself is what needs covering, not today's entries.
    const mutableIgnorePaths = IGNORED_VARIABLE_PATHS as Record<string, readonly string[]>;
    mutableIgnorePaths.NestedOperation = ['input.deviceToken'];
    try {
      expect(stripIgnoredVariablePaths('NestedOperation', { input: { deviceToken: 'abc', platform: 'ios' } })).toEqual({
        input: { platform: 'ios' },
      });
      expect(stripIgnoredVariablePaths('NestedOperation', { input: null })).toEqual({ input: null });
      expect(stripIgnoredVariablePaths('NestedOperation', { other: 1 })).toEqual({ other: 1 });
    } finally {
      delete mutableIgnorePaths.NestedOperation;
    }
  });
});

describe('redactIgnoredVariablePaths', () => {
  it('replaces an ignored value in place, without mutating the caller variables', () => {
    const variables = { sessionId: 'session-1', token: 'apns-abc' };
    expect(redactIgnoredVariablePaths('RegisterToken', variables)).toEqual({
      sessionId: 'session-1',
      token: REDACTED_PER_RUN_VALUE,
    });
    expect(variables.token).toBe('apns-abc');
  });

  it('never invents a path the request did not carry', () => {
    expect(redactIgnoredVariablePaths('UnregisterToken', { sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1',
    });
  });

  it('leaves operations with no ignore list untouched', () => {
    expect(redactIgnoredVariablePaths('SyncTicks', { token: 'kept' })).toEqual({ token: 'kept' });
  });

  it('redacts the bytes while the key still strips them, so replay matches across runs', () => {
    const query = 'mutation RegisterToken($sessionId: ID!, $token: String!) { registerToken(id: $sessionId) { ok } }';
    const recorded = { sessionId: 'session-1', token: 'apns-run-1' };
    const replayed = { sessionId: 'session-1', token: 'apns-run-2' };
    expect(graphqlFixtureKey({ operationName: 'RegisterToken', query, variables: replayed }, sha256Hex)).toEqual(
      graphqlFixtureKey({ operationName: 'RegisterToken', query, variables: recorded }, sha256Hex),
    );
    expect(redactIgnoredVariablePaths('RegisterToken', recorded)).not.toMatchObject({ token: 'apns-run-1' });
  });
});

describe('graphqlFixtureKey', () => {
  const query = 'query SyncTicks($cursor: SyncCursorInput) { syncTicks(cursor: $cursor) { documents } }';

  it('is stable when only the document whitespace changes', () => {
    const compact = graphqlFixtureKey({ operationName: 'SyncTicks', query, variables: { limit: 500 } }, sha256Hex);
    const reflowed = graphqlFixtureKey(
      { operationName: 'SyncTicks', query: `\n  ${query.replace(/ /g, '\n  ')}\n`, variables: { limit: 500 } },
      sha256Hex,
    );
    expect(reflowed.documentHash).toBe(compact.documentHash);
    expect(reflowed.variablesHash).toBe(compact.variablesHash);
  });

  it('moves the document hash when the selection set changes', () => {
    const before = graphqlFixtureKey({ operationName: 'SyncTicks', query, variables: {} }, sha256Hex);
    const after = graphqlFixtureKey(
      { operationName: 'SyncTicks', query: query.replace('documents', 'documents hasMore'), variables: {} },
      sha256Hex,
    );
    expect(after.documentHash).not.toBe(before.documentHash);
    // The variables did not move, so replay still finds the fixture — and can
    // then say "document-changed" rather than "no-fixture".
    expect(after.variablesHash).toBe(before.variablesHash);
  });

  it('is stable across variable key order and treats absent variables as {}', () => {
    const ordered = graphqlFixtureKey({ operationName: 'SyncTicks', query, variables: { a: 1, b: 2 } }, sha256Hex);
    const reordered = graphqlFixtureKey({ operationName: 'SyncTicks', query, variables: { b: 2, a: 1 } }, sha256Hex);
    expect(reordered.variablesHash).toBe(ordered.variablesHash);
    expect(graphqlFixtureKey({ operationName: 'SyncTicks', query }, sha256Hex).variablesHash).toBe(
      graphqlFixtureKey({ operationName: 'SyncTicks', query, variables: {} }, sha256Hex).variablesHash,
    );
  });

  it('ignores the push token but not the platform', () => {
    const base = { operationName: 'RegisterActivityPushToken', query: 'mutation RegisterActivityPushToken { ok }' };
    const first = graphqlFixtureKey({ ...base, variables: { token: 'run-1', platform: 'ios' } }, sha256Hex);
    const second = graphqlFixtureKey({ ...base, variables: { token: 'run-2', platform: 'ios' } }, sha256Hex);
    const other = graphqlFixtureKey({ ...base, variables: { token: 'run-2', platform: 'android' } }, sha256Hex);
    expect(second.variablesHash).toBe(first.variablesHash);
    expect(other.variablesHash).not.toBe(first.variablesHash);
  });
});

describe('findSensitiveVariableKeys', () => {
  it('finds a top-level key, case-insensitively', () => {
    expect(findSensitiveVariableKeys({ Password: 'hunter2' })).toEqual(['Password']);
    expect(findSensitiveVariableKeys({ SECRET: 'x' })).toEqual(['SECRET']);
  });

  it('walks nested objects and arrays to any depth', () => {
    expect(findSensitiveVariableKeys({ input: { auth: { token: 'abc' } } })).toEqual(['token']);
    expect(findSensitiveVariableKeys({ accounts: [{ password: 'a' }, { password: 'b' }] })).toEqual(['password']);
  });

  it('matches a snake_case-prefixed and a plural form', () => {
    expect(findSensitiveVariableKeys({ auth_token: 'abc' })).toEqual(['auth_token']);
    expect(findSensitiveVariableKeys({ credentials: {} })).toEqual(['credentials']);
  });

  it('exempts a key already holding the per-run redaction, but nothing else', () => {
    // The push-token mutations are recorded with their token replaced; only
    // that exact literal is exempt, so a real secret beside it still refuses.
    expect(findSensitiveVariableKeys({ sessionId: 'a', token: REDACTED_PER_RUN_VALUE })).toEqual([]);
    expect(findSensitiveVariableKeys({ token: REDACTED_PER_RUN_VALUE, password: 'hunter2' })).toEqual(['password']);
    expect(findSensitiveVariableKeys({ token: `${REDACTED_PER_RUN_VALUE} apns-abc` })).toEqual(['token']);
  });

  it('does not false-positive on a key that merely mentions one, like tokenCount', () => {
    expect(findSensitiveVariableKeys({ tokenCount: 3, credentialsExpiry: '2026-01-01', secretary: 'x' })).toEqual([]);
  });

  it('returns every distinct sensitive key, sorted, with no duplicates', () => {
    expect(findSensitiveVariableKeys({ password: 'a', nested: { password: 'b', token: 'c' } })).toEqual([
      'password',
      'token',
    ]);
  });

  it('is empty for variables with nothing sensitive, including null and primitives', () => {
    expect(findSensitiveVariableKeys({ limit: 10, cursor: null })).toEqual([]);
    expect(findSensitiveVariableKeys(null)).toEqual([]);
    expect(findSensitiveVariableKeys('just a string')).toEqual([]);
    expect(findSensitiveVariableKeys(undefined)).toEqual([]);
  });
});

describe('resolveOperationName', () => {
  it('prefers the explicit operationName field', () => {
    expect(resolveOperationName({ operationName: 'SyncTicks', query: 'query Other { ok }' })).toBe('SyncTicks');
  });

  it('falls back to the name declared in the document', () => {
    expect(resolveOperationName({ query: '\n  mutation SaveTick($input: SaveTickInput!) { ok }' })).toBe('SaveTick');
    expect(resolveOperationName({ query: 'subscription ClimbStatsUpdated { ok }' })).toBe('ClimbStatsUpdated');
  });

  it('is null for an anonymous document, an empty name, and a missing query', () => {
    expect(resolveOperationName({ query: '{ climbs { uuid } }' })).toBeNull();
    expect(resolveOperationName({ operationName: '', query: '{ ok }' })).toBeNull();
    expect(resolveOperationName({})).toBeNull();
  });

  it('rejects an operationName that is not a real GraphQL name, and falls back to the query', () => {
    // `graphqlFixturePath` builds a directory from this value, so a name like
    // this must never reach the return value — treated exactly like a missing
    // operationName, including falling back to a name the query itself declares.
    expect(resolveOperationName({ operationName: '../../escape', query: 'query Foo { ok }' })).toBe('Foo');
    expect(resolveOperationName({ operationName: '../../escape', query: '{ climbs { uuid } }' })).toBeNull();
    expect(resolveOperationName({ operationName: 'has space', query: '{ ok }' })).toBeNull();
    expect(resolveOperationName({ operationName: 'a/b', query: '{ ok }' })).toBeNull();
  });
});

describe('static keys', () => {
  it('sorts query parameters so parameter order cannot fork a key', () => {
    expect(sortedQueryString(new URLSearchParams('v=3&size=128'))).toBe('size=128&v=3');
    const first = staticFixtureKey('/static/avatars/a.jpg', new URLSearchParams('v=3&size=128'), sha256Hex);
    const second = staticFixtureKey('/static/avatars/a.jpg', new URLSearchParams('size=128&v=3'), sha256Hex);
    expect(second).toBe(first);
    expect(first).toHaveLength(16);
  });

  it('separates two paths that differ only in their query', () => {
    const small = staticFixtureKey('/static/avatars/a.jpg', new URLSearchParams('size=64'), sha256Hex);
    const large = staticFixtureKey('/static/avatars/a.jpg', new URLSearchParams('size=128'), sha256Hex);
    expect(large).not.toBe(small);
  });
});

describe('validateScreenshotFixtureManifest', () => {
  it('accepts a complete manifest', () => {
    const result = validateScreenshotFixtureManifest(validManifest());
    expect(result.ok).toBe(true);
  });

  const rejections: Array<[string, () => unknown, string]> = [
    ['a non-object', () => 'nope', 'manifest is not a JSON object'],
    ['a wrong formatVersion', () => ({ ...validManifest(), formatVersion: 2 }), 'formatVersion'],
    ['a missing recordedAt', () => ({ ...validManifest(), recordedAt: '' }), 'recordedAt'],
    ['a missing frozenNow', () => ({ ...validManifest(), frozenNow: undefined }), 'frozenNow'],
    ['a missing upstream', () => ({ ...validManifest(), upstream: 42 }), 'upstream'],
    ['a non-string accountEmail', () => ({ ...validManifest(), accountEmail: null }), 'accountEmail'],
    // Replay mints its synthetic jwt around this id, so a manifest without one
    // would sign the capture in as nobody.
    ['a missing accountUserId', () => ({ ...validManifest(), accountUserId: undefined }), 'accountUserId'],
    ['a non-string flow', () => ({ ...validManifest(), flow: 7 }), 'flow'],
    ['a non-array graphql', () => ({ ...validManifest(), graphql: {} }), 'graphql must be an array'],
    ['a non-array static', () => ({ ...validManifest(), static: {} }), 'static must be an array'],
    ['a graphql entry that is not an object', () => ({ ...validManifest(), graphql: ['x'] }), 'graphql[0]'],
    [
      'a graphql entry with no operationName',
      () => ({ ...validManifest(), graphql: [{ ...validManifest().graphql[0], operationName: '' }] }),
      'graphql[0].operationName',
    ],
    [
      'a graphql entry with no documentHash',
      () => ({ ...validManifest(), graphql: [{ ...validManifest().graphql[0], documentHash: undefined }] }),
      'graphql[0].documentHash',
    ],
    [
      'a graphql entry with no variablesHash',
      () => ({ ...validManifest(), graphql: [{ ...validManifest().graphql[0], variablesHash: 5 }] }),
      'graphql[0].variablesHash',
    ],
    [
      'a graphql entry with no file',
      () => ({ ...validManifest(), graphql: [{ ...validManifest().graphql[0], file: '' }] }),
      'graphql[0].file',
    ],
    [
      'a graphql entry whose file contains a ".." segment',
      () => ({
        ...validManifest(),
        graphql: [{ ...validManifest().graphql[0], file: 'graphql/../../escape.json' }],
      }),
      'graphql[0].file must not contain a ".." segment',
    ],
    [
      'a graphql entry whose file is an absolute path',
      () => ({ ...validManifest(), graphql: [{ ...validManifest().graphql[0], file: '/etc/passwd' }] }),
      'graphql[0].file must not be an absolute path',
    ],
    [
      'a graphql entry whose file contains a backslash',
      () => ({ ...validManifest(), graphql: [{ ...validManifest().graphql[0], file: 'graphql\\x.json' }] }),
      'graphql[0].file must not contain a backslash',
    ],
    [
      'a graphql entry whose file does not start with graphql/',
      () => ({ ...validManifest(), graphql: [{ ...validManifest().graphql[0], file: 'static/x.json' }] }),
      'graphql[0].file must start with "graphql/"',
    ],
    ['a static entry that is not an object', () => ({ ...validManifest(), static: [7] }), 'static[0]'],
    [
      'a static entry with no path',
      () => ({ ...validManifest(), static: [{ ...validManifest().static[0], path: '' }] }),
      'static[0].path',
    ],
    [
      'a static entry with a non-string query',
      () => ({ ...validManifest(), static: [{ ...validManifest().static[0], query: null }] }),
      'static[0].query',
    ],
    [
      'a static entry with no file',
      () => ({ ...validManifest(), static: [{ ...validManifest().static[0], file: undefined }] }),
      'static[0].file',
    ],
    [
      'a static entry whose file contains a ".." segment',
      () => ({ ...validManifest(), static: [{ ...validManifest().static[0], file: 'static/../../escape.jpg' }] }),
      'static[0].file must not contain a ".." segment',
    ],
    [
      'a static entry whose file does not start with static/',
      () => ({ ...validManifest(), static: [{ ...validManifest().static[0], file: 'graphql/x.jpg' }] }),
      'static[0].file must start with "static/"',
    ],
    [
      'a static entry with no contentType',
      () => ({ ...validManifest(), static: [{ ...validManifest().static[0], contentType: '' }] }),
      'static[0].contentType',
    ],
    [
      'a static entry with fractional bytes',
      () => ({ ...validManifest(), static: [{ ...validManifest().static[0], bytes: 1.5 }] }),
      'static[0].bytes',
    ],
    [
      'a static entry with negative bytes',
      () => ({ ...validManifest(), static: [{ ...validManifest().static[0], bytes: -1 }] }),
      'static[0].bytes',
    ],
  ];

  it.each(rejections)('rejects %s and names the field', (_label, build, expectedReason) => {
    const result = validateScreenshotFixtureManifest(build());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(expectedReason);
  });
});

describe('emptyManifest / sortManifestEntries', () => {
  it('starts a recording from an empty, format-stamped manifest', () => {
    const manifest = emptyManifest({
      recordedAt: '2026-09-08T09:00:00Z',
      frozenNow: '2026-09-08T09:00:00Z',
      upstream: 'https://ws.boardsesh.com',
      accountEmail: '',
      accountUserId: '',
      flow: 'app-store',
    });
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.graphql).toEqual([]);
    expect(manifest.static).toEqual([]);
    expect(validateScreenshotFixtureManifest(manifest).ok).toBe(true);
  });

  it('orders graphql by operation then variables hash, and static by path then query', () => {
    const base = validManifest();
    const shuffled: ScreenshotFixtureManifest = {
      ...base,
      graphql: [
        { operationName: 'SyncTicks', documentHash: 'd', variablesHash: 'zz', file: 'graphql/SyncTicks/zz.json' },
        { operationName: 'Feed', documentHash: 'd', variablesHash: 'bb', file: 'graphql/Feed/bb.json' },
        { operationName: 'SyncTicks', documentHash: 'd', variablesHash: 'aa', file: 'graphql/SyncTicks/aa.json' },
      ],
      static: [
        { path: '/static/b.jpg', query: '', file: 'static/2.jpg', contentType: 'image/jpeg', bytes: 1 },
        { path: '/static/a.jpg', query: 'size=64', file: 'static/1.jpg', contentType: 'image/jpeg', bytes: 1 },
        { path: '/static/a.jpg', query: '', file: 'static/0.jpg', contentType: 'image/jpeg', bytes: 1 },
      ],
    };
    const sorted = sortManifestEntries(shuffled);
    expect(sorted.graphql.map((entry) => `${entry.operationName}/${entry.variablesHash}`)).toEqual([
      'Feed/bb',
      'SyncTicks/aa',
      'SyncTicks/zz',
    ]);
    expect(sorted.static.map((entry) => `${entry.path}?${entry.query}`)).toEqual([
      '/static/a.jpg?',
      '/static/a.jpg?size=64',
      '/static/b.jpg?',
    ]);
    // Non-destructive: re-recording must not shuffle the caller's own arrays.
    expect(shuffled.graphql[0].operationName).toBe('SyncTicks');
  });
});

describe('log grammar', () => {
  const grammarLines: Array<[string, ScreenshotBackendLogLine]> = [
    [
      'READY mode=replay port=8090 fixtures=/tmp/fx frozenNow=2026-09-08T09:00:00Z graphql=12 static=3',
      {
        event: 'ready',
        mode: 'replay',
        port: 8090,
        fixturesDir: '/tmp/fx',
        frozenNow: '2026-09-08T09:00:00Z',
        graphqlCount: 12,
        staticCount: 3,
      },
    ],
    [
      'HIT graphql SyncTicks 0123456789ab',
      { event: 'hit', kind: 'graphql', operationName: 'SyncTicks', hash12: '0123456789ab' },
    ],
    [
      'HIT static /static/avatars/a.jpg?size=64',
      { event: 'hit', kind: 'static', subject: '/static/avatars/a.jpg?size=64' },
    ],
    ['HIT auth credentials', { event: 'hit', kind: 'auth', route: 'credentials' }],
    ['HIT auth refresh', { event: 'hit', kind: 'auth', route: 'refresh' }],
    [
      'MISS graphql SyncTicks 0123456789ab reason=no-fixture',
      { event: 'miss', kind: 'graphql', operationName: 'SyncTicks', hash12: '0123456789ab', reason: 'no-fixture' },
    ],
    [
      'MISS graphql SyncTicks 0123456789ab reason=document-changed',
      {
        event: 'miss',
        kind: 'graphql',
        operationName: 'SyncTicks',
        hash12: '0123456789ab',
        reason: 'document-changed',
      },
    ],
    [
      'MISS graphql anonymous 0123456789ab reason=anonymous-operation',
      {
        event: 'miss',
        kind: 'graphql',
        operationName: 'anonymous',
        hash12: '0123456789ab',
        reason: 'anonymous-operation',
      },
    ],
    [
      'MISS graphql SyncTicks 0123456789ab reason=unreadable-fixture',
      {
        event: 'miss',
        kind: 'graphql',
        operationName: 'SyncTicks',
        hash12: '0123456789ab',
        reason: 'unreadable-fixture',
      },
    ],
    ['MISS static /static/avatars/a.jpg', { event: 'miss', kind: 'static', subject: '/static/avatars/a.jpg' }],
    ['MISS route GET /api/v1/climbs', { event: 'miss', kind: 'route', method: 'GET', path: '/api/v1/climbs' }],
    [
      'MISS auth email=other@example.com expected=shots@boardsesh.com',
      { event: 'miss', kind: 'auth', email: 'other@example.com', expectedEmail: 'shots@boardsesh.com' },
    ],
    [
      'RECORDED graphql SyncTicks 0123456789ab -> graphql/SyncTicks/0123456789ab.json',
      {
        event: 'recorded',
        kind: 'graphql',
        operationName: 'SyncTicks',
        hash12: '0123456789ab',
        file: 'graphql/SyncTicks/0123456789ab.json',
      },
    ],
    [
      'RECORDED static /static/avatars/a.jpg?size=64 -> static/deadbeefdeadbeef.jpg',
      {
        event: 'recorded',
        kind: 'static',
        subject: '/static/avatars/a.jpg?size=64',
        file: 'static/deadbeefdeadbeef.jpg',
      },
    ],
    ['DUP graphql SyncTicks 0123456789ab', { event: 'duplicate', operationName: 'SyncTicks', hash12: '0123456789ab' }],
    [
      'UPSTREAM-ERROR graphql SyncTicks status=500',
      { event: 'upstream-error', operationName: 'SyncTicks', detail: 'status=500' },
    ],
    [
      'UPSTREAM-ERROR graphql SyncTicks code=INTERNAL_SERVER_ERROR',
      { event: 'upstream-error', operationName: 'SyncTicks', detail: 'code=INTERNAL_SERVER_ERROR' },
    ],
    ['REDACTED graphql Me', { event: 'redacted', operationName: 'Me' }],
    [
      'NOTE graphql SyncTicks seen with 21 distinct variable sets',
      { event: 'note', operationName: 'SyncTicks', note: variantCountNote(21) },
    ],
    ['WS connection_init ack', { event: 'ws-ack' }],
    ['WS subscribe ClimbStatsUpdated', { event: 'ws-subscribe', operationName: 'ClimbStatsUpdated' }],
    ['WS error RSV1 must be clear', { event: 'ws-error', message: 'RSV1 must be clear' }],
  ];

  it.each(grammarLines)('round-trips %s', (body, parsed) => {
    const line = `${SCREENSHOT_BACKEND_LOG_PREFIX} ${body}`;
    expect(formatScreenshotBackendLine(parsed)).toBe(line);
    expect(parseScreenshotBackendLogLine(line)).toEqual(parsed);
  });

  it('parses a line that arrives behind a Metro/logcat prefix', () => {
    const parsed = parseScreenshotBackendLogLine(
      `09-08 09:00:00.123 I ReactNative: ${SCREENSHOT_BACKEND_LOG_PREFIX} HIT graphql SyncTicks 0123456789ab`,
    );
    expect(parsed).toEqual({ event: 'hit', kind: 'graphql', operationName: 'SyncTicks', hash12: '0123456789ab' });
  });

  it('ignores lines that are not ours, and an unknown reason', () => {
    expect(parseScreenshotBackendLogLine('[dev] QA notes: .boardsesh/qa-notes.md')).toBeNull();
    expect(
      parseScreenshotBackendLogLine(`${SCREENSHOT_BACKEND_LOG_PREFIX} MISS graphql SyncTicks abc reason=who-knows`),
    ).toBeNull();
  });

  it('round-trips the oversized-fixture note too', () => {
    const parsed: ScreenshotBackendLogLine = {
      event: 'note',
      operationName: 'SyncClimbs',
      note: fixtureSizeNote(FIXTURE_SIZE_NOTE_BYTES + 1),
    };
    expect(parseScreenshotBackendLogLine(formatScreenshotBackendLine(parsed))).toEqual(parsed);
  });
});

describe('findScreenshotBackendProblems', () => {
  const line = (body: string): string => `${SCREENSHOT_BACKEND_LOG_PREFIX} ${body}`;

  it('is silent on a clean replay log', () => {
    const log = [
      line('READY mode=replay port=8090 fixtures=/tmp/fx frozenNow=2026-09-08T09:00:00Z graphql=12 static=3'),
      line('HIT graphql SyncTicks 0123456789ab'),
      line('HIT static /static/avatars/a.jpg?size=64'),
      line('WS connection_init ack'),
      line('WS subscribe ClimbStatsUpdated'),
    ].join('\n');
    expect(findScreenshotBackendProblems(log, { mode: 'replay' })).toEqual([]);
  });

  it('counts an auth hit toward the no-HIT-lines check, and does not treat a WS error as a problem', () => {
    const log = [
      line('HIT auth credentials'),
      line('WS error RSV1 must be clear'),
      line('WS error RSV1 must be clear'),
    ].join('\n');
    expect(findScreenshotBackendProblems(log, { mode: 'replay' })).toEqual([]);
  });

  it('collapses repeated misses into one line with a count and the re-record command', () => {
    const log = [
      line('HIT graphql Me 0000aaaa1111'),
      line('MISS graphql SyncTicks 0123456789ab reason=no-fixture'),
      line('MISS graphql SyncTicks 0123456789ab reason=no-fixture'),
      line('MISS graphql SyncTicks 0123456789ab reason=no-fixture'),
    ].join('\n');
    const problems = findScreenshotBackendProblems(log, { mode: 'replay' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no recorded response for SyncTicks (variables 0123456789ab)');
    expect(problems[0]).toContain('×3');
    expect(problems[0]).toContain(RE_RECORD_COMMAND);
    expect(problems[0].endsWith('`.')).toBe(true);
  });

  it('names the drift when the document moved, not a missing fixture', () => {
    const log = [
      line('HIT graphql Me 0000aaaa1111'),
      line('MISS graphql SyncTicks 0123456789ab reason=document-changed'),
    ].join('\n');
    const [problem] = findScreenshotBackendProblems(log, { mode: 'replay' });
    expect(problem).toContain('the query text for SyncTicks moved since it was recorded');
    expect(problem).toContain(RE_RECORD_COMMAND);
  });

  it('reports a replay run the app never reached', () => {
    const log = line('READY mode=replay port=8090 fixtures=/tmp/fx frozenNow=2026-09-08T09:00:00Z graphql=12 static=3');
    const problems = findScreenshotBackendProblems(log, { mode: 'replay' });
    expect(problems).toEqual([
      'no HIT lines in the screenshot backend log — the app never reached the replay backend; check that EXPO_PUBLIC_BACKEND_URL reached the Metro bundle.',
    ]);
  });

  it('reports a static miss and an auth mismatch on replay', () => {
    const log = [
      line('HIT graphql Me 0000aaaa1111'),
      line('MISS static /static/beta-link-thumbnails/instagram/x.jpg?size=256'),
      line('MISS auth email=other@example.com expected=shots@boardsesh.com'),
    ].join('\n');
    const problems = findScreenshotBackendProblems(log, { mode: 'replay' });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('/static/beta-link-thumbnails/instagram/x.jpg?size=256');
    expect(problems[1]).toContain(
      'the app signed in as other@example.com but the fixtures were recorded for shots@boardsesh.com',
    );
  });

  it('names a fixture that went unreadable mid-run, and how to fix it', () => {
    const log = [
      line('HIT graphql Me 0000aaaa1111'),
      line('MISS graphql SyncTicks 0123456789ab reason=unreadable-fixture'),
    ].join('\n');
    const [problem] = findScreenshotBackendProblems(log, { mode: 'replay' });
    expect(problem).toContain('the recorded response for SyncTicks could not be read');
    expect(problem).toContain('the fixture file is missing or malformed');
    expect(problem).toContain(RE_RECORD_COMMAND);
  });

  it('names the fix for a route nobody serves', () => {
    const log = [line('HIT graphql Me 0000aaaa1111'), line('MISS route GET /api/v1/climbs')].join('\n');
    const [problem] = findScreenshotBackendProblems(log, { mode: 'replay' });
    expect(problem).toContain('the app called GET /api/v1/climbs');
    expect(problem).toContain('add a handler to scripts/lib/screenshot-backend.ts');
  });

  it('treats recording misses as normal but upstream errors and unknown routes as problems', () => {
    const log = [
      line('READY mode=record port=8090 fixtures=/tmp/fx frozenNow=2026-09-08T09:00:00Z graphql=0 static=0'),
      line('RECORDED graphql SyncTicks 0123456789ab -> graphql/SyncTicks/0123456789ab.json'),
      line('DUP graphql SyncTicks 0123456789ab'),
      line('NOTE graphql SyncTicks seen with 21 distinct variable sets'),
      line('UPSTREAM-ERROR graphql Feed status=500'),
      line('UPSTREAM-ERROR graphql Feed status=500'),
      line('MISS route GET /api/v1/climbs'),
    ].join('\n');
    const problems = findScreenshotBackendProblems(log, { mode: 'record' });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('upstream refused Feed (status=500)');
    expect(problems[0]).toContain('×2');
    expect(problems[1]).toContain('the app called GET /api/v1/climbs');
  });

  it('does not demand HIT lines from a recording run', () => {
    const log = line('READY mode=record port=8090 fixtures=/tmp/fx frozenNow=2026-09-08T09:00:00Z graphql=0 static=0');
    expect(findScreenshotBackendProblems(log, { mode: 'record' })).toEqual([]);
  });
});
