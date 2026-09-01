/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `docs/postgres-image-digests.json` — the handoff copy of the publisher's
 * digest manifest, which names the exact images every consumer is pinned to —
 * is checked into the repo and read by nothing at run time, so nothing notices
 * when the tree drifts out from under it: a consumer pin can be edited to a
 * digest the manifest does not record, silently.
 *
 * The second suite guards any prepared `docs/*.patch` the same way: a patch's
 * context can be invalidated by an ordinary edit to any file it touches —
 * `git apply` absorbs line offsets without complaint right up until it rejects
 * outright. Zero committed patches is the healthy state (the last one,
 * `pg18-replication-rename.patch`, landed as a real rename and was deleted).
 *
 * These read their inputs from disk at run time rather than importing them, so
 * Vitest's `--changed` module-graph analysis cannot relate them to a diff that
 * only touches a workflow, `docker-compose.yml`, or a patch itself. They run
 * from their own gated job in `ci.yml`; see the `pg18Artifacts` paths filter.
 */

const DIGEST_MANIFEST_PATH = 'docs/postgres-image-digests.json';
const PORTABLE_IMAGE = 'ghcr.io/boardsesh/boardsesh-postgres-postgis';
const SEEDED_IMAGE = 'ghcr.io/boardsesh/boardsesh-dev-db';

/**
 * Every file that pins one of the two published images by digest. Each entry is
 * asserted to still contain a pin, so deleting one is as loud as changing one.
 */
const PINNED_CONSUMERS = [
  'docker-compose.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/e2e-tests.yml',
  '.github/workflows/db-migration-renumber.yml',
  'scripts/__tests__/ci-location-sync-workflow.test.ts',
] as const;

type DigestManifest = {
  images: Record<string, { name: string; digest: string }>;
};

function readDigestManifest(): DigestManifest {
  return JSON.parse(readFileSync(DIGEST_MANIFEST_PATH, 'utf8')) as DigestManifest;
}

/** Every `<image>@sha256:<digest>` reference to either published image, in file order. */
function pinnedReferences(source: string): { image: string; digest: string }[] {
  const references: { image: string; digest: string }[] = [];
  const pattern = new RegExp(`(${PORTABLE_IMAGE}|${SEEDED_IMAGE})@(sha256:[0-9a-f]{64})`, 'g');
  for (const match of source.matchAll(pattern)) {
    references.push({ image: match[1], digest: match[2] });
  }
  return references;
}

describe('published PostgreSQL image digests', () => {
  const manifest = readDigestManifest();

  it('records a digest for both published images', () => {
    expect(manifest.images.portable.name).toBe(PORTABLE_IMAGE);
    expect(manifest.images.seeded.name).toBe(SEEDED_IMAGE);
    expect(manifest.images.portable.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.images.seeded.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  const expectedDigest: Record<string, string> = {
    [PORTABLE_IMAGE]: manifest.images.portable.digest,
    [SEEDED_IMAGE]: manifest.images.seeded.digest,
  };

  it.each(PINNED_CONSUMERS)('pins %s to the recorded digests', (consumerPath) => {
    const source = readFileSync(consumerPath, 'utf8');
    const references = pinnedReferences(source);

    // A consumer that stops pinning at all is the failure this is really for:
    // an unpinned `:latest` would otherwise pass a digest-equality check
    // vacuously, because there would be no digest left to compare.
    expect(references.length, `${consumerPath} no longer pins a published image by digest`).toBeGreaterThan(0);

    for (const reference of references) {
      expect(reference.digest, `${consumerPath} pins ${reference.image} to a digest the manifest does not record`).toBe(
        expectedDigest[reference.image],
      );
    }
  });

  it('leaves no mutable tag reference behind in a pinned consumer', () => {
    for (const consumerPath of PINNED_CONSUMERS) {
      const source = readFileSync(consumerPath, 'utf8');
      const taggedReferences = [
        ...source.matchAll(new RegExp(`(?:${PORTABLE_IMAGE}|${SEEDED_IMAGE}):([\\w.-]+)`, 'g')),
      ];
      expect(
        taggedReferences.map((match) => match[0]),
        `${consumerPath} refers to a published image by tag; tags are mutable and are a lookup aid, never a deployment pin`,
      ).toEqual([]);
    }
  });
});

describe('committed patches still apply', () => {
  const patchPaths = readdirSync('docs')
    .filter((entry) => entry.endsWith('.patch'))
    .sort()
    .map((entry) => `docs/${entry}`);

  // A single looped test rather than `it.each`, so an empty glob — the healthy
  // state, with no prepared change waiting to land — still passes.
  it('applies every committed patch cleanly to the current tree', () => {
    for (const patchPath of patchPaths) {
      const result = spawnSync('git', ['apply', '--check', '--verbose', patchPath], { encoding: 'utf8' });

      expect(result.error).toBeUndefined();
      expect(
        result.status,
        [
          `${patchPath} no longer applies. It is a prepared change that has not landed yet,`,
          'so a file it touches has moved out from under it. Regenerate the patch against',
          'the current tree, or land the change and delete the patch.',
          '',
          result.stderr,
        ].join('\n'),
      ).toBe(0);
    }
  });
});
