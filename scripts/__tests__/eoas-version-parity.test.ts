/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EOAS_PACKAGE_SPEC, SELF_HOSTED_UPLOAD_RATE_PER_SECOND } from '../lib/eoas';

/**
 * Root `scripts/` is not covered by any `vp run typecheck:*` task, so a version
 * string that drifts out of sync with `EOAS_PACKAGE_SPEC` fails nowhere — the
 * runbook happily tells you to deploy one server image while CI publishes with a
 * different CLI. These assertions are the only enforcement.
 */
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PINNED_EOAS_VERSION = EOAS_PACKAGE_SPEC.replace(/^eoas@/, '');

/** The upstream image name after the expo-open-ota → xprem rename (v3.1.0). */
const SERVER_IMAGE_NAME = 'xprem';

/**
 * Files where an `eoas@<x.y.z>` spec always means "the CLI we publish with".
 * Excludes scripts/lib/eoas.ts (the source of truth) and any file that discusses
 * older releases historically — write those as bare versions (`3.1.1`), never as
 * `eoas@3.1.1`.
 */
const EOAS_SPEC_FILES = [
  'docs/mobile-ota-updates.md',
  'scripts/mobile-ota-setup.ts',
  'scripts/mobile-ota-rollback.ts',
  '.github/workflows/mobile-ota-backport.yml',
  'CLAUDE.md',
  'AGENTS.md',
] as const;

/**
 * Files that tell you which server image to DEPLOY. Forward-looking instructions,
 * so they always name the target that matches the pin.
 */
const SERVER_IMAGE_TARGET_FILES = ['docs/mobile-ota-updates.md', 'scripts/mobile-ota-setup.ts'] as const;

/**
 * Files that describe the image CURRENTLY RUNNING on Railway. That is infra
 * state, not repo state, so it legitimately trails the pin between a CLI bump
 * (a PR) and the hand-off (a dashboard action nothing here can perform). The
 * rule is self-expiring: while it trails, the file must name the target it moves
 * to; the moment it reaches the target, that pending note has to go. Bumping one
 * without the other fails, in either direction.
 */
const SERVER_IMAGE_DEPLOYED_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;
const PENDING_BUMP_MARKER = `moves to \`${SERVER_IMAGE_NAME}:v${PINNED_EOAS_VERSION}\``;

const EOAS_SPEC_PATTERN = /eoas@(\d+\.\d+\.\d+)/g;
const SERVER_IMAGE_PATTERN = /(?:ghcr\.io\/mercuretechnologies\/)?(xprem|expo-open-ota):v(\d+\.\d+\.\d+)/g;

function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT_DIR, relativePath), 'utf-8');
}

function serverImageReferences(relativePath: string): { imageName: string; version: string; text: string }[] {
  return [...readRepoFile(relativePath).matchAll(SERVER_IMAGE_PATTERN)].map(([text, imageName, version]) => ({
    imageName,
    version,
    text,
  }));
}

function isPinnedTarget(reference: { imageName: string; version: string }): boolean {
  return reference.imageName === SERVER_IMAGE_NAME && reference.version === PINNED_EOAS_VERSION;
}

describe('eoas version parity', () => {
  it('exports a pin in the `eoas@<x.y.z>` form the rest of the repo greps for', () => {
    expect(EOAS_PACKAGE_SPEC).toMatch(/^eoas@\d+\.\d+\.\d+$/);
  });

  it('keeps every documented eoas spec on the pinned version', () => {
    const drifted = EOAS_SPEC_FILES.flatMap((relativePath) =>
      [...readRepoFile(relativePath).matchAll(EOAS_SPEC_PATTERN)]
        .filter(([, version]) => version !== PINNED_EOAS_VERSION)
        .map(([spec]) => `${relativePath}: ${spec}`),
    );

    expect(drifted).toEqual([]);
  });

  it('keeps every deploy instruction on the matching xprem tag', () => {
    const drifted = SERVER_IMAGE_TARGET_FILES.flatMap((relativePath) =>
      serverImageReferences(relativePath)
        .filter((reference) => !isPinnedTarget(reference))
        .map((reference) => `${relativePath}: ${reference.text}`),
    );

    expect(drifted).toEqual([]);
  });

  it.each(SERVER_IMAGE_DEPLOYED_FILES)("keeps %s's pending-bump note in step with its server version", (file) => {
    const references = serverImageReferences(file);
    expect(references.length).toBeGreaterThan(0);

    if (references.some((reference) => !isPinnedTarget(reference))) {
      // Still on the old image: the file has to say where it is going, so nobody
      // reads the trailing version as the current target.
      expect(readRepoFile(file)).toContain(PENDING_BUMP_MARKER);
    } else {
      // Railway is on the pinned image — drop the now-misleading pending note.
      expect(readRepoFile(file)).not.toContain(PENDING_BUMP_MARKER);
    }
  });

  it('states the pinned CLI in the OTA doc and the server image in the setup runbook', () => {
    expect(readRepoFile('docs/mobile-ota-updates.md')).toContain(EOAS_PACKAGE_SPEC);
    expect(readRepoFile('scripts/mobile-ota-setup.ts')).toContain(
      `ghcr.io/mercuretechnologies/${SERVER_IMAGE_NAME}:v${PINNED_EOAS_VERSION}`,
    );
  });

  it('documents the upload-rate cap alongside the pin', () => {
    // eoas exits 1 on a non-positive or non-numeric --upload-rate, so the
    // constant has to survive the CLI's own validation before it survives ours.
    expect(Number.isFinite(SELF_HOSTED_UPLOAD_RATE_PER_SECOND)).toBe(true);
    expect(SELF_HOSTED_UPLOAD_RATE_PER_SECOND).toBeGreaterThan(0);
    expect(readRepoFile('docs/mobile-ota-updates.md')).toContain(`--upload-rate ${SELF_HOSTED_UPLOAD_RATE_PER_SECOND}`);
  });
});
