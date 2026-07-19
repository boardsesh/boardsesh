import { describe, expect, it, vi } from 'vitest';

// extractAuthToken is a pure function, but the module imports the db client at
// load time. Stub it so the unit test never touches Postgres.
vi.mock('../../db/client', () => ({
  db: {},
  dbRead: {},
}));

import { extractAuthToken } from '../auth';

describe('extractAuthToken', () => {
  it('returns a non-empty string authToken from connection params', () => {
    expect(extractAuthToken({ authToken: 'valid-token' })).toBe('valid-token');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['number', 42],
    ['object', {}],
  ])('treats a present-but-%s authToken as no credential (returns null)', (_label, authToken) => {
    expect(extractAuthToken({ authToken })).toBeNull();
  });

  it('falls through to the ?token= query param when authToken is not a usable string', () => {
    // The key regression: a present-but-null authToken must NOT short-circuit the
    // URL fallback. An anonymous web client that sends `authToken: null` alongside
    // a query token should still be authenticated by the URL token.
    expect(extractAuthToken({ authToken: null }, 'ws://localhost/graphql?token=url-token')).toBe('url-token');
  });

  it('reads the ?token= query param when no connection params are supplied', () => {
    expect(extractAuthToken(undefined, 'ws://localhost/graphql?token=url-token')).toBe('url-token');
  });

  it('returns null for an explicit empty query token', () => {
    expect(extractAuthToken(undefined, 'ws://localhost/graphql?token=')).toBeNull();
  });

  it('returns null when neither connection params nor URL carry a token', () => {
    expect(extractAuthToken(undefined, 'ws://localhost/graphql')).toBeNull();
    expect(extractAuthToken({})).toBeNull();
    expect(extractAuthToken()).toBeNull();
  });

  it('ignores a malformed request URL without throwing', () => {
    expect(extractAuthToken(undefined, 'not a url')).toBeNull();
  });
});
