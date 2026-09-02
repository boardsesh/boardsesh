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
 * The second suite guards any prepared patch under `docs/` (recursively) the
 * same way: a patch's context can be invalidated by an ordinary edit to any
 * file it touches — `git apply` absorbs line offsets without complaint right
 * up until it rejects outright. Zero committed patches is the healthy state
 * (the last one, `pg18-replication-rename.patch`, landed as a real rename and
 * was deleted). A future prepared patch must also add every file its context
 * touches to the `pg18Artifacts` filter in `ci.yml`, or an edit to one of
 * those files skips this job on the PR and the guard only fires after merge.
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
  // Recursive on purpose: a patch filed under a subdirectory (say
  // docs/patches/) must not silently escape the guard. An empty list is the
  // healthy state — no prepared change waiting to land — while `it.each`
  // keeps per-patch failure reporting when patches do exist.
  const patchPaths = readdirSync('docs', { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.patch'))
    .sort()
    .map((entry) => `docs/${entry}`);

  // The runner rejects a suite that registers zero tests, so this sentinel
  // also records that discovery ran; it is not a minimum-count assertion.
  it('discovers patches recursively under docs/', () => {
    expect(patchPaths.every((patchPath) => patchPath.startsWith('docs/'))).toBe(true);
  });

  it.each(patchPaths)('%s applies cleanly to the current tree', (patchPath) => {
    const result = spawnSync('git', ['apply', '--check', '--verbose', patchPath], { encoding: 'utf8' });

    expect(result.error, `git apply could not run for ${patchPath}`).toBeUndefined();
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
  });
});

/**
 * A patch only stays appliable if every file it touches is gated on the job
 * that checks it. Until #4703, three of the eleven files
 * `docs/pg18-replication-rename.patch` touches were in no filter at all, so a
 * PR editing one of them invalidated the patch while `pg18-artifacts` never
 * ran — and `main`, where the gate is hardcoded `true`, went red on push. That
 * is the same silent drift the patch check itself exists to prevent, one level
 * up. #4703 was a live instance: it edited two of the three and only got a run
 * because it also happened to touch `docs/*.patch`.
 *
 * That patch has since landed as a real rename, and no patch is committed
 * today — the healthy state. Keeping the filter a superset of the patch file
 * set is still the invariant for the next prepared patch, so this asserts it
 * per patch rather than trusting the list to be maintained by hand.
 */
describe('every patched file is gated on the job that checks the patch', () => {
  const WORKFLOW_PATH = '.github/workflows/ci.yml';

  /**
   * Read one `dorny/paths-filter` list out of ci.yml by key and indentation.
   * Same approach as ci-rest-surface-workflow.test.ts and ci-lint-scope.test.ts:
   * the repo declares no YAML parser for CI contract tests.
   */
  function pathsFilter(key: string): string[] {
    const lines = readFileSync(WORKFLOW_PATH, 'utf8').split('\n');
    const prefix = `            ${key}:`;
    const startIndex = lines.findIndex((line) => line.startsWith(prefix));
    expect(startIndex, `missing ${key} paths filter in ${WORKFLOW_PATH}`).toBeGreaterThanOrEqual(0);

    const globs: string[] = [];
    for (const line of lines.slice(startIndex + 1)) {
      const entry = /^\s+- '(.+)'\s*$/.exec(line);
      if (entry?.[1] !== undefined) {
        globs.push(entry[1]);
        continue;
      }
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
      break;
    }
    return globs;
  }

  /** Only the shapes these filters actually use: exact paths and `dir/*.ext`. */
  function matches(glob: string, filePath: string): boolean {
    if (!glob.includes('*')) return glob === filePath;
    const pattern = new RegExp(
      `^${glob
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*')}$`,
    );
    return pattern.test(filePath);
  }

  // Recursive, matching the discovery in the suite above and the
  // `docs/**/*.patch` filter entry: a patch filed under a subdirectory must not
  // escape this guard either. An empty list is the healthy state, so there is
  // no minimum-count assertion — `it.each` simply registers nothing.
  const patchPaths = readdirSync('docs', { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.patch'))
    .sort()
    .map((entry) => `docs/${entry}`);

  // The runner rejects a suite that registers zero tests, and this also pins
  // that both filters are still readable when no patch is committed.
  it('reads the pg18Artifacts and rootCi filters out of ci.yml', () => {
    expect([...pathsFilter('pg18Artifacts'), ...pathsFilter('rootCi')].length).toBeGreaterThan(5);
  });

  it.each(patchPaths)('%s leaves no patched file outside pg18Artifacts or rootCi', (patchPath) => {
    // The pg18-artifacts job fires on `pg18Artifacts == 'true' || rootCi == 'true'`,
    // so rootCi's entries (ci.yml, vite.config.ts, package.json) count as covered.
    const gated = [...pathsFilter('pg18Artifacts'), ...pathsFilter('rootCi')];

    // The `a/` side only: those are the paths that exist in the tree today
    // and whose context the patch matches against. A `b/` side that differs
    // is a rename target that does not exist yet, so nothing can edit it.
    const patched = [...readFileSync(patchPath, 'utf8').matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)]
      .map((match) => match[1])
      .filter((filePath): filePath is string => filePath !== undefined);

    // Fail closed per patch: a committed patch that parses to no files means
    // the patch format changed, not that there is nothing to gate.
    expect(patched.length, `${patchPath} parsed to no files, so the patch format changed`).toBeGreaterThan(0);

    const ungated = [...new Set(patched)].filter((filePath) => !gated.some((glob) => matches(glob, filePath))).sort();
    expect(
      ungated,
      [
        'These files are touched by a committed patch but match no pg18Artifacts',
        'or rootCi path, so editing one invalidates the patch with a green PR and',
        `reddens main on push. Add each to the pg18Artifacts filter in ${WORKFLOW_PATH}.`,
      ].join('\n'),
    ).toEqual([]);
  });
});
