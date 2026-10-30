/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_CONFIG_PATH, BOT_EMAIL, BOT_NAME, parseSemver, readMarketingVersion } from './release-train-sync';
import { parseVariantSelection, sourceStillOnTrain } from './store-videos-gate';
import {
  changedSearchVariants,
  createCreativeStore,
  createStoreCreativesClient,
  creativeObjectKey,
  creativeObjects,
  parseCreativeManifest,
  type CreativeManifest,
  type CreativeStore,
} from './store-creatives-r2';

const MANIFEST_PATH = 'app-stores/apple/creative-assets.json';
const VARIANTS = ['default', 'kilter', 'tension', 'moonboard', 'spray'];
const LOCALES = ['en-US', 'es', 'fr', 'de'];

/**
 * Refuse an incomplete review set for the recorded variants; preserve the latest main branch's header entries
 * and leave every variant this run did not record exactly as main has it.
 */
export function mergeVideoManifest(
  current: CreativeManifest,
  rendered: CreativeManifest,
  recorded: readonly string[] = VARIANTS,
): CreativeManifest {
  if (
    JSON.stringify(current.storage) !== JSON.stringify(rendered.storage) ||
    JSON.stringify(current.locales) !== JSON.stringify(rendered.locales)
  )
    throw new Error('Creative storage or locale contract changed during recording');
  if (!recorded.length || recorded.some((variant) => !VARIANTS.includes(variant)))
    throw new Error('Recorded variants must be a non-empty subset of the store page variants');
  const variants: CreativeManifest['variants'] = {};
  for (const variant of VARIANTS) {
    if (!current.variants[variant]) throw new Error(`Missing ${variant} configuration on main`);
    if (!recorded.includes(variant)) {
      variants[variant] = current.variants[variant];
      continue;
    }
    const entries = rendered.variants[variant]?.assets.filter((asset) => asset.placement === 'search-results') ?? [];
    if (
      entries.length !== LOCALES.length ||
      LOCALES.some((locale) => entries.filter((asset) => asset.locale === locale).length !== 1) ||
      entries.some((asset) => !asset.poster || !asset.posterSha256)
    )
      throw new Error(`Incomplete video/poster matrix for ${variant}`);
    variants[variant] = {
      ...current.variants[variant],
      assets: [...current.variants[variant].assets.filter((asset) => asset.placement === 'header'), ...entries],
    };
  }
  return { ...current, variants };
}

const SOURCE_TRAILER = 'Store-Video-Source';
const searchEntries = (manifest: CreativeManifest | undefined, variant: string) =>
  manifest?.variants[variant]?.assets.filter((asset) => asset.placement === 'search-results') ?? [];

/** Commit trailers that record which source commit each reviewed variant was recorded from. */
export function videoSourceTrailers(sources: Readonly<Record<string, string>>): string {
  return Object.entries(sources)
    .map(([variant, sha]) => `${SOURCE_TRAILER}: ${variant} ${sha}`)
    .join('\n');
}
export function parseVideoSourceTrailers(message: string): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const match of message.matchAll(/^Store-Video-Source: ([a-z]+) ([a-f0-9]{40})$/gm))
    if (VARIANTS.includes(match[1])) sources[match[1]] = match[2];
  return sources;
}

/**
 * Keep the search entries an earlier subset run of this train put on the open review branch, so recording
 * one variant never drops another from the review. Only variants the branch itself changed against its
 * merge-base with main are carried; everything else, headers included, comes from the latest main, so a
 * later fix on main is never reverted.
 */
export function carryOpenReview(
  current: CreativeManifest,
  review: CreativeManifest | undefined,
  reviewBase: CreativeManifest | undefined,
  version: string,
  recorded: readonly string[],
): { manifest: CreativeManifest; carried: string[] } {
  if (!review || review.marketingVersion !== version) return { manifest: current, carried: [] };
  const variants: CreativeManifest['variants'] = { ...current.variants };
  const carried: string[] = [];
  for (const variant of VARIANTS) {
    if (recorded.includes(variant) || !current.variants[variant]) continue;
    const entries = searchEntries(review, variant);
    if (!entries.length || JSON.stringify(entries) === JSON.stringify(searchEntries(reviewBase, variant))) continue;
    variants[variant] = {
      ...current.variants[variant],
      assets: [...current.variants[variant].assets.filter((asset) => asset.placement === 'header'), ...entries],
    };
    carried.push(variant);
  }
  return { manifest: { ...current, variants }, carried };
}

/** Candidate objects of carried variants that have expired or vanished from R2 (HEAD only, no writes). */
export async function missingCarriedCandidates(
  manifest: CreativeManifest,
  carried: readonly string[],
  store: Pick<CreativeStore, 'head'>,
): Promise<string[]> {
  if (!carried.length) return [];
  const keys = new Set(
    creativeObjects(manifest, carried.join(','), 'search').map((object) =>
      creativeObjectKey('candidates', object.sha256, object.extension),
    ),
  );
  const missing: string[] = [];
  for (const key of keys) if (!(await store.head(key))) missing.push(key);
  return missing;
}

export interface VideoReview {
  /** Variants under review with the source commit each was recorded from (undefined when unknown). */
  sources: Readonly<Record<string, string | undefined>>;
  /** Variants carried from an earlier run, with the review commit they came from. */
  carriedFrom?: Readonly<Record<string, string>>;
  /** Variants whose search entries the merge changes, and so will promote, upload and place. */
  places: readonly string[];
}

export function videoReviewBody(
  manifest: CreativeManifest,
  version: string,
  runUrl: string,
  review: VideoReview,
): string {
  const reviewed = VARIANTS.filter((variant) => variant in review.sources);
  const kept = VARIANTS.filter((variant) => !reviewed.includes(variant));
  const lines = [
    '## Summary',
    '',
    `Review ${reviewed.length * LOCALES.length} Search Results videos (${reviewed.join(', ')}) for train v${version}.`,
    '',
    review.places.length
      ? `Merging places search videos for exactly: ${review.places.join(', ')}. Every other page keeps what App Store Connect already has.`
      : 'Merging changes no search video entry, so it promotes, uploads and places nothing.',
    '',
    ...(kept.length
      ? [`Not in this review: ${kept.join(', ')}. Their entries stay exactly as main has them.`, '']
      : []),
    ...reviewed.map((variant) => {
      const source = review.sources[variant] ?? 'an unrecorded source commit';
      const carried = review.carriedFrom?.[variant];
      return carried
        ? `- ${variant}: carried from earlier review commit ${carried}; recorded from ${source}.`
        : `- ${variant}: recorded from ${source} in this run.`;
    }),
    '',
    `[CI run and timings](${runUrl}).`,
    '',
    'Merging promotes these exact SHA256-addressed candidates to approved storage, verifies downloads, uploads to Asset Library and places them on the editable draft. Apple asset-review submission remains manual.',
    '',
    'Candidates expire after 30 days. Regenerate expired candidates before merging. Header PNG entries are preserved.',
    '',
    '| Variant | Locale | Poster | MP4 | Provenance |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const variant of reviewed) {
    for (const asset of searchEntries(manifest, variant)) {
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

export async function publishVideos(
  version: string,
  sourceSha: string,
  variants = 'all',
  store?: Pick<CreativeStore, 'head'>,
): Promise<void> {
  parseSemver(version);
  const recorded = parseVariantSelection(variants, VARIANTS);
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
  const main = parseCreativeManifest(JSON.parse(git('show', `origin/main:${MANIFEST_PATH}`)));
  const previous = git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`).split(/\s+/)[0] ?? '';
  let review: CreativeManifest | undefined;
  let reviewBase: CreativeManifest | undefined;
  let previousSources: Record<string, string> = {};
  if (previous) {
    git('fetch', '--no-tags', 'origin', previous);
    review = parseCreativeManifest(JSON.parse(git('show', `${previous}:${MANIFEST_PATH}`)));
    // Compare against the main the branch was cut from, not today's main.
    const base = git('merge-base', previous, 'origin/main');
    reviewBase = parseCreativeManifest(JSON.parse(git('show', `${base}:${MANIFEST_PATH}`)));
    previousSources = parseVideoSourceTrailers(git('log', '-1', '--format=%B', previous));
  }
  const { manifest: current, carried } = carryOpenReview(main, review, reviewBase, version, recorded);
  const merged = { ...mergeVideoManifest(current, rendered, recorded), marketingVersion: version };
  const missing = carried.length
    ? await missingCarriedCandidates(
        merged,
        carried,
        store ?? createCreativeStore(createStoreCreativesClient(), merged.storage.bucket),
      )
    : [];
  if (missing.length)
    throw new Error(
      `Carried ${carried.join(', ')} candidates expired or are missing (${missing.length} objects, e.g. ${missing[0]}); re-record ${carried.join(', ')} with this run before review.`,
    );
  const sources: Record<string, string | undefined> = {};
  for (const variant of VARIANTS) {
    if (recorded.includes(variant)) sources[variant] = sourceSha;
    else if (carried.includes(variant)) sources[variant] = previousSources[variant];
  }
  const carriedFrom = Object.fromEntries(carried.map((variant) => [variant, previous]));
  const places = changedSearchVariants(main, merged);
  const directory = mkdtempSync(join(tmpdir(), 'store-video-pr-'));
  try {
    const bodyPath = join(directory, 'body.md');
    writeFileSync(
      bodyPath,
      videoReviewBody(merged, version, `https://github.com/${repository}/actions/runs/${runId}`, {
        sources,
        carriedFrom,
        places,
      }),
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
      const known = Object.fromEntries(
        Object.entries(sources).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      inCheckout(
        'commit',
        '-m',
        `chore(store): review search videos for v${version}`,
        '-m',
        videoSourceTrailers(known),
      );
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
  publishVideos(process.argv[2], process.argv[3], process.argv[4]).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
