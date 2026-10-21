/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_CONFIG_PATH, BOT_EMAIL, BOT_NAME, parseSemver, readMarketingVersion } from './release-train-sync';
import { sourceStillOnTrain } from './store-videos-gate';
import { creativeObjectKey, parseCreativeManifest, type CreativeManifest } from './store-creatives-r2';

const MANIFEST_PATH = 'app-stores/apple/creative-assets.json';
const VARIANTS = ['default', 'kilter', 'tension', 'moonboard', 'spray'];
const LOCALES = ['en-US', 'es', 'fr', 'de'];

/** Refuse an incomplete review set; preserve the latest main branch's header entries. */
export function mergeVideoManifest(current: CreativeManifest, rendered: CreativeManifest): CreativeManifest {
  if (
    JSON.stringify(current.storage) !== JSON.stringify(rendered.storage) ||
    JSON.stringify(current.locales) !== JSON.stringify(rendered.locales)
  )
    throw new Error('Creative storage or locale contract changed during recording');
  const variants: CreativeManifest['variants'] = {};
  for (const variant of VARIANTS) {
    const entries = rendered.variants[variant]?.assets.filter((asset) => asset.placement === 'search-results') ?? [];
    if (
      entries.length !== LOCALES.length ||
      LOCALES.some((locale) => entries.filter((asset) => asset.locale === locale).length !== 1) ||
      entries.some((asset) => !asset.poster || !asset.posterSha256)
    )
      throw new Error(`Incomplete video/poster matrix for ${variant}`);
    if (!current.variants[variant]) throw new Error(`Missing ${variant} configuration on main`);
    variants[variant] = {
      ...current.variants[variant],
      assets: [...current.variants[variant].assets.filter((asset) => asset.placement === 'header'), ...entries],
    };
  }
  return { ...current, variants };
}

export function videoReviewBody(
  manifest: CreativeManifest,
  version: string,
  sourceSha: string,
  runUrl: string,
): string {
  const lines = [
    '## Summary',
    '',
    `Review all 20 Search Results videos for train v${version}.`,
    '',
    `Recorded from ${sourceSha}. [CI run and timings](${runUrl}).`,
    '',
    'Merging promotes these exact SHA256-addressed candidates to approved storage, verifies downloads, uploads to Asset Library and places them on the editable draft. Apple asset-review submission remains manual.',
    '',
    'Candidates expire after 30 days. Regenerate expired candidates before merging. Header PNG entries are preserved.',
    '',
    '| Variant | Locale | Poster | MP4 | Provenance |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [variant, configuration] of Object.entries(manifest.variants)) {
    for (const asset of configuration.assets.filter((entry) => entry.placement === 'search-results')) {
      if (!asset.posterSha256) throw new Error('Missing review poster');
      const url = (sha: string, extension: string) =>
        `${manifest.storage.baseUrl}/${creativeObjectKey('candidates', sha, extension)}`;
      lines.push(
        `| ${variant} | ${asset.locale} | ![${variant} ${asset.locale}](${url(asset.posterSha256, 'jpg')}) | [Play video](${url(asset.sha256, 'mp4')}) | [Native sources](${url(asset.provenanceSha256, 'json')}) |`,
      );
    }
  }
  return [
    ...lines,
    '',
    '## Release Notes',
    '',
    'none',
    '',
    '- [x] No release note needed (internal / technical change)',
    '',
    '## Test plan',
    '',
    '1. CI green.',
    '',
    '## Risk',
    '',
    'Risk: 4/5 — merging updates App Store creative placements; live/replacement guards remain enabled.',
    '',
  ].join('\n');
}

export function publishVideos(version: string, sourceSha: string): void {
  parseSemver(version);
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Expected a full recording source commit');
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repository || !runId) throw new Error('Publishing requires a GitHub Actions run');
  const git = (...args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }).trim();
  const gh = (...args: string[]) =>
    execFileSync('gh', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }).trim();
  const rendered = parseCreativeManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
  const branch = `store-videos/v${version}`;
  const existing = JSON.parse(
    gh(
      'pr',
      'list',
      '--repo',
      repository,
      '--head',
      branch,
      '--base',
      'main',
      '--state',
      'all',
      '--json',
      'number,state',
    ),
  ) as { number: number; state: string }[];
  if (existing.some((pullRequest) => pullRequest.state === 'MERGED')) {
    console.log(`Train v${version} already has approved videos; keeping its single review PR.`);
    return;
  }
  if (existing.some((pullRequest) => pullRequest.state === 'CLOSED'))
    throw new Error('This train review PR was closed; reopen it before regenerating');
  git('fetch', '--no-tags', 'origin', 'main', 'release/next');
  // Ordinary train syncs may advance HEAD without shipping a newer build.
  const trainSha = git('rev-parse', 'origin/release/next');
  const trainVersion = readMarketingVersion(git('show', `origin/release/next:${APP_CONFIG_PATH}`));
  const comparison =
    sourceSha === trainSha
      ? 'identical'
      : gh('api', `repos/${repository}/compare/${sourceSha}...${trainSha}`, '--jq', '.status');
  if (!sourceStillOnTrain(version, trainVersion, comparison))
    throw new Error('Recording source no longer belongs to the open train');
  const current = parseCreativeManifest(JSON.parse(git('show', `origin/main:${MANIFEST_PATH}`)));
  const merged = { ...mergeVideoManifest(current, rendered), marketingVersion: version };
  const previous = git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`).split(/\s+/)[0] ?? '';
  const directory = mkdtempSync(join(tmpdir(), 'store-video-pr-'));
  try {
    const bodyPath = join(directory, 'body.md');
    writeFileSync(
      bodyPath,
      videoReviewBody(merged, version, sourceSha, `https://github.com/${repository}/actions/runs/${runId}`),
    );
    // Create the commit in an isolated worktree so generated exports remain available.
    const checkout = join(directory, 'checkout');
    git('worktree', 'add', '--detach', '--no-checkout', checkout, 'origin/main');
    symlinkSync(resolve('node_modules'), join(checkout, 'node_modules'), 'dir');
    const inCheckout = (...args: string[]) =>
      execFileSync('git', ['-C', checkout, ...args], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: BOT_NAME,
          GIT_AUTHOR_EMAIL: BOT_EMAIL,
          GIT_COMMITTER_NAME: BOT_NAME,
          GIT_COMMITTER_EMAIL: BOT_EMAIL,
        },
      }).trim();
    inCheckout('checkout', '--detach', 'origin/main');
    writeFileSync(join(checkout, MANIFEST_PATH), `${JSON.stringify(merged, null, 2)}\n`);
    inCheckout('add', MANIFEST_PATH);
    if (inCheckout('diff', '--cached', '--name-only')) {
      inCheckout('commit', '-m', `chore(store): review search videos for v${version}`);
    }
    gh('auth', 'setup-git', '--hostname', 'github.com');
    inCheckout('push', `--force-with-lease=refs/heads/${branch}:${previous}`, 'origin', `HEAD:refs/heads/${branch}`);
    const pullRequests = JSON.parse(
      gh('pr', 'list', '--repo', repository, '--head', branch, '--base', 'main', '--state', 'open', '--json', 'number'),
    ) as { number: number }[];
    if (pullRequests.length > 1) throw new Error('Multiple review PRs for one train');
    if (pullRequests[0]) {
      gh('pr', 'edit', String(pullRequests[0].number), '--repo', repository, '--body-file', bodyPath);
    } else {
      gh(
        'pr',
        'create',
        '--repo',
        repository,
        '--base',
        'main',
        '--head',
        branch,
        '--draft',
        '--title',
        `Review App Store search videos for v${version}`,
        '--body-file',
        bodyPath,
      );
    }
    git('worktree', 'remove', checkout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    git('worktree', 'prune');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    publishVideos(process.argv[2], process.argv[3]);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
