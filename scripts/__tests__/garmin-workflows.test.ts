/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isDeployRoutedRunsOn, isRoutedRunsOn, withoutCommentLines } from './helpers/workflow-yaml';

/**
 * Contract tests for the Connect IQ pipeline (.github/workflows/garmin-*.yml).
 *
 * The Garmin app sits outside the vp toolchain, has no package.json, and is not
 * a pnpm workspace member, so `vp test --changed` can never relate a Monkey C or
 * workflow edit to a spec. These assertions are the only automated guard on the
 * three properties that are expensive to get wrong: the path filters that keep
 * the pipeline off unrelated pushes, the device list that decides what ships,
 * and the rule that PR builds never touch the irreplaceable signing key.
 */

const CI_PATH = '.github/workflows/garmin-ci.yml';
const RELEASE_PATH = '.github/workflows/garmin-release.yml';
const ACTION_PATH = '.github/actions/connectiq-sdk/action.yml';
const MANIFEST_PATH = 'garmin/manifest.xml';
const DEVICES_PATH = 'garmin/release-devices.txt';

const ciSource = readFileSync(CI_PATH, 'utf8');
const releaseSource = readFileSync(RELEASE_PATH, 'utf8');
const manifestSource = readFileSync(MANIFEST_PATH, 'utf8');

/** Product ids declared in the manifest — the set a build can legally target. */
function manifestProducts(): string[] {
  return [...manifestSource.matchAll(/<iq:product\s+id="([^"]+)"/g)].map(([, id]) => id);
}

/** Product ids we publish a .prg for, ignoring comments and blank lines. */
function releaseDevices(): string[] {
  return readFileSync(DEVICES_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

describe('garmin workflow path filters', () => {
  it.each([
    [CI_PATH, ciSource],
    [RELEASE_PATH, releaseSource],
  ])('%s only triggers on garmin/ and on itself', (path, source) => {
    expect(source).toContain("- 'garmin/**'");
    // Editing the workflow must re-run it, or a broken trigger ships unnoticed.
    // Repo-wide convention; see firmware-build.yml and hold-detector-image.yml.
    expect(source).toContain(`- '${path}'`);
  });

  it('never adds a garmin filter to ci.yml', () => {
    // ci.yml's `changes` job hardcodes every output to 'true' on push, so a
    // Garmin job there would compile on every push to main — the opposite of
    // "only run when the Garmin app has changed".
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).not.toContain('garmin/**');
  });

  it('publishes only from main, never from a pull request', () => {
    const triggers = releaseSource.slice(0, releaseSource.indexOf('jobs:'));
    expect(triggers).toContain('branches: [main]');
    expect(triggers).not.toContain('pull_request');
  });
});

describe('garmin signing-key boundary', () => {
  it('keeps the real developer key out of PR builds', () => {
    // The Connect IQ Store rejects an update signed with a different key, so the
    // key is irreplaceable. PR builds are never installed or distributed and so
    // sign with a throwaway key minted in the job.
    expect(ciSource).not.toContain('GARMIN_DEVELOPER_KEY_BASE64');
    expect(ciSource).toContain('openssl genrsa');
    expect(releaseSource).toContain('GARMIN_DEVELOPER_KEY_BASE64');
  });

  it('skips the PR compile for forks rather than leaking secrets to them', () => {
    expect(ciSource).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  });

  it('names the missing configuration instead of failing obscurely', () => {
    // With no `Garmin` environment every input is empty, the download URL is
    // built from empty version strings, and the only symptom is
    // `gzip: stdin: unexpected end of file`. The preflight says what is missing.
    const action = readFileSync(ACTION_PATH, 'utf8');
    for (const name of [
      'vars.CIQ_SDK_VERSION',
      'vars.CIQ_SDK_MANAGER_VERSION',
      'vars.CIQ_AGREEMENT_HASH',
      'secrets.GARMIN_USERNAME',
      'secrets.GARMIN_PASSWORD',
    ]) {
      expect(action).toContain(name);
    }
  });

  it('never caches the SDK manager config, which holds a live session token', () => {
    const action = readFileSync(ACTION_PATH, 'utf8');
    // Caches are restorable by fork PRs from the base branch. The config lives in
    // $RUNNER_TEMP and is shredded; only ~/.Garmin/ConnectIQ is cached.
    const cachedPath = withoutCommentLines(action).find((line) => line.trim().startsWith('path:'));
    expect(cachedPath?.trim()).toBe('path: ~/.Garmin/ConnectIQ');
    expect(action).toContain('--config $RUNNER_TEMP/ciq-config.yaml');
  });
});

describe('garmin release publication', () => {
  it('updates the release in place rather than deleting it first', () => {
    // garmin-latest is the only way to install the app. Deleting before
    // recreating means a publish that fails halfway leaves every climber with
    // no download at all, so the workflow clobbers assets onto the existing
    // release instead.
    expect(releaseSource).not.toContain('gh release delete garmin-latest');
    expect(releaseSource).toContain('gh release upload');
    expect(releaseSource).toContain('--clobber');
    // ...and prunes assets for watches that have left release-devices.txt,
    // which --clobber alone would strand on the release forever.
    expect(releaseSource).toContain('gh release delete-asset');
  });

  it('verifies published assets against the checksums it built', () => {
    expect(releaseSource).toContain('sha256sum -c');
  });
});

describe('garmin release device list', () => {
  it('lists at least one device', () => {
    expect(releaseDevices().length).toBeGreaterThan(0);
  });

  it('only names products declared in the manifest', () => {
    const declared = new Set(manifestProducts());
    const unknown = releaseDevices().filter((device) => !declared.has(device));
    expect(unknown).toEqual([]);
  });

  it('has no duplicates', () => {
    const devices = releaseDevices();
    expect(devices).toEqual([...new Set(devices)]);
  });
});

describe('garmin runner routing', () => {
  it.each([
    [CI_PATH, ciSource],
    [RELEASE_PATH, releaseSource],
  ])('%s stays on GitHub-hosted runners', (_path, source) => {
    // Both jobs read secrets, and ci-self-hosted-secret-boundary.test.ts forbids
    // that on anything that can land on the homelab fleet. The routing
    // expression is also allowlisted per-job by ci-runner-routing.test.ts, so
    // copying it here would fail that spec.
    const lines = withoutCommentLines(source);
    expect(lines.some(isRoutedRunsOn)).toBe(false);
    expect(lines.some(isDeployRoutedRunsOn)).toBe(false);
    expect(lines.some((line) => line.includes('self-hosted'))).toBe(false);
  });
});
