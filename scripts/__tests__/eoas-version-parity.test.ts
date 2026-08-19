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
 * Files where an `eoas@<x.y.z>` spec or a mercuretechnologies image tag always
 * means "the pinned CLI" / "the server it talks to". Deliberately excludes
 * scripts/lib/eoas.ts (the source of truth) and any file that discusses older
 * releases historically — write those as bare versions (`3.1.1`), not `eoas@3.1.1`.
 */
const VERSIONED_FILES = [
  'docs/mobile-ota-updates.md',
  'scripts/mobile-ota-setup.ts',
  'scripts/mobile-ota-rollback.ts',
  '.github/workflows/mobile-ota-backport.yml',
] as const;

const EOAS_SPEC_PATTERN = /eoas@(\d+\.\d+\.\d+)/g;
const SERVER_IMAGE_PATTERN = /(?:ghcr\.io\/mercuretechnologies\/)?(xprem|expo-open-ota):v(\d+\.\d+\.\d+)/g;

function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT_DIR, relativePath), 'utf-8');
}

describe('eoas version parity', () => {
  it('exports a pin in the `eoas@<x.y.z>` form the rest of the repo greps for', () => {
    expect(EOAS_PACKAGE_SPEC).toMatch(/^eoas@\d+\.\d+\.\d+$/);
  });

  it('keeps every documented eoas spec on the pinned version', () => {
    const drifted = VERSIONED_FILES.flatMap((relativePath) =>
      [...readRepoFile(relativePath).matchAll(EOAS_SPEC_PATTERN)]
        .filter(([, version]) => version !== PINNED_EOAS_VERSION)
        .map(([spec]) => `${relativePath}: ${spec}`),
    );

    expect(drifted).toEqual([]);
  });

  it('keeps every documented server image on the matching xprem tag', () => {
    const drifted = VERSIONED_FILES.flatMap((relativePath) =>
      [...readRepoFile(relativePath).matchAll(SERVER_IMAGE_PATTERN)]
        .filter(([, imageName, version]) => imageName !== SERVER_IMAGE_NAME || version !== PINNED_EOAS_VERSION)
        .map(([reference]) => `${relativePath}: ${reference}`),
    );

    expect(drifted).toEqual([]);
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
