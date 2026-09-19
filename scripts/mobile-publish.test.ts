/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EOAS_PACKAGE_SPEC, SELF_HOSTED_UPLOAD_RATE_PER_SECOND } from './lib/eoas';
import {
  publishSelfHostedPlatformWithRetry,
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

  it('keeps the EAS preview command arguments unchanged', () => {
    const args = buildEasUpdateArgs('fix-branch', 'preview message', 'all');

    expect(args).toEqual([
      'eas-cli@16',
      'update',
      '--branch',
      'fix-branch',
      '--message',
      'preview message',
      '--platform',
      'all',
      '--non-interactive',
    ]);
    // `eas update` has no --upload-rate; passing one would abort the EAS path.
    expect(args).not.toContain('--upload-rate');
  });

  // An update's title used to be `git log --oneline`-shaped, `<short sha> <subject>`.
  // eoas already stores commitHash as its own field, so the sha rendered twice on
  // every dashboard row and stole width from the part a human actually reads. This
  // asserts against REAL git in this checkout, not a fixture: a re-added prefix
  // would have to survive here, not just in a builder that takes the message as an
  // argument.
  it('titles an update from real git, with neither a commit hash nor merge boilerplate', () => {
    const headSubject = execFileSync('git', ['log', '-1', '--format=%s'], { encoding: 'utf-8' }).trim();
    const headShortHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();

    const derived = resolveUpdateMessage(null);

    expect(derived).not.toBe('');
    expect(derived.startsWith(headShortHash)).toBe(false);
    expect(derived).not.toMatch(/^[0-9a-f]{7,40}\s/);
    expect(derived).not.toMatch(/^Merge pull request /);
    // A plain commit is its own title; only a merge commit gets rewritten.
    if (!headSubject.startsWith('Merge pull request ')) {
      expect(derived).toBe(headSubject);
    }
  });

  // `Merge pull request #5020 from boardsesh/fix/ota-republish-after-native-build`
  // says nothing about the change. GitHub puts the PR title on the first body
  // line, so use that and re-attach the number — the same `<title> (#N)` shape a
  // squash merge already writes.
  describe('titleFromCommitMessage', () => {
    it('replaces a GitHub merge subject with the PR title and number', () => {
      expect(
        titleFromCommitMessage(
          'Merge pull request #5020 from boardsesh/fix/ota-republish-after-native-build',
          'fix(ci): republish the OTA after a native build, so the new binary gets it\n',
        ),
      ).toBe('fix(ci): republish the OTA after a native build, so the new binary gets it (#5020)');
    });

    it('does not double up a number the PR title already carries', () => {
      expect(
        titleFromCommitMessage('Merge pull request #5022 from boardsesh/ci/kill-switch', 'ci: kill switch (#5022)'),
      ).toBe('ci: kill switch (#5022)');
    });

    it('falls back to the number when a merge commit has no body', () => {
      expect(titleFromCommitMessage('Merge pull request #77 from boardsesh/x', '')).toBe('Merge #77');
      expect(titleFromCommitMessage('Merge pull request #77 from boardsesh/x', '\n  \n')).toBe('Merge #77');
    });

    it('leaves every other subject alone', () => {
      expect(titleFromCommitMessage('ci: add the kill switch (#5022)', 'body')).toBe('ci: add the kill switch (#5022)');
      // A local `git merge`, not a GitHub PR merge — nothing to recover from the body.
      expect(titleFromCommitMessage("Merge branch 'main' into fix/thing", 'body')).toBe(
        "Merge branch 'main' into fix/thing",
      );
      // Close to the pattern but not it: no PR number to re-attach.
      expect(titleFromCommitMessage('Merge pull request from boardsesh/x', 'body')).toBe(
        'Merge pull request from boardsesh/x',
      );
    });
  });

  it('lets an explicit --message win over the commit subject', () => {
    expect(resolveUpdateMessage('Backport to v2.4.0 (abc1234)')).toBe('Backport to v2.4.0 (abc1234)');
  });

  // Outside a git checkout getCommitSubject() yields ''. Publishing `--message ""`
  // would title the row with an empty string; dropping the flag instead lets eoas
  // fall back to `git log -1 --pretty=%B`.
  it('omits --message entirely rather than publishing an empty title', () => {
    expect(messageArgs('')).toEqual([]);
    expect(messageArgs('fix the queue')).toEqual(['--message', 'fix the queue']);
    expect(buildEasUpdateArgs('fix-branch', '', 'all')).not.toContain('--message');
    expect(buildSelfHostedEoasArgs('production', 'ios', '', { allowDirtyTree: true })).not.toContain('--message');
  });

  it('expands all to sequential iOS and Android targets', () => {
    expect(requestedSelfHostedPlatforms('all')).toEqual(['ios', 'android']);
    expect(requestedSelfHostedPlatforms('ios')).toEqual(['ios']);
    expect(requestedSelfHostedPlatforms('android')).toEqual(['android']);
  });

  it('rejects an invalid self-hosted platform at the exported helper boundary', () => {
    expect(() => requestedSelfHostedPlatforms('windows')).toThrow('Unsupported self-hosted publish platform');
  });

  it('parses the wrapper selector separately from the EAS branch', () => {
    expect(parseArgs(['--channel', 'production', '--platform=ios', '--message', 'release'])).toEqual({
      branch: null,
      channel: 'production',
      message: 'release',
      platform: 'ios',
    });
  });

  it('describes production delivery without calling the branch a baked channel', () => {
    expect(selfHostedPublishSuccessMessages('production')).toEqual([
      '[mobile:publish] Published every requested platform to self-hosted branch "production".',
      '[mobile:publish] Production builds receive it on their next update check.',
    ]);
  });

  it('tells preview publishers to select the branch through xprem', () => {
    expect(selfHostedPublishSuccessMessages('pr-1234')).toEqual([
      '[mobile:publish] Published every requested platform to self-hosted branch "pr-1234".',
      '[mobile:publish] Select "pr-1234" in xprem Branch Surfing to load this preview.',
    ]);
  });

  it('labels self-hosted production and preview modes accurately', () => {
    expect(selfHostedPublishModeLabel('production')).toBe('production (self-hosted expo-open-ota)');
    expect(selfHostedPublishModeLabel('pr-1234')).toBe('preview (self-hosted expo-open-ota)');
  });
});

describe('resolving the runtimeVersion a publish targeted', () => {
  // The critical input to the whole probe: get this wrong and the check asks the
  // server about a branch nobody published under, which is precisely how run
  // 34796068541 failed a healthy publish.
  const env = {} as NodeJS.ProcessEnv;

  it('reads the fingerprint out of the CLI output', () => {
    const runner = vi.fn(() => 'Runtime version: b71bdb600c5a3e954d75c9ca673f056c62247ea9\n') as never;

    expect(resolvePublishedRuntimeVersion('ios', env, runner)).toBe('b71bdb600c5a3e954d75c9ca673f056c62247ea9');
  });

  it('finds it among surrounding chatter', () => {
    // The CLI is free to print progress lines first; the hash is what matters.
    const runner = vi.fn(() => '› Resolving…\nfbc79fa47dc82e393350702a3a3b0d7fe869b164\n› done\n') as never;

    expect(resolvePublishedRuntimeVersion('android', env, runner)).toBe('fbc79fa47dc82e393350702a3a3b0d7fe869b164');
  });

  it('returns null rather than a partial match when no fingerprint is printed', () => {
    // A 39-character string is not a fingerprint, and half a hash would probe a
    // runtimeVersion nothing was published under — worse than not probing.
    const runner = vi.fn(() => 'error: could not resolve\ndeadbeef\n') as never;

    expect(resolvePublishedRuntimeVersion('ios', env, runner)).toBeNull();
  });

  it('returns null when the CLI fails outright', () => {
    const runner = vi.fn(() => {
      throw new Error('vp exec failed');
    }) as never;

    expect(resolvePublishedRuntimeVersion('ios', env, runner)).toBeNull();
  });

  it('gates the check on GitHub Actions specifically, not a generic CI flag', () => {
    // `CI=1` in a local shell is not "resolved on the runner the binaries are built
    // on", which is the property the probe actually depends on.
    expect(runsInGithubActions({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(runsInGithubActions({ CI: '1' })).toBe(false);
    expect(runsInGithubActions({})).toBe(false);
  });
});

describe('preview branch surfability check', () => {
  const SERVER = 'https://updates.boardsesh.com/manifest';
  const IOS_HASH = 'b71bdb600c5a3e954d75c9ca673f056c62247ea9';

  // No delays and no sleeping: the retry SCHEDULE is a constant worth reading in
  // the source, not re-asserting here. What these cover is the decision it drives.
  const NO_WAIT = { delaysMs: [0, 0], sleeper: async () => undefined };
  const ON_IOS = { runtimeVersion: IOS_HASH };

  /** What a platform's publish reported, which is half of the fail decision. */
  function published(platform: OtaPublishPlatform): PlatformPublishOutcome {
    return { platform, success: true, attempts: 1, failureKind: null, noChange: false };
  }
  function deduplicated(platform: OtaPublishPlatform): PlatformPublishOutcome {
    return { platform, success: true, attempts: 1, failureKind: null, noChange: true };
  }

  function serverListing(...branchNames: string[]) {
    return async () =>
      new Response(JSON.stringify({ branches: branchNames.map((name) => ({ name })), total: branchNames.length }), {
        status: 200,
      });
  }

  it('treats a missing runtimeVersion as "cannot check", never as "not surfable"', async () => {
    const fetchImpl = vi.fn();

    // A local publish cannot resolve the hash a shipped binary runs, so it must not
    // probe at all rather than probe with a guess.
    await expect(isPreviewBranchSurfable('pr-5417', 'ios', SERVER, { fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not probe for the production branch', async () => {
    const fetchImpl = vi.fn();

    await expect(isPreviewBranchSurfable('production', 'ios', SERVER, { fetchImpl, ...ON_IOS })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts a listed branch on the first probe without waiting', async () => {
    const sleeper = vi.fn(async () => undefined);

    const result = await isPreviewBranchSurfable('pr-5417', 'ios', SERVER, {
      ...ON_IOS,
      fetchImpl: serverListing('pr-5422', 'pr-5417'),
      sleeper,
      delaysMs: [1000],
    });

    expect(result).toMatchObject({ kind: 'surfable', attempts: 1 });
    expect(sleeper).not.toHaveBeenCalled();
  });

  it('re-probes before calling a branch absent, since the list lags a publish by up to 15s', async () => {
    const empty = serverListing();
    const listed = serverListing('pr-5417');
    const fetchImpl = vi.fn().mockImplementationOnce(empty).mockImplementationOnce(empty).mockImplementation(listed);

    const result = await isPreviewBranchSurfable('pr-5417', 'ios', SERVER, { ...NO_WAIT, ...ON_IOS, fetchImpl });

    // Without this the check would red-X a perfectly good publish, which is worse
    // than the bug it exists to catch.
    expect(result).toMatchObject({ kind: 'surfable', attempts: 3 });
  });

  it('reports "cannot check" rather than a verdict when the server never answers', async () => {
    const result = await isPreviewBranchSurfable('pr-5417', 'ios', SERVER, {
      ...NO_WAIT,
      ...ON_IOS,
      fetchImpl: () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    // An unreachable server is a fact about the server, not about this publish.
    expect(result?.kind).toBe('cannot-check');
  });

  it('fails a deduplicated publish whose branch the server does not list', async () => {
    // Exactly #5417: nothing was created for this platform AND the branch carries
    // nothing for it, so there is genuinely no preview to load. The Android list is
    // otherwise healthy and full of other previews.
    const surfable = await previewBranchPassesSurfabilityCheck('pr-5417', deduplicated('android'), SERVER, {
      ...NO_WAIT,
      runtimeVersion: '154bc941c504727afc914057aed2edff2c096576',
      fetchImpl: serverListing('pr-5422', 'pr-5424', 'pr-5419'),
    });

    expect(surfable).toBe(false);
  });

  it('only warns when a fresh update was created but the probe cannot find it', async () => {
    // The publish said "Update ready", so the branch HAS the update and a probe that
    // disagrees is far more likely measuring the wrong runtimeVersion than finding a
    // real hole. Failing on the probe alone is how run 34796068541 red-X'd a healthy
    // publish. Two independent signals are required, and this is only one.
    const surfable = await previewBranchPassesSurfabilityCheck('pr-5427', published('android'), SERVER, {
      ...NO_WAIT,
      runtimeVersion: 'fbc79fa47dc82e393350702a3a3b0d7fe869b164',
      fetchImpl: serverListing(),
    });

    expect(surfable).toBe(true);
  });

  it('keeps a definitive "not listed" answer when a later probe cannot reach the server', async () => {
    // A probe that FINDS the branch returns immediately, so any real answer during
    // the loop is an answer of "absent". A trailing blip must not erase it and
    // downgrade a genuine finding to "cannot check".
    const answered = serverListing('pr-5422');
    const blip = () => {
      throw new Error('connect ETIMEDOUT');
    };
    const fetchImpl = vi.fn().mockImplementationOnce(answered).mockImplementation(blip);

    const result = await isPreviewBranchSurfable('pr-5417', 'ios', SERVER, { ...NO_WAIT, ...ON_IOS, fetchImpl });

    expect(result?.kind).toBe('not-listed');
    // …and the message quotes the answer the server gave, not the blip.
    expect(result?.detail).toContain('1 branch');
  });

  it('replays #5417 end to end: a deduplicated publish whose branch has nothing for this platform', async () => {
    // The integration seam, driven through the real retry wrapper rather than a
    // hand-made outcome: eoas exits 0 printing the skip notice, the wrapper reports
    // `no-change`, and the probe finds a healthy list without our branch in it.
    const outcome = await publishSelfHostedPlatformWithRetry(
      {
        platform: 'android',
        command: 'vp',
        args: ['dlx', 'eoas@3.1.2', 'publish'],
        cwd: '/repo/packages/mobile',
        env: {} as NodeJS.ProcessEnv,
      },
      {
        runner: async (request) => {
          request.onStdout('●  ⚠️ There is no change in the update for android, ignored...\n');
          request.onStdout('▲  ⚠️ No changes found in the update, nothing to deploy\n');
          return { exitCode: 0 };
        },
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );

    expect(outcome).toMatchObject({ success: true, noChange: true });

    const surfable = await previewBranchPassesSurfabilityCheck('pr-5417', outcome, SERVER, {
      ...NO_WAIT,
      runtimeVersion: '154bc941c504727afc914057aed2edff2c096576',
      fetchImpl: serverListing('pr-5422', 'pr-5424', 'pr-5419'),
    });

    // Under the old code this shipped as "✅ published" and vanished from the
    // Android picker with nothing said anywhere.
    expect(surfable).toBe(false);
  });

  it('lets the publish stand when the check itself throws', async () => {
    // `probeBranchList` swallows transport errors, so the only way out is a throw
    // from the retry machinery. It must not escape as an unhandled rejection and
    // lose the publish's own result.
    const surfable = await previewBranchPassesSurfabilityCheck('pr-5417', deduplicated('ios'), SERVER, {
      ...ON_IOS,
      delaysMs: [1],
      sleeper: () => {
        throw new Error('clock blew up');
      },
      fetchImpl: serverListing('pr-5422'),
    });

    expect(surfable).toBe(true);
  });

  it('passes a platform whose runtimeVersion could not be resolved rather than failing it', async () => {
    const surfable = await previewBranchPassesSurfabilityCheck('pr-5417', deduplicated('android'), SERVER, {
      ...NO_WAIT,
      runtimeVersion: null,
      fetchImpl: serverListing('pr-5417'),
    });

    expect(surfable).toBe(true);
  });

  it('checks each platform against its own runtimeVersion, and skips only the one that has none', async () => {
    // The asymmetry is the whole point: GOOGLE_MAPS_API_KEY is an Android-only
    // fingerprint input, so one platform resolving while the other does not is the
    // ORDINARY mixed case, not an exotic one — and getting it wrong is what failed
    // run 34796068541. iOS is checked and listed; Android has no hash, so it is
    // skipped rather than judged against the iOS list it does not appear in.
    const probed: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      probed.push(`${init.headers['expo-platform']}@${init.headers['expo-runtime-version']}`);
      return new Response(JSON.stringify({ branches: [{ name: 'pr-5417' }], total: 1 }), { status: 200 });
    });

    const platforms: OtaPublishPlatform[] = ['ios', 'android'];
    const results = await Promise.all(
      platforms.map((platform) =>
        previewBranchPassesSurfabilityCheck('pr-5417', deduplicated(platform), SERVER, {
          ...NO_WAIT,
          runtimeVersion: platform === 'ios' ? IOS_HASH : null,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ),
    );

    expect(results).toEqual([true, true]);
    // Android never reached the server; iOS asked about its own hash and nothing else.
    expect(probed).toEqual([`ios@${IOS_HASH}`]);
  });
});
