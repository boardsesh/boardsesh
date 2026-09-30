/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EOAS_PACKAGE_SPEC, SELF_HOSTED_UPLOAD_RATE_PER_SECOND } from './lib/eoas';
import {
  publishSelfHostedPlatformWithRetry,
  PREVIEW_RUNTIME_RESOLUTION_BUDGET_MINUTES,
  type OtaPublishPlatform,
  type PlatformPublishOutcome,
} from './lib/mobile-publish-retry';
import {
  buildEasUpdateArgs,
  buildSelfHostedEoasArgs,
  messageArgs,
  parseArgs,
  requestedSelfHostedPlatforms,
  isPreviewBranchSurfable,
  previewBranchPassesSurfabilityCheck,
  resolvePublishedRuntimeVersion,
  resolveUpdateMessage,
  runsInGithubActions,
  titleFromCommitMessage,
  verifyPreviewBranchIsSurfable,
  selfHostedPublishModeLabel,
  selfHostedPublishSuccessMessages,
  shouldAllowDirtyTree,
} from './mobile-publish';

// The repo's Next global.d.ts augments NodeJS.ProcessEnv to require NODE_ENV, so
// the partial env fixtures below need the assertion to be assignable.
function processEnv(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mobile publish argument routing', () => {
  it('maps the wrapper channel selector to an eoas branch without a deprecated channel flag', () => {
    const args = buildSelfHostedEoasArgs('production', 'ios', 'fix the queue', { allowDirtyTree: true });

    expect(args).toEqual([
      EOAS_PACKAGE_SPEC,
      'publish',
      '--branch',
      'production',
      '--platform',
      'ios',
      '--message',
      'fix the queue',
      '--dumpSourcemap',
      '--outputDir',
      'dist',
      '--disableRepositoryCheck',
      '--upload-rate',
      String(SELF_HOSTED_UPLOAD_RATE_PER_SECOND),
      '--nonInteractive',
      '--packageRunner',
      'vp exec',
    ]);
    expect(args).not.toContain('--channel');
  });

  // The production workflow publishes the regenerated changelog from an
  // UNCOMMITTED tree, so HEAD stays on the triggering commit and the update's
  // message + commitHash name a real commit on main. That only works while eoas'
  // clean-tree guard is off — but only in CI, and only for production. A local
  // `vp run mobile:publish -- --channel production` must still abort on a dirty
  // tree rather than shipping a developer's scratch edits to the fleet.
  it('disables the eoas clean-tree guard only for a production publish running in CI', () => {
    expect(buildSelfHostedEoasArgs('production', 'ios', 'm', { allowDirtyTree: true })).toContain(
      '--disableRepositoryCheck',
    );
    expect(buildSelfHostedEoasArgs('production', 'ios', 'm', { allowDirtyTree: false })).not.toContain(
      '--disableRepositoryCheck',
    );
    expect(buildSelfHostedEoasArgs('production', 'ios', 'm')).not.toContain('--disableRepositoryCheck');
    // Previews publish from a clean PR checkout, so they stay strict even in CI.
    expect(buildSelfHostedEoasArgs('pr-1234', 'ios', 'm', { allowDirtyTree: true })).not.toContain(
      '--disableRepositoryCheck',
    );
  });

  it('allows a dirty tree only under GitHub Actions', () => {
    expect(shouldAllowDirtyTree(processEnv({ GITHUB_ACTIONS: 'true' }))).toBe(true);
    expect(shouldAllowDirtyTree(processEnv({ GITHUB_ACTIONS: 'false' }))).toBe(false);
    expect(shouldAllowDirtyTree(processEnv({}))).toBe(false);
  });

  // The per-PR previews are the concurrent publishes, so they are the ones that
  // most need the rate cap — a production-only flag would miss the burst source.
  it('paces asset uploads on a per-PR preview branch too, not just production', () => {
    const args = buildSelfHostedEoasArgs('pr-1234', 'android', 'preview build');

    const flagIndex = args.indexOf('--upload-rate');
    expect(flagIndex).toBeGreaterThan(-1);
    const rate = Number(args[flagIndex + 1]);
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate).toBeGreaterThan(0);
    // eoas exits 1 on a non-positive/non-numeric rate, so the constant itself has
    // to satisfy the CLI's own validation.
    expect(rate).toBe(SELF_HOSTED_UPLOAD_RATE_PER_SECOND);
    // Source maps stay production-only; the rate cap is not part of that pair.
    expect(args).not.toContain('--dumpSourcemap');
  });

  it('retains the exact staged export and source maps for later production promotion', () => {
    const args = buildSelfHostedEoasArgs('pr-staging', 'ios', 'next main update', { allowDirtyTree: true });
    expect(args).toContain('--disableRepositoryCheck');
    expect(args).toContain('--dumpSourcemap');
    expect(args).toContain('dist');
    expect(args).toContain('pr-staging');
  });

  it('requires EAS to publish an already validated export', () => {
