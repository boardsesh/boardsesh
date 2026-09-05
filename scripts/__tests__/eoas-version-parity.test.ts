/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OTA_SERVER_VERSION } from '../../infra/railway/config';
import { compareVersions } from '../../infra/railway/plan';
import { EOAS_PACKAGE_SPEC, SELF_HOSTED_UPLOAD_RATE_PER_SECOND } from '../lib/eoas';

/**
 * Root `scripts/` is only partly covered by `vp run typecheck:scripts`, so a
 * version string that drifts out of sync fails nowhere — the runbook happily tells
 * you to deploy one server image while CI publishes with a different CLI. These
 * assertions are the only enforcement.
 *
 * The deployed server version is no longer prose. It lives in
 * `OTA_SERVER_VERSION` (infra/railway/config.ts), which scripts/railway-apply.ts
 * applies and the nightly drift check verifies against the live project. That is
 * what retired the old self-expiring "moves to xprem:vX" marker: it existed only
 * because nothing in the repo could perform the dashboard action, so the prose had
 * to carry the intent. Now the constant carries it, and these tests keep every
 * mention pointing at the constant.
 */
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PINNED_EOAS_VERSION = EOAS_PACKAGE_SPEC.replace(/^eoas@/, '');

/** The upstream image name after the expo-open-ota → xprem rename (v3.1.0). */
const SERVER_IMAGE_NAME = 'xprem';

/**
 * Files where an `eoas@<version>` spec always means "the CLI we publish with".
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
 * Files that name the server image. All of them now mean the same thing — the
 * version `OTA_SERVER_VERSION` declares and railway-apply keeps deployed — so
 * there is no longer a target-versus-deployed split to police.
 */
const SERVER_IMAGE_FILES = [
  'docs/mobile-ota-updates.md',
  'scripts/mobile-ota-setup.ts',
  'CLAUDE.md',
  'AGENTS.md',
] as const;

/**
 * Prerelease-aware on purpose. Upstream ships betas (`v3.2.0-beta3`), the bump
 * workflow proposes them alongside stable releases, and a `\d+\.\d+\.\d+`-only
 * pattern would silently skip every mention of one — reporting parity while the
 * files disagreed.
 */
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const EOAS_SPEC_PATTERN = new RegExp(`eoas@(${VERSION})`, 'g');
const SERVER_IMAGE_PATTERN = new RegExp(
  String.raw`(?:ghcr\.io/mercuretechnologies/)?(xprem|expo-open-ota):v(${VERSION})`,
  'g',
);

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

describe('eoas version parity', () => {
  it('exports a pin in the `eoas@<version>` form the rest of the repo greps for', () => {
    expect(EOAS_PACKAGE_SPEC).toMatch(new RegExp(`^eoas@${VERSION}$`));
  });

  it('keeps every documented eoas spec on the pinned version', () => {
    const drifted = EOAS_SPEC_FILES.flatMap((relativePath) =>
      [...readRepoFile(relativePath).matchAll(EOAS_SPEC_PATTERN)]
        .filter(([, version]) => version !== PINNED_EOAS_VERSION)
        .map(([spec]) => `${relativePath}: ${spec}`),
    );

    expect(drifted).toEqual([]);
  });

  it('keeps every server-image mention on the version config.ts declares', () => {
    const drifted = SERVER_IMAGE_FILES.flatMap((relativePath) =>
      serverImageReferences(relativePath)
        .filter((reference) => reference.version !== OTA_SERVER_VERSION)
        .map((reference) => `${relativePath}: ${reference.text}`),
    );

    expect(drifted).toEqual([]);
  });

  it('names the post-rename image in the forward-looking instructions', () => {
    // Railway pulls the pre-rename `expo-open-ota` path, which is fine and
    // documented — but anything telling a human what to deploy should say xprem.
    for (const relativePath of ['docs/mobile-ota-updates.md', 'scripts/mobile-ota-setup.ts']) {
      const references = serverImageReferences(relativePath);
      expect(references.length).toBeGreaterThan(0);
      expect(references.some((reference) => reference.imageName === SERVER_IMAGE_NAME)).toBe(true);
    }
  });

  it('never lets the deployed server outrank the CLI we publish with', () => {
    // The standing rule from docs/mobile-ota-updates.md: the CLI may lead the
    // server, but a CLI that TRAILS can 404 on app-scoped routes. Enforced here as
    // well as in infra/railway/plan.ts, so the two halves cannot be bumped out of
    // order even in a PR that never runs the apply tool.
    expect(compareVersions(OTA_SERVER_VERSION, PINNED_EOAS_VERSION)).toBeLessThanOrEqual(0);
  });

  it('states the pinned CLI in the OTA doc and the declared server image in the runbook', () => {
    expect(readRepoFile('docs/mobile-ota-updates.md')).toContain(EOAS_PACKAGE_SPEC);
    expect(readRepoFile('scripts/mobile-ota-setup.ts')).toContain(
      `ghcr.io/mercuretechnologies/${SERVER_IMAGE_NAME}:v${OTA_SERVER_VERSION}`,
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
