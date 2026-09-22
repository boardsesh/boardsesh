/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  assertCopyPreflight,
  classifyStorageEndpoint,
  diffInventories,
  fingerprintsMatch,
  metadataMatches,
  verifyObjectStores,
  type ObjectFingerprint,
  type ObjectMetadata,
} from './lib/ota-storage-migration';
import { fetchRailwayServiceVariables, isNotFoundError, listAllObjects } from './migrate-ota-storage';

const EMPTY_METADATA: ObjectMetadata = {
  contentType: null,
  cacheControl: null,
  contentDisposition: null,
  contentEncoding: null,
  contentLanguage: null,
  expires: null,
  userMetadata: {},
};

function fingerprint(sha256: string, metadata: ObjectMetadata = EMPTY_METADATA): ObjectFingerprint {
  return { size: 3, sha256, metadata };
}

describe('classifyStorageEndpoint', () => {
  it.each([
    ['https://t3.storage.dev', 'tigris'],
    ['https://fly.storage.tigris.dev', 'tigris'],
    ['https://abc.r2.cloudflarestorage.com', 'r2'],
    ['http://t3.storage.dev', 'unknown'],
    ['https://t3.storage.dev/path', 'unknown'],
    ['https://abc.r2.cloudflarestorage.com?secret=x', 'unknown'],
    ['not a URL', 'unknown'],
  ])('classifies %s as %s', (endpoint, expected) => {
    expect(classifyStorageEndpoint(endpoint)).toBe(expected);
  });
});

describe('diffInventories', () => {
  it('reports missing, extra and same-key size drift', () => {
    expect(
      diffInventories(
        [
          { key: 'a', size: 1 },
          { key: 'b', size: 2 },
        ],
        [
          { key: 'b', size: 7 },
          { key: 'c', size: 3 },
        ],
      ),
    ).toEqual({
      missing: ['a'],
      extra: ['c'],
      sizeMismatches: [{ key: 'b', sourceSize: 2, destinationSize: 7 }],
    });
  });

  it('rejects duplicate keys rather than hiding a broken listing', () => {
    expect(() =>
      diffInventories(
        [
          { key: 'a', size: 1 },
          { key: 'a', size: 1 },
        ],
        [],
      ),
    ).toThrow(/Duplicate object key/);
  });

  it('blocks destination-only keys before copy because the tool cannot delete them', () => {
    expect(() => assertCopyPreflight([], [{ key: 'stale', size: 1 }])).toThrow(/No objects were copied/);
    expect(() => assertCopyPreflight([{ key: 'same', size: 1 }], [{ key: 'same', size: 1 }])).not.toThrow();
  });
});

describe('destination read errors', () => {
  it('recopies only a genuine not-found race', () => {
    expect(isNotFoundError({ name: 'NoSuchKey' })).toBe(true);
    expect(isNotFoundError({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isNotFoundError({ $metadata: { httpStatusCode: 503 } })).toBe(false);
    expect(isNotFoundError(new Error('socket reset'))).toBe(false);
  });
});

describe('metadataMatches', () => {
  it('normalizes user-metadata key order and case', () => {
    expect(
      metadataMatches(
        { ...EMPTY_METADATA, contentType: 'application/json', userMetadata: { Zebra: '1', alpha: '2' } },
        { ...EMPTY_METADATA, contentType: 'application/json', userMetadata: { ALPHA: '2', zebra: '1' } },
      ),
    ).toBe(true);
  });

  it('detects a metadata-only mismatch', () => {
    expect(metadataMatches(EMPTY_METADATA, { ...EMPTY_METADATA, cacheControl: 'private' })).toBe(false);
  });
});

describe('fingerprintsMatch', () => {
  it('catches a same-size source overwrite between verification passes', () => {
    expect(fingerprintsMatch(fingerprint('before'), fingerprint('after'))).toBe(false);
  });

  it('requires metadata to remain stable too', () => {
    expect(
      fingerprintsMatch(fingerprint('same'), fingerprint('same', { ...EMPTY_METADATA, cacheControl: 'changed' })),
    ).toBe(false);
  });
});

describe('verifyObjectStores', () => {
  it('requires exact key sets before reading content', async () => {
    const calls: [side: 'source' | 'destination', key: string][] = [];
    const problems = await verifyObjectStores(
      [
        { key: 'missing', size: 1 },
        { key: 'shared', size: 3 },
      ],
      [
        { key: 'extra', size: 1 },
        { key: 'shared', size: 3 },
      ],
      async (side, key) => {
        calls.push([side, key]);
        return fingerprint('same');
      },
    );

    expect(problems).toEqual([
      { key: 'extra', kind: 'extra', detail: 'absent from source' },
      { key: 'missing', kind: 'missing', detail: 'absent from destination' },
    ]);
    expect(calls).toEqual([
      ['source', 'shared'],
      ['destination', 'shared'],
    ]);
  });

  it('detects same-size content drift by full SHA-256', async () => {
    const problems = await verifyObjectStores([{ key: 'asset', size: 3 }], [{ key: 'asset', size: 3 }], async (side) =>
      fingerprint(side === 'source' ? 'source-hash' : 'destination-hash'),
    );
    expect(problems).toEqual([{ key: 'asset', kind: 'content', detail: 'SHA-256 differs' }]);
  });

  it('detects metadata drift after content matches', async () => {
    const problems = await verifyObjectStores([{ key: 'asset', size: 3 }], [{ key: 'asset', size: 3 }], async (side) =>
      fingerprint('same', side === 'source' ? EMPTY_METADATA : { ...EMPTY_METADATA, contentType: 'text/plain' }),
    );
    expect(problems).toEqual([{ key: 'asset', kind: 'metadata', detail: 'HTTP or user metadata differs' }]);
  });
});

describe('Railway variable reads', () => {
  it('reads one named service without mistaking a secret value for an auth error', async () => {
    const originalFetch = globalThis.fetch;
    const calls: { headers: Record<string, string>; query: string }[] = [];
    globalThis.fetch = (async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.');
      const body = JSON.parse(init.body) as { query: string };
      calls.push({ headers: init?.headers as Record<string, string>, query: body.query });
      const data = body.query.includes('MigrationProject')
        ? {
            project: {
              environments: { edges: [{ node: { id: 'env', name: 'production' } }] },
              services: { edges: [{ node: { id: 'service', name: 'boardsesh-ota-v3' } }] },
            },
          }
        : { variables: { AWS_SECRET_ACCESS_KEY: 'contains Not Authorized but is valid' } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const variables = await fetchRailwayServiceVariables('token', 'project', 'production', 'boardsesh-ota-v3');
      expect(variables.AWS_SECRET_ACCESS_KEY).toContain('Not Authorized');
      expect(calls).toHaveLength(2);
      expect(calls.every(({ query }) => !/\bmutation\b/.test(query))).toBe(true);
      expect(calls.every(({ headers }) => headers['Project-Access-Token'] === 'token')).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back from project-token to account-token authentication', async () => {
    const originalFetch = globalThis.fetch;
    const headers: Record<string, string>[] = [];
    globalThis.fetch = (async (_input, init) => {
      const requestHeaders = init?.headers as Record<string, string>;
      headers.push(requestHeaders);
      if (requestHeaders['Project-Access-Token']) {
        return new Response(JSON.stringify({ errors: [{ message: 'Not Authorized' }] }), { status: 200 });
      }
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.');
      const body = JSON.parse(init.body) as { query: string };
      const data = body.query.includes('MigrationProject')
        ? {
            project: {
              environments: { edges: [{ node: { id: 'env', name: 'production' } }] },
              services: { edges: [{ node: { id: 'service', name: 'boardsesh-ota-v3' } }] },
            },
          }
        : { variables: { STORAGE_MODE: 's3' } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      await expect(fetchRailwayServiceVariables('token', 'project', 'production', 'boardsesh-ota-v3')).resolves.toEqual(
        { STORAGE_MODE: 's3' },
      );
      expect(headers.some((entry) => entry.Authorization === 'Bearer token')).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never includes a malformed secret-bearing response in an error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('secret-from-railway', { status: 502 })) as typeof globalThis.fetch;
    try {
      await expect(
        fetchRailwayServiceVariables('token', 'project', 'production', 'boardsesh-ota-v3'),
      ).rejects.not.toThrow(/secret-from-railway/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('paginated inventory and no-delete contract', () => {
  it('follows every continuation token', async () => {
    const tokens: (string | undefined)[] = [];
    const target = {
      bucket: 'boardsesh-ota-v3',
      label: 'source' as const,
      client: {
        send: async (command: { input: { ContinuationToken?: string } }) => {
          tokens.push(command.input.ContinuationToken);
          return command.input.ContinuationToken
            ? { Contents: [{ Key: 'b', Size: 2 }], IsTruncated: false }
            : { Contents: [{ Key: 'a', Size: 1 }], IsTruncated: true, NextContinuationToken: 'next' };
        },
      },
    };
    const objects = await listAllObjects(target as unknown as Parameters<typeof listAllObjects>[0]);
    expect(tokens).toEqual([undefined, 'next']);
    expect(objects).toEqual([
      { key: 'a', size: 1 },
      { key: 'b', size: 2 },
    ]);
  });

  it('rejects a truncated page with no continuation token', async () => {
    const target = {
      bucket: 'boardsesh-ota-v3',
      label: 'source' as const,
      client: { send: async () => ({ IsTruncated: true }) },
    };
    await expect(listAllObjects(target as unknown as Parameters<typeof listAllObjects>[0])).rejects.toThrow(
      /without a continuation token/,
    );
  });

  it('contains no S3 delete command or Railway mutation', () => {
    const source = readFileSync(resolve(__dirname, 'migrate-ota-storage.ts'), 'utf8');
    expect(source).not.toMatch(/DeleteObject|DeleteObjects/);
    expect(source).not.toMatch(/^\s*mutation\s+[A-Za-z]/m);
  });
});
