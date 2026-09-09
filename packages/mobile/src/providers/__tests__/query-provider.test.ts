import { afterEach, describe, expect, it, vi } from 'vitest';

// query-provider now wires React Query to RN connectivity/lifecycle, so it
// imports `react-native` (AppState/Platform). The real entry is Flow source
// Rolldown can't parse — stub the two members it touches. NetInfo is aliased to
// a stub in vite.config.ts.
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' },
}));

import { createQueryClient, reportMutationFailure, reportQueryFailure } from '../query-provider';
import { reportHandledError } from '../../lib/error-reporting';

// The global caches are the whole point — a query/mutation failure anywhere in
// the app must reach error tracking once retries are exhausted. The cache
// onError handlers delegate to these reporters, so testing them covers the
// key serialization + tags without running the fetch/retry loop.
vi.mock('../../lib/error-reporting', () => ({
  reportHandledError: vi.fn(),
}));

const mockedReport = vi.mocked(reportHandledError);

afterEach(() => {
  mockedReport.mockClear();
});

describe('reportQueryFailure', () => {
  it('reports with the serialized queryKey and hash', () => {
    const error = new Error('query boom');
    reportQueryFailure(error, ['searchClimbs', { q: 'x' }], 'hash-1');
    expect(mockedReport).toHaveBeenCalledWith(error, {
      tags: { source: 'react-query', kind: 'query' },
      extra: { queryKey: JSON.stringify(['searchClimbs', { q: 'x' }]), queryHash: 'hash-1' },
    });
  });
});

describe('reportMutationFailure', () => {
  it('reports with the serialized mutationKey', () => {
    const error = new Error('mutation boom');
    reportMutationFailure(error, ['createPlaylist']);
    expect(mockedReport).toHaveBeenCalledWith(error, {
      tags: { source: 'react-query', kind: 'mutation' },
      extra: { mutationKey: JSON.stringify(['createPlaylist']) },
    });
  });

  it('reports a keyless mutation with a null mutationKey', () => {
    const error = new Error('keyless');
    reportMutationFailure(error, undefined);
    expect(mockedReport).toHaveBeenCalledWith(error, {
      tags: { source: 'react-query', kind: 'mutation' },
      extra: { mutationKey: null },
    });
  });
});

describe('createQueryClient default retry', () => {
  // Retrying a RATE_LIMITED response only hammers the already-throttled
  // endpoint harder (#3285), so it must never retry regardless of failureCount;
  // everything else keeps the previous retry-up-to-2-times behavior.
  it('never retries a RATE_LIMITED GraphQL rejection', () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry;
    if (typeof retry !== 'function') throw new Error('expected retry to be a function');
    const rateLimited = Object.assign(new Error('Rate limit exceeded. Try again in 7 seconds.'), {
      response: {
        status: 200,
        errors: [{ message: 'Rate limit exceeded.', extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 7 } }],
      },
    });
    expect(retry(0, rateLimited)).toBe(false);
  });

  // A GRAPHQL_VALIDATION_FAILED is the server refusing the DOCUMENT: this
  // bundle's query text does not match the deployed schema, so the identical
  // bytes get the identical 400 forever (#5370). Three attempts would be three
  // guaranteed rejections and three times the wait before the screen can show
  // its degraded state.
  it('never retries a GRAPHQL_VALIDATION_FAILED schema mismatch', () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry;
    if (typeof retry !== 'function') throw new Error('expected retry to be a function');
    const schemaMismatch = Object.assign(new Error('Unknown argument "layoutId" on field "Query.recentBetaLinks".'), {
      response: {
        status: 400,
        errors: [
          {
            message: 'Unknown argument "layoutId" on field "Query.recentBetaLinks".',
            extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
          },
        ],
      },
    });
    expect(retry(0, schemaMismatch)).toBe(false);
  });

  // The other half of that rule: a gateway is not a schema. A 503 whose canned
  // body happens to carry the code must keep its retries, or a transient edge
  // outage would look permanent to every screen at once.
  it('still retries a 503 whose body carries the validation code', () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry;
    if (typeof retry !== 'function') throw new Error('expected retry to be a function');
    const edgeOutage = Object.assign(new Error('Application failed to respond'), {
      response: { status: 503, errors: [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] },
    });
    expect(retry(0, edgeOutage)).toBe(true);
  });

  it('retries an ordinary error up to 2 times, matching the previous retry: 2 behavior', () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry;
    if (typeof retry !== 'function') throw new Error('expected retry to be a function');
    const plainError = new Error('boom');
    expect(retry(0, plainError)).toBe(true);
    expect(retry(1, plainError)).toBe(true);
    expect(retry(2, plainError)).toBe(false);
  });
});
