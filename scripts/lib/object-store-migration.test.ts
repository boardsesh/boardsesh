import { describe, expect, it } from 'vite-plus/test';
import {
  classifyKey,
  formatBytes,
  isRetryableStorageError,
  matchesPrefixFilter,
  MIGRATION_ROUTES,
  planMigration,
  verifyMigration,
  type MigrationDestination,
  type ObjectSummary,
} from './object-store-migration';

const NO_DESTINATIONS: Record<MigrationDestination, ObjectSummary[]> = { media: [], private: [] };

function objects(...entries: [key: string, size: number][]): ObjectSummary[] {
  return entries.map(([key, size]) => ({ key, size }));
}

describe('classifyKey', () => {
  it.each([
    ['beta-link-thumbnails/instagram/B-3qoP-Ddy_.jpg', 'media'],
    ['beta-link-thumbnails/instagram/B-3qoP-Ddy_.jpg@280.jpg', 'media'],
    ['beta-link-thumbnails/tiktok/abc.jpg', 'media'],
    ['avatars/0026f839-5579-4ebb-bf43-c0954ce7f80a.jpg', 'media'],
    ['gym-photos/6b641d7a-d456-4eda-8976-fc4bd3b247e8.jpg', 'media'],
    ['gym-logos/c9a61170-776b-49d3-9b5a-5f9679724ef5.png', 'media'],
    ['user-data-exports/1030b46e-3f31-4db9-95f8-2e09a542ce24/kilter/2026-W19.json', 'private'],
    ['moonboard-ocr-test-data/2026-05-01T00:00:00Z-abc/image.png', 'private'],
  ])('routes %s to %s', (key, expected) => {
    expect(classifyKey(key)).toBe(expected);
  });

  it('returns null for anything the table does not name', () => {
    // Null is a hard stop for the caller. Defaulting to `media` would publish
    // an unknown prefix to a CDN the moment the custom domain is attached.
    expect(classifyKey('some-new-feature/thing.bin')).toBeNull();
    expect(classifyKey('')).toBeNull();
    // A near-miss must not match: no leading-slash or partial-segment tolerance.
    expect(classifyKey('/avatars/u1.jpg')).toBeNull();
    expect(classifyKey('avatars-backup/u1.jpg')).toBeNull();
  });

  it('routes every user-data prefix away from the public bucket', () => {
    const publicPrefixes = MIGRATION_ROUTES.filter((route) => route.destination === 'media').map((r) => r.prefix);
    expect(publicPrefixes).not.toContain('user-data-exports/');
    expect(publicPrefixes).not.toContain('moonboard-ocr-test-data/');
  });
});

describe('matchesPrefixFilter', () => {
  it('treats an empty filter list as "everything"', () => {
    expect(matchesPrefixFilter('avatars/u1.jpg', [])).toBe(true);
  });

  it('matches any one of several filters', () => {
    expect(matchesPrefixFilter('gym-logos/g1.png', ['avatars/', 'gym-logos/'])).toBe(true);
    expect(matchesPrefixFilter('gym-photos/g1.jpg', ['avatars/', 'gym-logos/'])).toBe(false);
  });

  it('narrows below a route boundary', () => {
    // The reverse path depends on this: destinationPrefixes widens a narrow
    // filter up to the whole route so the S3 listing is valid, so the filter
    // has to be re-applied to the returned keys or tiktok objects come back
    // from an instagram-scoped run.
    expect(matchesPrefixFilter('beta-link-thumbnails/instagram/a.jpg', ['beta-link-thumbnails/instagram/'])).toBe(true);
    expect(matchesPrefixFilter('beta-link-thumbnails/tiktok/a.jpg', ['beta-link-thumbnails/instagram/'])).toBe(false);
  });
});

describe('planMigration', () => {
  it('plans every source object when the destinations are empty', () => {
    const plan = planMigration(
      objects(['avatars/u1.jpg', 100], ['user-data-exports/u1/kilter/w.json', 50]),
      NO_DESTINATIONS,
    );

    expect(plan.copies).toEqual([
      { key: 'avatars/u1.jpg', destination: 'media', size: 100, reason: 'missing' },
      { key: 'user-data-exports/u1/kilter/w.json', destination: 'private', size: 50, reason: 'missing' },
    ]);
    expect(plan.skipped).toBe(0);
  });

  it('skips an IMMUTABLE destination object that already matches by size', () => {
    const key = 'beta-link-thumbnails/instagram/a.jpg';
    const plan = planMigration(objects([key, 100]), { media: objects([key, 100]), private: [] });

    expect(plan.copies).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it('re-copies an immutable destination object whose size differs', () => {
    const key = 'beta-link-thumbnails/instagram/a.jpg';
    const plan = planMigration(objects([key, 100]), { media: objects([key, 42]), private: [] });

    expect(plan.copies).toEqual([
      { key, destination: 'media', size: 100, reason: 'size-mismatch', destinationSize: 42 },
    ]);
    expect(plan.skipped).toBe(0);
  });

  it('ALWAYS re-copies a mutable key, even when the sizes match', () => {
    // avatars/gym images/weekly exports are rewritten at the same key. A
    // rewrite that lands on the same byte length between the bulk copy and the
    // sweep would otherwise be skipped as "already there" — and would pass
    // verification too, leaving the stale copy live.
    const plan = planMigration(objects(['avatars/u1.jpg', 100]), {
      media: objects(['avatars/u1.jpg', 100]),
      private: [],
    });

    expect(plan.copies).toEqual([
      { key: 'avatars/u1.jpg', destination: 'media', size: 100, reason: 'mutable', destinationSize: 100 },
    ]);
    expect(plan.skipped).toBe(0);
  });

  it.each(['avatars/u1.jpg', 'gym-logos/g1.png', 'gym-photos/g1.jpg', 'user-data-exports/u1/kilter/w.json'])(
    'treats %s as mutable',
    (key) => {
      const destination = key.startsWith('user-data-exports/') ? 'private' : 'media';
      const plan = planMigration(objects([key, 10]), {
        media: destination === 'media' ? objects([key, 10]) : [],
        private: destination === 'private' ? objects([key, 10]) : [],
      });
      expect(plan.copies.map((copy) => copy.reason)).toEqual(['mutable']);
    },
  );

  it('leaves the 50k immutable thumbnails on the cheap skip path', () => {
    // The mutable rule must not cost the saving that makes a re-run fast.
    const immutable = MIGRATION_ROUTES.filter((route) => !route.mutable).map((route) => route.prefix);
    expect(immutable).toContain('beta-link-thumbnails/');
    expect(immutable).toContain('moonboard-ocr-test-data/');
  });

  it('does not let a key present in the WRONG destination count as done', () => {
    // The two buckets have separate key spaces; an export sitting in `media`
    // must never satisfy the plan for `private`.
    const plan = planMigration(objects(['user-data-exports/u1/kilter/w.json', 50]), {
      media: objects(['user-data-exports/u1/kilter/w.json', 50]),
      private: [],
    });

    expect(plan.copies).toHaveLength(1);
    expect(plan.copies[0].destination).toBe('private');
  });

  it('collects unroutable keys instead of routing them somewhere', () => {
    const plan = planMigration(objects(['mystery/thing.bin', 1], ['avatars/u1.jpg', 2]), NO_DESTINATIONS);

    expect(plan.unroutable).toEqual(['mystery/thing.bin']);
    expect(plan.copies.map((copy) => copy.key)).toEqual(['avatars/u1.jpg']);
  });

  it('still reports unroutable keys when the run is scoped to one prefix', () => {
    // A surprise key is a surprise key regardless of what this invocation was
    // asked to move, so the filter is applied after routing.
    const plan = planMigration(objects(['mystery/thing.bin', 1], ['avatars/u1.jpg', 2]), NO_DESTINATIONS, {
      prefixFilters: ['avatars/'],
    });

    expect(plan.unroutable).toEqual(['mystery/thing.bin']);
    expect(plan.copies).toHaveLength(1);
  });

  it('honours a prefix filter', () => {
    const plan = planMigration(objects(['avatars/u1.jpg', 1], ['gym-logos/g1.png', 2]), NO_DESTINATIONS, {
      prefixFilters: ['gym-logos/'],
    });

    expect(plan.copies.map((copy) => copy.key)).toEqual(['gym-logos/g1.png']);
  });

  it('honours an onlyDestination filter', () => {
    const plan = planMigration(objects(['avatars/u1.jpg', 1], ['user-data-exports/u1/k/w.json', 2]), NO_DESTINATIONS, {
      onlyDestination: 'private',
    });

    expect(plan.copies.map((copy) => copy.key)).toEqual(['user-data-exports/u1/k/w.json']);
  });

  it('surfaces zero-byte sources but still copies them', () => {
    // Several production avatars are 0 bytes. They are copied so the migration
    // is a faithful mirror, but flagged so nobody mistakes them for corruption
    // introduced by the copy.
    const plan = planMigration(objects(['avatars/u1.jpg', 0]), NO_DESTINATIONS);

    expect(plan.emptySourceKeys).toEqual(['avatars/u1.jpg']);
    expect(plan.copies).toHaveLength(1);
  });

  it('summarises per prefix, largest first', () => {
    const plan = planMigration(
      objects(
        ['gym-logos/g1.png', 10],
        ['beta-link-thumbnails/instagram/a.jpg', 500],
        ['beta-link-thumbnails/instagram/b.jpg', 20],
      ),
      { media: objects(['beta-link-thumbnails/instagram/b.jpg', 20]), private: [] },
    );

    expect(plan.byPrefix).toEqual([
      {
        prefix: 'beta-link-thumbnails/',
        destination: 'media',
        objects: 2,
        bytes: 520,
        toCopy: 1,
        bytesToCopy: 500,
      },
      { prefix: 'gym-logos/', destination: 'media', objects: 1, bytes: 10, toCopy: 1, bytesToCopy: 10 },
    ]);
  });
});

describe('verifyMigration', () => {
  it('passes when every source key is present at the right size', () => {
    const result = verifyMigration(objects(['avatars/u1.jpg', 100], ['user-data-exports/u1/k/w.json', 50]), {
      media: objects(['avatars/u1.jpg', 100]),
      private: objects(['user-data-exports/u1/k/w.json', 50]),
    });

    expect(result.problems).toEqual([]);
    expect(result.checked).toBe(2);
  });

  it('reports a missing object', () => {
    const result = verifyMigration(objects(['avatars/u1.jpg', 100]), NO_DESTINATIONS);

    expect(result.problems).toEqual([
      { key: 'avatars/u1.jpg', destination: 'media', kind: 'missing', sourceSize: 100 },
    ]);
  });

  it('reports a truncated copy', () => {
    const result = verifyMigration(objects(['avatars/u1.jpg', 100]), {
      media: objects(['avatars/u1.jpg', 7]),
      private: [],
    });

    expect(result.problems).toEqual([
      { key: 'avatars/u1.jpg', destination: 'media', kind: 'size-mismatch', sourceSize: 100, destinationSize: 7 },
    ]);
  });

  it('reports unroutable keys rather than silently passing them', () => {
    const result = verifyMigration(objects(['mystery/thing.bin', 1]), NO_DESTINATIONS);

    expect(result.unroutable).toEqual(['mystery/thing.bin']);
    expect(result.checked).toBe(0);
  });
});

describe('isRetryableStorageError', () => {
  it.each([
    ['SlowDown by name', { name: 'SlowDown' }],
    ['SlowDown by code', { Code: 'SlowDown' }],
    ['HTTP 429', { $metadata: { httpStatusCode: 429 } }],
    ['HTTP 503', { $metadata: { httpStatusCode: 503 } }],
    ['SDK $retryable', { $retryable: { throttling: true } }],
    ['transport reset', { Code: 'ECONNRESET' }],
    ['dns failure', { name: 'EAI_AGAIN' }],
  ])('retries on %s', (_label, error) => {
    expect(isRetryableStorageError(error)).toBe(true);
  });

  it.each([
    ['HTTP 403', { $metadata: { httpStatusCode: 403 } }],
    ['HTTP 404', { $metadata: { httpStatusCode: 404 } }],
    // The one that matters most: R2 rejecting an ACL header is a code bug, and
    // retrying it four times just makes the failure slower.
    ['HTTP 501 NotImplemented', { name: 'NotImplemented', $metadata: { httpStatusCode: 501 } }],
    ['a plain Error', new Error('boom')],
    ['null', null],
    ['a string', 'nope'],
  ])('does not retry on %s', (_label, error) => {
    expect(isRetryableStorageError(error)).toBe(false);
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [19010, '18.6 KB'],
    [5_240_000_000, '4.9 GB'],
  ])('formats %d as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
