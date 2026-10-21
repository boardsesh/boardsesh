/// <reference types="node" />

// Keep this entry point dependency-free: closed trains exit before vp install.
import { createPrivateKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  APP_CONFIG_PATH,
  createGhGitHubClient,
  createGitClient,
  isVersionTaken,
  parseAnchoredIosVersions,
  readMarketingVersion,
  selectLastMergedBack,
} from './release-train-sync.ts';

export interface VideoSource {
  sourceSha: string;
  sourceBranch: 'release/next';
  version: string;
  iosBuild: string;
}

export function sourceStillOnTrain(sourceVersion: string, trainVersion: string, comparison: string): boolean {
  return sourceVersion === trainVersion && (comparison === 'ahead' || comparison === 'identical');
}

export function parseVideoSource(input: unknown): VideoSource {
  if (!input || typeof input !== 'object') throw new Error('Invalid draft video source');
  const source = input as Partial<VideoSource>;
  if (
    source.sourceBranch !== 'release/next' ||
    !/^[a-f0-9]{40}$/.test(source.sourceSha ?? '') ||
    !/^\d+\.\d+\.\d+$/.test(source.version ?? '') ||
    !/^\d+$/.test(source.iosBuild ?? '')
  ) {
    throw new Error('Draft video source needs release/next, a full commit, version and uploaded iOS build');
  }
  return source as VideoSource;
}

export function appleToken(env: NodeJS.ProcessEnv = process.env, now = Math.floor(Date.now() / 1000)): string {
  const keyId = env.APP_STORE_CONNECT_API_KEY_ID;
  const issuer = env.APP_STORE_CONNECT_ISSUER_ID;
  const encodedKey = env.APP_STORE_CONNECT_API_KEY_BASE64;
  if (!keyId || !issuer || !encodedKey) throw new Error('Missing App Store Connect credentials');
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }),
  ).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey(Buffer.from(encodedKey, 'base64'));
  return `${signingInput}.${sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

interface AppleResource {
  id: string;
  attributes: Record<string, unknown>;
}

export async function appleList(path: string, token: string, request: typeof fetch = fetch): Promise<AppleResource[]> {
  const resources: AppleResource[] = [];
  let next: string | undefined = `https://api.appstoreconnect.apple.com${path}`;
  for (let page = 0; next && page < 100; page += 1) {
    const url = new URL(next);
    if (url.origin !== 'https://api.appstoreconnect.apple.com') throw new Error('Unexpected Apple pagination origin');
    const response = await request(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Apple read failed (HTTP ${response.status})`);
    const document = (await response.json()) as { data: AppleResource[]; links?: { next?: string } };
    if (!Array.isArray(document.data)) throw new Error('Unexpected Apple list response');
    resources.push(...document.data);
    next = document.links?.next;
  }
  if (next) throw new Error('Apple pagination exceeded 100 pages');
  return resources;
}

export function editableVersion(versions: AppleResource[], marketingVersion: string): AppleResource | undefined {
  const editableStates = ['PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW', 'REJECTED'];
  const matches = versions.filter(
    (version) =>
      version.attributes.versionString === marketingVersion &&
      editableStates.includes(String(version.attributes.appVersionState || version.attributes.appStoreState)),
  );
  if (matches.length > 1) throw new Error('Multiple editable iOS versions match this train');
  return matches[0];
}

export async function gate(
  sourceFile?: string,
  trainOnly = false,
  pin?: { sourceSha: string; version: string },
): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('Missing GITHUB_REPOSITORY');
  const git = createGitClient({ cwd: process.cwd(), remote: 'origin' });
  execFileSync(
    'git',
    [
      'fetch',
      '--depth=1',
      '--no-tags',
      '--quiet',
      'origin',
      '+refs/heads/release/next:refs/remotes/origin/release/next',
    ],
    { timeout: 20_000 },
  );
  const trainSha = git.remoteTrackingSha('release/next');
  const trainVersion = readMarketingVersion(git.readFile(trainSha, APP_CONFIG_PATH));
  let reason = '';
  let source: VideoSource | undefined;
  if (sourceFile) {
    source = parseVideoSource(JSON.parse(readFileSync(sourceFile, 'utf8')));
    pin = source;
  }
  const sourceSha = pin?.sourceSha ?? trainSha;
  const version = pin?.version ?? trainVersion;
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Invalid recording source pin');
  if (version !== trainVersion) reason = 'Recording belongs to a different marketing version';
  if (!reason && sourceSha !== trainSha) {
    const comparison = execFileSync(
      'gh',
      ['api', `repos/${repository}/compare/${sourceSha}...${trainSha}`, '--jq', '.status'],
      { encoding: 'utf8', timeout: 15_000 },
    ).trim();
    if (!sourceStillOnTrain(version, trainVersion, comparison))
      reason = 'Recording source is no longer part of this train';
    else {
      execFileSync('git', ['fetch', '--depth=1', '--no-tags', '--quiet', 'origin', sourceSha], { timeout: 20_000 });
      if (readMarketingVersion(git.readFile(sourceSha, APP_CONFIG_PATH)) !== version)
        throw new Error('Recording source version does not match its pin');
    }
  }
  const github = createGhGitHubClient({ repository, cwd: process.cwd() });
  const lastMerged = selectLastMergedBack(github.listMergedBackPullRequests());
  if (lastMerged)
    execFileSync('git', ['fetch', '--depth=1', '--no-tags', '--quiet', 'origin', lastMerged.mergeCommitOid], {
      timeout: 20_000,
    });
  const lastMergedBackVersion = lastMerged
    ? readMarketingVersion(git.readFile(lastMerged.mergeCommitOid, APP_CONFIG_PATH))
    : undefined;
  const anchoredIosVersions = parseAnchoredIosVersions(git.lsRemote(['refs/tags/release/ios-v*'], { tags: true }));
  if (isVersionTaken(version, { lastMergedBackVersion, anchoredIosVersions }))
    reason = `v${version} is taken; the train is closed`;
  if (!reason) {
    const reviews = JSON.parse(
      execFileSync(
        'gh',
        [
          'pr',
          'list',
          '--repo',
          repository,
          '--head',
          `store-videos/v${version}`,
          '--base',
          'main',
          '--state',
          'all',
          '--json',
          'state',
        ],
        { encoding: 'utf8', timeout: 15_000 },
      ),
    ) as { state: string }[];
    if (reviews.some((review) => review.state === 'MERGED')) reason = `v${version} already has approved videos`;
    else if (reviews.some((review) => review.state === 'CLOSED'))
      reason = `The v${version} review PR was closed; reopen it to regenerate`;
  }
  if (!reason && !trainOnly) {
    const token = appleToken();
    const apps = await appleList('/v1/apps?filter[bundleId]=com.boardsesh.app&limit=2', token);
    if (apps.length !== 1) throw new Error('Need exactly one Boardsesh App Store app');
    const versions = await appleList(`/v1/apps/${apps[0].id}/appStoreVersions?filter[platform]=IOS&limit=200`, token);
    if (!editableVersion(versions, version)) reason = `No editable iOS draft exists for v${version}`;
  }
  const open = reason === '';
  const output = `open=${open}\nversion=${version}\nsource_sha=${sourceSha}\nbranch=store-videos/v${version}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  console.log(
    open ? `Open train v${version} at ${sourceSha}${source ? ` (iOS build ${source.iosBuild})` : ''}` : reason,
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${open ? `Open train v${version}` : reason}\n`);
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  if (command === 'gate') {
    const args = process.argv.slice(3);
    let sourceFile: string | undefined;
    let pinnedSha: string | undefined;
    let pinnedVersion: string | undefined;
    let trainOnly = false;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--train-only') trainOnly = true;
      else if (args[index] === '--pinned-sha') pinnedSha = args[++index];
      else if (args[index] === '--pinned-version') pinnedVersion = args[++index];
      else if (!args[index].startsWith('--') && !sourceFile) sourceFile = args[index];
      else throw new Error(`Invalid gate argument ${args[index]}`);
    }
    if (Boolean(pinnedSha) !== Boolean(pinnedVersion) || (sourceFile && pinnedSha))
      throw new Error('Supply either a draft source file or both recording pins');
    return gate(
      sourceFile,
      trainOnly,
      pinnedSha && pinnedVersion ? { sourceSha: pinnedSha, version: pinnedVersion } : undefined,
    );
  }
  if (command === 'refdata' && argument) {
    writeFileSync(
      argument,
      `${JSON.stringify(await appleList('/v1/appAssetLibraryRefData', appleToken()), null, 2)}\n`,
    );
    return;
  }
  if (command === 'takes' && argument) {
    // This subcommand runs after dependency installation (the gate above does not).
    const { storeSearchTakeIds } = await import('./lib/showcase-video/store-search');
    const { SHOWCASE_VARIANT_KINDS } = await import('./lib/showcase-video/contract');
    if (!(SHOWCASE_VARIANT_KINDS as readonly string[]).includes(argument)) throw new Error('Unknown variant');
    const takes = storeSearchTakeIds(argument as (typeof SHOWCASE_VARIANT_KINDS)[number]).filter(
      (take) => take !== 'crew' && take !== 'lock-screen',
    );
    console.log(takes.join(','));
    return;
  }
  throw new Error('Usage: store-videos-gate.ts gate [draft-source.json] | refdata FILE | takes VARIANT');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
