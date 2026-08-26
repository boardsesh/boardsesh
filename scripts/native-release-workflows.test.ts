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
    expect(ios).toContain('git push --atomic "$remote" "refs/tags/$build_tag" "refs/tags/$fingerprint_tag"');
    expect(android).toContain('git push --atomic "$remote" "refs/tags/$build_tag" "refs/tags/$fingerprint_tag"');
    expect(ios).toContain('Mint repository App token for protected release tags');
    expect(android).toContain('Mint repository App token for protected release tags');
  });

  it('keeps Android candidates private and makes Play internal authoritative', () => {
    expect(android).not.toContain('softprops/action-gh-release');
    expect(android).not.toContain('Create GitHub Release');
    expect(android).toContain('actions/upload-artifact@v4');
    expect(android).toContain('tracks: internal');
    expect(android).toContain('Require Play upload credentials');
  });

  it('rebases with the repository App, an explicit lease, and Discord failure reporting', () => {
    expect(sync).toContain('branches: [main]');
    expect(sync).toContain('actions/create-github-app-token@v1');
    expect(sync).toContain('git rebase --rebase-merges origin/main');
    expect(sync).toContain('--force-with-lease="release/next:$EXPECTED_RELEASE_SHA"');
    expect(sync).toContain('DISCORD_DEPLOY_WEBHOOK');
    expect(sync).toContain('git rebase --abort');
    expect(sync).toContain("'.head.repo.full_name'");
    expect(sync).toContain('permission-workflows: write');
  });

  it('prepares drafts from release/next and treats a missing branch as a no-op', () => {
    expect(draft).toContain('Resolve release/next');
    expect(draft).toContain('exists=false');
    expect(draft).toContain('Select exact uploaded builds for release/next version');
    expect(draft).toContain('Verify tagged builds match release/next native state');
    expect(draft).toContain('Recheck release/next after fingerprint comparison');
    expect(draft).toContain(
      "git fetch --force --tags origin '+refs/heads/release/next:refs/remotes/origin/release/next'",
    );
    expect(draft).toContain('is no longer the unique highest tag');
    expect(draft).toContain('bun install --frozen-lockfile --ignore-scripts');
    expect(draft).toContain('IOS_BUILD_NUMBER');
    expect(draft).toContain('ANDROID_VERSION_CODE');
    const fastfile = readFileSync('fastlane/Fastfile', 'utf8');
    expect(fastfile).toContain('ENV.fetch("IOS_BUILD_NUMBER")');
    expect(fastfile).toContain('ENV.fetch("ANDROID_VERSION_CODE")');
    expect(fastfile).not.toContain('version_code = latest_uploaded_version_code(json_key_data)');
    expect(draft.match(/environment: Native Release/g)).toHaveLength(2);
  });

  it('requires exact accepted candidates and normal PR gates without review-thread resolution', () => {
    expect(monitor).toContain("cron: '*/15 * * * *'");
    expect(monitor).toContain('bun scripts/mobile-auto-version-bump.ts');
    expect(monitor).toContain('bun scripts/mobile-cut-release-tags.ts');
    expect(monitor).toContain("CANDIDATE_ONLY: 'true'");
    expect(monitor).toContain('Compare native fingerprints with identical placeholder inputs');
    expect(monitor).toContain('bun install --frozen-lockfile --ignore-scripts');
    expect(monitor).toContain('reviewDecision');
    expect(monitor).toContain('statusCheckRollup');
    expect(monitor.match(/pageInfo\{hasNextPage\}/g)).toHaveLength(2);
    expect(monitor).toContain('headRepository{nameWithOwner}');
    expect(monitor).toContain('-f sha="$EXPECTED_HEAD_SHA"');
    expect(monitor).toContain('permission-workflows: write');
    expect(monitor).not.toContain('reviewThreads');
  });
});
