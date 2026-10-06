/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  compareNumericVersions,
  parseNumericVersion,
  parseStoreReleaseSnapshot,
  type MobileStorePlatform,
  type StoreReleaseSnapshot,
} from '../packages/shared-schema/src/mobile-store-release';
import {
  createAppStoreConnectJwt,
  createGoogleAccessToken,
  decodePrivateKey,
  parseGoogleProductionReleasesResponse,
  parseGoogleServiceAccount,
  resolveAppId,
} from './mobile-auto-version-bump';
import { parseBuildTag } from './lib/release-tags';

const APPLE_ORIGIN = 'https://api.appstoreconnect.apple.com';
const PLAY_ORIGIN = 'https://androidpublisher.googleapis.com';
const PLAY_PATH = '/androidpublisher/v3/applications/com.boardsesh.app';
type JsonRecord = Record<string, unknown>;
function record(input: unknown): JsonRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Expected JSON object');
  return input as JsonRecord;
}
function collection(input: unknown): unknown[] {
  const entries = record(input).data;
  if (!Array.isArray(entries)) throw new Error('Expected JSON data array');
  return entries;
}
function required(name: string): string {
  const content = process.env[name];
  if (!content?.trim()) throw new Error(`Missing ${name}`);
  return content;
}
async function request(url: string, token: string, method = 'GET', body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: new URL(url).origin === 'https://api.github.com' ? 'application/vnd.github+json' : 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${new URL(url).pathname}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function applePages(path: string, token: string): Promise<unknown[]> {
  let next: string | null = new URL(path, APPLE_ORIGIN).href;
  const visited = new Set<string>();
  const entries: unknown[] = [];
  while (next) {
    const url = new URL(next);
    if (url.origin !== APPLE_ORIGIN || visited.has(next)) throw new Error('Invalid Apple pagination');
    visited.add(next);
    const response = record(await request(next, token));
    entries.push(...collection(response));
    const nextLink = response.links ? record(response.links).next : null;
    if (nextLink !== undefined && nextLink !== null && typeof nextLink !== 'string')
      throw new Error('Invalid Apple next link');
    next = typeof nextLink === 'string' ? nextLink : null;
  }
  return entries;
}
export function publicIosVersions(
  versions: readonly unknown[],
  territories: readonly unknown[],
  nowMs: number,
): string[] {
  const downloadable = territories.some((territory) => {
    const attributes = record(record(territory).attributes);
    if (typeof attributes.available !== 'boolean' || typeof attributes.preOrderEnabled !== 'boolean')
      throw new Error('Missing territory availability');
    if (
      attributes.releaseDate !== undefined &&
      attributes.releaseDate !== null &&
      typeof attributes.releaseDate !== 'string'
    )
      throw new Error('Invalid territory release date');
    const released = !attributes.releaseDate || Date.parse(attributes.releaseDate as string) <= nowMs;
    return attributes.available && !attributes.preOrderEnabled && released;
  });
  if (!downloadable) return [];
  return versions.flatMap((version) => {
    const attributes = record(record(version).attributes);
    if (typeof attributes.appVersionState !== 'string') throw new Error('Missing Apple version state');
    if (attributes.appVersionState !== 'READY_FOR_DISTRIBUTION') return [];
    if (!parseNumericVersion(attributes.versionString as string)) throw new Error('Invalid Apple version');
    return [attributes.versionString as string];
  });
}
export async function collectIosVersions(nowMs: number): Promise<string[]> {
  const token = createAppStoreConnectJwt({
    keyId: required('APP_STORE_CONNECT_API_KEY_ID'),
    issuerId: required('APP_STORE_CONNECT_ISSUER_ID'),
    privateKey: decodePrivateKey(required('APP_STORE_CONNECT_API_KEY_BASE64')),
  });
  const appId = await resolveAppId(token);
  const availability = record(record(await request(`${APPLE_ORIGIN}/v1/apps/${appId}/appAvailabilityV2`, token)).data);
  if (typeof availability.id !== 'string') throw new Error('Missing Apple availability ID');
  const [versions, territories] = await Promise.all([
    applePages(
      `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&fields[appStoreVersions]=versionString,appVersionState&limit=200`,
      token,
    ),
    applePages(
      `/v2/appAvailabilities/${availability.id}/territoryAvailabilities?fields[territoryAvailabilities]=available,preOrderEnabled,releaseDate&limit=200`,
      token,
    ),
  ]);
  return publicIosVersions(versions, territories, nowMs);
}
export function publicAndroidVersions(
  lifecycleResponse: unknown,
  trackResponse: unknown,
  tags: readonly string[],
): string[] {
  const publishedCodes = new Set(
    parseGoogleProductionReleasesResponse(lifecycleResponse)
      .filter((release) => release.releaseLifecycleState === 'RELEASE_LIFECYCLE_STATE_PUBLISHED')
      .flatMap((release) => release.activeArtifacts.map((artifact) => artifact.versionCode)),
  );
  const releases = record(trackResponse).releases;
  if (releases === undefined) return [];
  if (!Array.isArray(releases)) throw new Error('Missing production releases');
  const completedCodes = releases.flatMap((release) => {
    const releaseRecord = record(release);
    if (typeof releaseRecord.status !== 'string') throw new Error('Missing rollout status');
    if (releaseRecord.status !== 'completed') return [];
    if (!Array.isArray(releaseRecord.versionCodes)) throw new Error('Missing completed versionCodes');
    return releaseRecord.versionCodes
      .map((code: unknown) => {
        if (typeof code !== 'string' || !/^\d+$/.test(code) || !Number.isSafeInteger(Number(code)))
          throw new Error('Invalid versionCode');
        return Number(code);
      })
      .filter((code: number) => publishedCodes.has(code));
  });
  return completedCodes.map((code) => {
    const matching = tags.map(parseBuildTag).filter((tag) => tag?.platform === 'android' && tag.buildNumber === code);
    if (matching.length !== 1) throw new Error(`Published Android build ${code} requires one exact build tag`);
    return matching[0]!.version;
  });
}
export async function collectAndroidVersions(tags: readonly string[]): Promise<string[]> {
  const monitorAccount = parseGoogleServiceAccount(required('GOOGLE_PLAY_MONITOR_SERVICE_ACCOUNT_JSON'));
  const publisherAccount = parseGoogleServiceAccount(required('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'));
  if (publisherAccount.client_email === monitorAccount.client_email) {
    throw new Error('Play monitor must use a different client_email from publishing');
  }
  const token = await createGoogleAccessToken(monitorAccount);
  const lifecycle = await request(`${PLAY_ORIGIN}${PLAY_PATH}/tracks/production/releases`, token);
  const edit = record(await request(`${PLAY_ORIGIN}${PLAY_PATH}/edits`, token, 'POST', {}));
  if (typeof edit.id !== 'string' || !edit.id) throw new Error('Missing Google edit ID');
  const editUrl = `${PLAY_ORIGIN}${PLAY_PATH}/edits/${encodeURIComponent(edit.id)}`;
  try {
    const track = await request(`${editUrl}/tracks/production`, token);
    return publicAndroidVersions(lifecycle, track, tags);
  } finally {
    // Never commit this edit. The monitor MUST use a different account from publishing.
    await request(editUrl, token, 'DELETE');
  }
}
export function nextStoreSnapshot(
  prior: StoreReleaseSnapshot | null,
  versions: readonly string[],
  checkedAt: string,
): StoreReleaseSnapshot {
  const checkedMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedMs) || new Date(checkedMs).toISOString() !== checkedAt)
    throw new Error('Invalid check time');
  if (prior && (!parseStoreReleaseSnapshot(prior) || Date.parse(prior.checkedAt) > checkedMs))
    throw new Error('Invalid prior snapshot');
  const firstPublicAtByMinor = { ...prior?.firstPublicAtByMinor };
  const supported = versions
    .filter((version) => {
      if (!parseNumericVersion(version)) throw new Error('Invalid public version');
      return compareNumericVersions(version, '2.6.0')! >= 0;
    })
    .sort((left, right) => compareNumericVersions(right, left)!);
  for (const version of supported) {
    const [major, minor] = parseNumericVersion(version)!;
    firstPublicAtByMinor[`${major}.${minor}`] ??= checkedAt;
  }
  return { schemaVersion: 1, checkedAt, latestVersion: supported[0] ?? null, firstPublicAtByMinor };
}
export async function publishPlatform(
  platform: MobileStorePlatform,
  versions: string[],
  checkedAt: string,
): Promise<void> {
  const token = required('GITHUB_TOKEN');
  const repository = required('GITHUB_REPOSITORY');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
  const base = `https://api.github.com/repos/${repository}/deployments`;
  const environment = `mobile-public-store-${platform}`;
  const deployments = await request(`${base}?environment=${environment}&per_page=1`, token);
  if (!Array.isArray(deployments)) throw new Error('Invalid deployments response');
  let prior: StoreReleaseSnapshot | null = null;
  if (deployments[0]) {
    prior = parseStoreReleaseSnapshot(record(deployments[0]).payload);
    if (!prior) throw new Error(`Malformed ${environment} snapshot; repair explicitly, never reset history`);
  }
  const snapshot = nextStoreSnapshot(prior, versions, checkedAt);
  if (process.env.DRY_RUN === 'true') {
    console.log(`${environment} dry run: ${JSON.stringify(snapshot)}`);
    return;
  }
  const deployment = record(
    await request(base, token, 'POST', {
      ref: required('GITHUB_SHA'),
      environment,
      auto_merge: false,
      required_contexts: [],
      transient_environment: false,
      production_environment: false,
      description: 'Public native store release snapshot',
      payload: snapshot,
    }),
  );
  if (typeof deployment.id !== 'number') throw new Error('Missing deployment ID');
  await request(`${base}/${deployment.id}/statuses`, token, 'POST', {
    state: 'success',
    auto_inactive: false,
    description: 'Public store metadata collected',
  });
}
export async function main(): Promise<number> {
  const checkedAt = new Date().toISOString();
  const tags = execFileSync('git', ['tag', '--list', 'build-android-*'], { encoding: 'utf8' }).trim().split('\n');
  const outcomes = await Promise.allSettled(
    (['ios', 'android'] as const).map(async (platform) => {
      const versions =
        platform === 'ios' ? await collectIosVersions(Date.parse(checkedAt)) : await collectAndroidVersions(tags);
      await publishPlatform(platform, versions, checkedAt);
    }),
  );
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected')
      console.error(
        `[store-monitor ${index === 0 ? 'ios' : 'android'}] ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
      );
  });
  return outcomes.some((outcome) => outcome.status === 'rejected') ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().then((exitCode) => process.exit(exitCode));
