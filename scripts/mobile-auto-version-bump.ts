/// <reference types="node" />

import { appendFileSync, readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_STORE_CONNECT_API_BASE = 'https://api.appstoreconnect.apple.com';
const GOOGLE_PLAY_API_BASE = 'https://androidpublisher.googleapis.com';
const GOOGLE_PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const BUNDLE_ID = 'com.boardsesh.app';
const ANDROID_PACKAGE_NAME = 'com.boardsesh.app';

// App Store states that indicate Apple has accepted the submission. A version in
// any of these states is anchored (release/* tag) so a JS fix can be backported to
// it. We do NOT bump the marketing version on acceptance — that busts the fingerprint
// of the binary already in the field and strands its OTAs (see main() below).
export const ACCEPTED_APP_STORE_STATES = [
  'ACCEPTED',
  'PENDING_DEVELOPER_RELEASE',
  'PENDING_APPLE_RELEASE',
  'PROCESSING_FOR_DISTRIBUTION',
  'READY_FOR_DISTRIBUTION',
] as const;

export const ACCEPTED_GOOGLE_PLAY_STATES = [
  'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED',
  'RELEASE_LIFECYCLE_STATE_PUBLISHED',
] as const;

const acceptedAppStoreStateSet = new Set<string>(ACCEPTED_APP_STORE_STATES);
const acceptedGooglePlayStateSet = new Set<string>(ACCEPTED_GOOGLE_PLAY_STATES);

type AppStoreJwtInput = {
  keyId: string;
  issuerId: string;
  privateKey: string;
  nowSeconds?: number;
  expiresInSeconds?: number;
};

type AppResource = {
  type: 'apps';
  id: string;
  attributes?: { bundleId?: string };
};

type AppStoreVersionResource = {
  type: 'appStoreVersions';
  id: string;
  attributes?: {
    versionString?: string;
    appVersionState?: string;
  };
  relationships?: {
    build?: { data?: { type: 'builds'; id: string } | null };
  };
};

type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri: string;
};

type GoogleAccessTokenResponse = {
  access_token?: string;
};

export type GoogleProductionRelease = {
  releaseLifecycleState?: string;
  activeArtifacts?: Array<{ versionCode?: number | string }>;
};

type GoogleProductionReleasesResponse = {
  releases?: GoogleProductionRelease[];
};

// A side-loaded resource in the JSON:API `included` array. Typed loosely on
// `type` so the runtime `type === 'builds'` filter below is meaningful — ASC could
// include other resource types, whose ids must not shadow build ids.
type IncludedResource = {
  type: string;
  id: string;
  attributes?: { version?: string };
};

type JsonApiCollectionResponse<T> = {
  data: T[];
  included?: IncludedResource[];
};

// Store acceptance is always tied to one exact binary. Google reports versionCode
// without a canonical versionName, so its versionString is null and the globally
// unique versionCode resolves the build tag.
export type AcceptedBuild = {
  platform: 'ios' | 'android';
  versionString: string | null;
  buildNumber: number;
  state: string;
};

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function createAppStoreConnectJwt(input: AppStoreJwtInput): string {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresInSeconds = input.expiresInSeconds ?? 20 * 60;
  const header = { alg: 'ES256', kid: input.keyId, typ: 'JWT' };
  const payload = {
    aud: 'appstoreconnect-v1',
    exp: nowSeconds + expiresInSeconds,
    iat: nowSeconds,
    iss: input.issuerId,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = createSign('sha256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: input.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

function decodePrivateKey(secret: string): string {
  const trimmed = secret.trim();
  return trimmed.includes('BEGIN PRIVATE KEY') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
}

export function parseGoogleServiceAccount(secret: string): GoogleServiceAccount {
  const trimmed = secret.trim();
  const decoded = trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
  const parsed: unknown = JSON.parse(decoded);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must contain a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const clientEmail = record['client_email'];
  const privateKey = record['private_key'];
  const tokenUri = record['token_uri'] ?? 'https://oauth2.googleapis.com/token';
  if (typeof clientEmail !== 'string' || typeof privateKey !== 'string' || typeof tokenUri !== 'string') {
    throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is missing client_email, private_key, or token_uri');
  }
  return { client_email: clientEmail, private_key: privateKey, token_uri: tokenUri };
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function ascFetch<T>(path: string, token: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, APP_STORE_CONNECT_API_BASE);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`ASC ${path} → ${response.status}: ${body.slice(0, 500)}`);
  }
  return JSON.parse(body) as T;
}

async function resolveAppId(token: string): Promise<string> {
  const data = await ascFetch<JsonApiCollectionResponse<AppResource>>('/v1/apps', token, {
    'filter[bundleId]': BUNDLE_ID,
    'fields[apps]': 'bundleId',
    limit: '1',
  });
  const app = data.data[0];
  if (!app) throw new Error(`No ASC app found for ${BUNDLE_ID}`);
  return app.id;
}

// Pure mappings keep store API changes and edge cases testable without secrets.
export function mapAcceptedVersions(data: JsonApiCollectionResponse<AppStoreVersionResource>): AcceptedBuild[] {
  const buildNumberById = new Map<string, number>();
  for (const included of data.included ?? []) {
    if (included.type !== 'builds') continue;
    const rawVersion = included.attributes?.version;
    const parsed =
      typeof rawVersion === 'string' && /^\d+$/.test(rawVersion) ? Number.parseInt(rawVersion, 10) : Number.NaN;
    if (Number.isSafeInteger(parsed) && parsed > 0) buildNumberById.set(included.id, parsed);
  }

  return data.data
    .map((version): AcceptedBuild | null => {
      const versionString = version.attributes?.versionString;
      if (typeof versionString !== 'string' || versionString.length === 0) return null;
      const state = version.attributes?.appVersionState;
      if (typeof state !== 'string' || !acceptedAppStoreStateSet.has(state)) return null;
      const buildId = version.relationships?.build?.data?.id;
      const buildNumber = buildId ? buildNumberById.get(buildId) : undefined;
      if (buildNumber === undefined) return null;
      return { platform: 'ios', versionString, buildNumber, state };
    })
    .filter((version): version is AcceptedBuild => version !== null);
}

export function mapAcceptedGoogleProductionReleases(releases: readonly GoogleProductionRelease[]): AcceptedBuild[] {
  const acceptedByVersionCode = new Map<number, AcceptedBuild>();
  for (const release of releases) {
    const state = release.releaseLifecycleState;
    if (typeof state !== 'string' || !acceptedGooglePlayStateSet.has(state)) continue;
    for (const artifact of release.activeArtifacts ?? []) {
      const rawVersionCode = artifact.versionCode;
      const versionCode =
        typeof rawVersionCode === 'number'
          ? rawVersionCode
          : typeof rawVersionCode === 'string' && /^\d+$/.test(rawVersionCode)
            ? Number.parseInt(rawVersionCode, 10)
            : Number.NaN;
      if (!Number.isSafeInteger(versionCode) || versionCode <= 0) continue;
      acceptedByVersionCode.set(versionCode, {
        platform: 'android',
        versionString: null,
        buildNumber: versionCode,
        state,
      });
    }
  }
  return [...acceptedByVersionCode.values()].sort((left, right) => left.buildNumber - right.buildNumber);
}

async function getAcceptedVersions(token: string, appId: string): Promise<AcceptedBuild[]> {
  const data = await ascFetch<JsonApiCollectionResponse<AppStoreVersionResource>>(
    `/v1/apps/${appId}/appStoreVersions`,
    token,
    {
      'filter[appVersionState]': ACCEPTED_APP_STORE_STATES.join(','),
      'filter[platform]': 'IOS',
      'fields[appStoreVersions]': 'versionString,appVersionState,build',
      // Pull the attached build inline so we learn its build number without a
      // second round-trip per version.
      include: 'build',
      'fields[builds]': 'version',
      limit: '200',
    },
  );

  return mapAcceptedVersions(data);
}

function createGoogleServiceAccountJwt(
  serviceAccount: GoogleServiceAccount,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    aud: serviceAccount.token_uri,
    exp: nowSeconds + 60 * 60,
    iat: nowSeconds,
    iss: serviceAccount.client_email,
    scope: GOOGLE_PLAY_SCOPE,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(serviceAccount.private_key).toString('base64url')}`;
}

async function createGoogleAccessToken(serviceAccount: GoogleServiceAccount): Promise<string> {
  const assertion = createGoogleServiceAccountJwt(serviceAccount);
  const response = await fetch(serviceAccount.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      assertion,
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Google OAuth → ${response.status}: ${body.slice(0, 500)}`);
  const parsed = JSON.parse(body) as GoogleAccessTokenResponse;
  if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
    throw new Error('Google OAuth returned no access_token');
  }
  return parsed.access_token;
}

async function getAcceptedGoogleProductionBuilds(serviceAccount: GoogleServiceAccount): Promise<AcceptedBuild[]> {
  const accessToken = await createGoogleAccessToken(serviceAccount);
  const path = `/androidpublisher/v3/applications/${encodeURIComponent(ANDROID_PACKAGE_NAME)}/tracks/production/releases`;
  const url = new URL(path, GOOGLE_PLAY_API_BASE);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await response.text();
  if (!response.ok) throw new Error(`Google Play production releases → ${response.status}: ${body.slice(0, 500)}`);
  const parsed = JSON.parse(body) as GoogleProductionReleasesResponse;
  return mapAcceptedGoogleProductionReleases(parsed.releases ?? []);
}

function emitOutput(name: string, value: string): void {
  const githubOutput = process.env['GITHUB_OUTPUT'];
  if (githubOutput) {
    appendFileSync(githubOutput, `${name}=${value}\n`);
  }
  console.log(`output: ${name}=${value}`);
}

async function main(): Promise<number> {
  try {
    const token = createAppStoreConnectJwt({
      keyId: getRequiredEnv('APP_STORE_CONNECT_API_KEY_ID'),
      issuerId: getRequiredEnv('APP_STORE_CONNECT_ISSUER_ID'),
      privateKey: decodePrivateKey(getRequiredEnv('APP_STORE_CONNECT_API_KEY_BASE64')),
    });

    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const appConfigPath = join(scriptDir, '..', 'packages', 'mobile', 'app.config.ts');
    const content = readFileSync(appConfigPath, 'utf-8');

    const versionMatch = content.match(/version:\s*'(\d+\.\d+\.\d+)'/);
    if (!versionMatch) {
      throw new Error(`Could not find version field in ${appConfigPath}`);
    }
    const currentVersion = versionMatch[1];
    console.log(`Current marketing version: ${currentVersion}`);

    const googleServiceAccount = parseGoogleServiceAccount(getRequiredEnv('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'));
    const appId = await resolveAppId(token);
    const [acceptedIosBuilds, acceptedAndroidBuilds] = await Promise.all([
      getAcceptedVersions(token, appId),
      getAcceptedGoogleProductionBuilds(googleServiceAccount),
    ]);
    const accepted = [...acceptedIosBuilds, ...acceptedAndroidBuilds];
    console.log(
      `Accepted store builds: ${
        accepted.length > 0
          ? accepted
              .map(
                (build) =>
                  `${build.platform} ${build.versionString ?? '(version from build tag)'} ` +
                  `(build ${build.buildNumber}, ${build.state})`,
              )
              .join(', ')
          : 'none'
      }`,
    );

    // Emit platform-qualified exact store builds so the workflow can cut
    // release/<platform>-v<version>-<shortfp> anchor tags and compare the current
    // release train against both stores. One-line JSON fits GITHUB_OUTPUT.
    emitOutput('accepted_builds', JSON.stringify(accepted));

    // NO marketing-version bump. We used to bump the patch here the moment the current
    // version was accepted, but bumping the version on main busts the fingerprint of
    // the binary already in the field — and "accepted" is not "adopted", so every
    // install still on the previous store binary stopped receiving OTAs (production
    // publishes resolved a fingerprint no shipped binary embeds). Version bumps are a
    // manual decision made alongside the native build that ships them. This script only
    // reports accepted versions for anchoring; it never writes app.config.ts.
    return 0;
  } catch (err) {
    console.error(`[mobile-auto-version-bump] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((exitCode) => process.exit(exitCode));
}
