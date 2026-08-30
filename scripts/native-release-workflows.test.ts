/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

function workflow(name: string): string {
  return readFileSync(`.github/workflows/${name}`, 'utf8');
}

describe('native release train workflow contracts', () => {
  const ios = workflow('ios-testflight-rn.yml');
  const android = workflow('android-apk-rn.yml');
  const draft = workflow('mobile-store-draft.yml');
  const sync = workflow('release-next-sync.yml');
  const monitor = workflow('release-next-monitor.yml');
  const productionOta = workflow('mobile-ota-production.yml');

  it.each([
    ['ios-testflight-rn.yml', ios],
    ['android-apk-rn.yml', android],
    ['mobile-store-draft.yml', draft],
    ['release-next-sync.yml', sync],
    ['release-next-monitor.yml', monitor],
  ])('%s is valid YAML', (_name, source) => {
    expect(() => parse(source)).not.toThrow();
  });

  it('automatically builds native candidates only from release/next', () => {
    for (const source of [ios, android]) {
      expect(source).toMatch(/push:\n\s+branches: \[release\/next\]/);
      expect(source).not.toMatch(/push:\n\s+branches: \[main\]/);
      expect(source).toContain('environment: Native Release');
    }
    expect(ios).toContain('group: ios-testflight-rn');
    expect(android).toContain('group: android-apk-rn');
    expect(productionOta).toMatch(/push:\n\s+branches: \[main\]/);
    expect(productionOta).not.toMatch(/push:\n\s+branches: \[release\/next\]/);
  });

  it('keeps fingerprint gates and tags store uploads only after success', () => {
    expect(ios).toContain('fingerprint-ios-');
    expect(ios).toContain("steps.testflight_upload.outcome == 'success'");
    expect(android).toContain('fingerprint-android-');
    expect(android).toContain("steps.play_upload.outcome == 'success'");
    expect(android).not.toContain('continue-on-error: true\n        uses: r0adkll/upload-google-play');
    expect(ios).toContain('authenticated_push --atomic "$remote" "refs/tags/$build_tag" "refs/tags/$fingerprint_tag"');
    expect(android).toContain(
      'authenticated_push --atomic "$remote" "refs/tags/$build_tag" "refs/tags/$fingerprint_tag"',
    );
    for (const source of [ios, android]) {
      expect(source).toContain('actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547');
      expect(source).not.toContain('https://x-access-token:${GH_APP_TOKEN}@github.com');
      expect(source).toContain('assert_missing_or_exact');
      expect(source).toContain('if [ -n "$fingerprint_target" ]; then');
      expect(source).toContain('publish_build_tag');
      expect(source).toContain('Preserved immutable $fingerprint_tag');
      expect(source).not.toContain('assert_missing_or_exact "$fingerprint_tag"');
      expect(source).toContain('A concurrent retry already published');
      expect(source).toContain('trap clear_git_auth EXIT');
      expect(source).toContain('git config --local --unset-all http.https://github.com/.extraheader');
      expect(source.indexOf('if [ -n "$fingerprint_target" ]; then')).toBeLessThan(
        source.indexOf('authenticated_push --atomic "$remote"'),
      );
    }
    expect(ios).toContain('Mint repository App token for protected release tags');
    expect(android).toContain('Mint repository App token for protected release tags');
  });

  it('keeps Android candidates private and makes Play internal authoritative', () => {
    expect(android).not.toContain('softprops/action-gh-release');
    expect(android).not.toContain('Create GitHub Release');
    expect(android).toContain('actions/upload-artifact@v4');
    expect(android).toContain('tracks: internal');
    expect(android).toContain('Require Play upload credentials');
    expect(android.indexOf('Require Play upload credentials')).toBeLessThan(android.indexOf('Expo prebuild'));
  });

  it('preserves merge history and confines Opus conflict resolution before the leased push', () => {
    expect(sync).toContain('branches: [main]');
    expect(sync).toContain('actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547');
    expect(sync).toContain('git rev-list --merges --max-count=1 "$EXPECTED_MAIN_SHA..$EXPECTED_RELEASE_SHA"');
    expect(sync).toContain('git rebase "$EXPECTED_MAIN_SHA"');
    expect(sync).toContain('git merge --no-edit --no-ff "$EXPECTED_MAIN_SHA"');
    expect(sync).not.toContain('git rebase --rebase-merges');
    expect(sync).toContain('git rebase --abort');
    expect(sync).toContain(
      'anthropics/claude-code-action/base-action@a874e9ecd7bb36efdad65429c6b35815f5a08f10 # v1.0.210',
    );
    expect(sync).toContain('--model claude-opus-5');
    expect(sync).toContain('--restricted');
    expect(sync).toContain('--safe-mode');
    expect(sync).toContain('--no-session-persistence');
    expect(sync).toContain('--permission-mode dontAsk');
    expect(sync).toContain('--tools "Read,Edit,Grep,Glob,Bash"');
    expect(sync).toContain('--disallowed-tools "mcp__*"');
    expect(sync).not.toContain('github_token: ${{ github.token }}');
    expect(sync).not.toContain('id-token: write');
    expect(sync).toContain('git ls-files --stage -z | sha256sum');
    expect(sync).toContain('git diff --name-only -z');
    expect(sync).toContain('comm -z -23');
    expect(sync).toContain('release-next-out-of-scope.txt');
    expect(sync).toContain('git ls-files --others --exclude-standard -z');
    expect(sync).toContain("while IFS= read -r -d '' conflict_path");
    expect(sync).toContain('git commit --no-edit');
    expect(sync).toContain('vp check > "$RUNNER_TEMP/release-next-vp-check.log"');
    expect(sync).toContain('vp run typecheck');
    expect(sync).toContain('vp test run --reporter=agent');
    expect(sync).toContain('test "$(git rev-parse HEAD^1)" = "$EXPECTED_RELEASE_SHA"');
    expect(sync).toContain('test "$(git rev-parse HEAD^2)" = "$EXPECTED_MAIN_SHA"');
    expect(sync).toContain('git push --atomic');
    expect(sync).toContain('--force-with-lease="refs/heads/release/next:$EXPECTED_RELEASE_SHA"');
    expect(sync).toContain('--force-with-lease="refs/heads/main:$EXPECTED_MAIN_SHA"');
    expect(sync).toContain('"$EXPECTED_MAIN_SHA:refs/heads/main"');
    expect(sync).toContain('DISCORD_DEPLOY_WEBHOOK');
    expect(sync).toContain("'.head.repo.full_name'");
    expect(sync).toContain('permission-workflows: write');
    expect(sync).not.toContain('https://x-access-token:${GH_APP_TOKEN}@github.com');
    expect(sync).toContain('trap clear_git_auth EXIT');
    expect(sync).toContain('check Contents/Workflows write permissions and branch bypass');
    expect(sync).toContain('main moved immediately before push.');
    expect(sync).toContain('release/next moved immediately before push.');
    expect(sync).toContain('The pushed release/next ref does not match the verified update.');
    expect(sync).toContain('main moved during the release push; the queued sync must update release/next again.');
    expect(sync.indexOf('Resolve update conflicts with Claude Opus')).toBeLessThan(
      sync.indexOf('Mint repository App token'),
    );
    const claudeStep = sync.slice(
      sync.indexOf('Resolve update conflicts with Claude Opus'),
      sync.indexOf("Stage and commit Claude's conflict resolution"),
    );
    expect(claudeStep).not.toContain('GH_APP_TOKEN');
    expect(claudeStep).not.toContain('OTA_PUSH_APP_PRIVATE_KEY');
    expect(claudeStep).not.toContain('AGENTS.md');
    expect(claudeStep).not.toContain('Bash(git push');
    expect(claudeStep).not.toContain('Bash(git add');
    expect(claudeStep).not.toContain('Bash(git commit');
    expect(claudeStep).not.toContain('Bash(git merge --continue');
    expect(claudeStep).not.toContain('Bash(git rebase --continue');
    expect(sync.indexOf('Validate the AI conflict resolution')).toBeLessThan(sync.indexOf('Mint repository App token'));
    const rebaseJob = sync.slice(sync.indexOf('  rebase:'), sync.indexOf('  notify-failure:'));
    expect(rebaseJob).not.toContain('environment: Native Release');
    expect(sync).toContain('notify-failure:');
    expect(sync).toContain('environment: Native Release');
    expect(sync).toContain('actions/upload-artifact@v4');
    expect(sync).toContain('actions/download-artifact@v4');
    expect(sync).toContain('details="${details:0:1200}"');
  });

  it('prepares drafts from release/next and treats a missing branch as a no-op', () => {
    expect(draft).toContain('Resolve release/next');
    expect(draft).toContain('exists=false');
    expect(draft).toContain('Select exact uploaded builds for release/next version');
    expect(draft).toContain('version_pattern="${version//./\\\\.}"');
    expect(draft.match(/UPLOADED_ONLY=true/g)).toHaveLength(2);
    expect(draft).not.toContain('function highest(platform)');
    expect(draft).toContain('Verify tagged builds match release/next native state');
    expect(draft).toContain('Recheck release/next after fingerprint comparison');
    expect(draft).toContain(
      "git fetch --force --tags origin '+refs/heads/release/next:refs/remotes/origin/release/next'",
    );
    expect(draft).toContain('are no longer the unique highest tags');
    expect(draft).toContain('uploaded_build=$build_fp');
    expect(draft).toContain('build_tag_fingerprint=$tagged_fp');
    expect(draft).toContain('GOOGLE_MAPS_API_KEY: ${{ secrets.GOOGLE_MAPS_API_KEY }}');
    expect(draft).toContain('Missing GOOGLE_MAPS_API_KEY; Android fingerprint verification');
    expect(draft).not.toContain('boardsesh-release-monitor-placeholder');
    expect(draft).toContain('compare_platform ios ios-build "$EXPECTED_IOS_TAG"');
    expect(draft).toContain('compare_platform android android-build "$EXPECTED_ANDROID_TAG"');
    expect(draft).toContain('bun install --frozen-lockfile --ignore-scripts');
    expect(draft).toContain('IOS_BUILD_NUMBER');
    expect(draft).toContain('ANDROID_VERSION_CODE');
    const fastfile = readFileSync('fastlane/Fastfile', 'utf8');
    expect(fastfile).toContain('ENV.fetch("IOS_BUILD_NUMBER")');
    expect(fastfile).toContain('ENV.fetch("ANDROID_VERSION_CODE")');
    expect(fastfile).not.toContain('version_code = latest_uploaded_version_code(json_key_data)');
    expect(draft.match(/environment: Native Release/g)).toHaveLength(3);
  });

  it('requires exact accepted candidates and normal PR gates without review-thread resolution', () => {
    expect(monitor).toContain("cron: '*/15 * * * *'");
    expect(monitor).toContain('bun scripts/mobile-auto-version-bump.ts');
    expect(monitor).toContain('bun scripts/mobile-cut-release-tags.ts');
    expect(monitor).toContain("CANDIDATE_ONLY: 'true'");
    expect(monitor).toContain('Compare native fingerprints with build-time inputs and immutable tags');
    expect(monitor).toContain('accepted_build=$build_fp');
    expect(monitor).toContain('build_tag_fingerprint=$tagged_fp');
    expect(monitor).toContain('GOOGLE_MAPS_API_KEY: ${{ secrets.GOOGLE_MAPS_API_KEY }}');
    expect(monitor).toContain('Missing GOOGLE_MAPS_API_KEY; Android fingerprint verification');
    expect(monitor).not.toContain('boardsesh-release-monitor-placeholder');
    expect(monitor).toContain('compare_platform ios ios-build "$EXPECTED_IOS_TAG"');
    expect(monitor).toContain('compare_platform android android-build "$EXPECTED_ANDROID_TAG"');
    expect(monitor).toContain('bun install --frozen-lockfile --ignore-scripts');
    expect(monitor).toContain('reviewDecision');
    expect(monitor).toContain('statusCheckRollup');
    expect(monitor).toContain('checks: read');
    expect(monitor).toContain('statuses: read');
    expect(monitor.match(/GH_TOKEN="\$GATE_READ_TOKEN" gh api graphql/g)).toHaveLength(2);
    expect(monitor).not.toContain('https://x-access-token:${GH_TOKEN}@github.com');
    expect(monitor.match(/pageInfo\{hasNextPage\}/g)).toHaveLength(2);
    expect(monitor.match(/more than 100 status checks/g)).toHaveLength(3);
    expect(monitor.match(/statusCheckRollup == null/g)).toHaveLength(3);
    expect(monitor.match(/no status-check rollup yet/g)).toHaveLength(3);
    expect(monitor).toContain('headRepository{nameWithOwner}');
    expect(monitor).toContain('-f sha="$EXPECTED_HEAD_SHA"');
    expect(monitor).toContain('permission-workflows: write');
    expect(monitor.match(/bun scripts\/mobile-auto-version-bump\.ts/g)).toHaveLength(2);
    expect(monitor).toContain('Accepted store builds or their exact build tags moved before merge');
    expect(monitor).toContain('cleanup_new_anchors');
    expect(monitor).toContain('grep -Fxq "created_anchor=$tag"');
    expect(monitor).toContain('--force-with-lease="refs/tags/${tag}:${expected}"');
    expect(monitor).toContain('trap clear_git_auth EXIT');
    expect(monitor).toContain('authenticated_push --force-with-lease=');
    expect(monitor).toContain('The merge outcome is unknown; release anchors were retained for safety');
    expect(monitor.indexOf('Accepted store builds or their exact build tags moved before merge')).toBeLessThan(
      monitor.indexOf('DRY_RUN=false bun scripts/mobile-cut-release-tags.ts'),
    );
    expect(monitor.indexOf('test "$checks_green" = true')).toBeLessThan(
      monitor.indexOf('DRY_RUN=false bun scripts/mobile-cut-release-tags.ts'),
    );
    expect(monitor).toContain('Failed to clean up an incomplete anchor set');
    expect(monitor).toContain('final_merge_gates_ready');
    expect(monitor).toContain('changed after anchor creation; merge stopped');
    expect(monitor.indexOf('final_merge_gates_ready')).toBeLessThan(monitor.indexOf('result="$(gh api --method PUT'));
    expect(monitor).not.toContain('reviewThreads');
  });

  it('keeps the established main anchor on Production during Native Release rollout', () => {
    const anchor = workflow('mobile-auto-version-bump.yml');
    expect(anchor).toContain('environment: Production');
    expect(anchor).not.toContain('environment: Native Release');
  });
});
