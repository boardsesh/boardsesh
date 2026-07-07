/// <reference types="node" />

import { appendFileSync, readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_STORE_CONNECT_API_BASE = 'https://api.appstoreconnect.apple.com';
const BUNDLE_ID = 'com.boardsesh.app';

// App Store states that indicate Apple has accepted the submission. A version in
// any of these states is anchored (release/* tag) so a JS fix can be backported to
// it. We do NOT bump the marketing version on acceptance — that busts the fingerprint
// of the binary already in the field and strands its OTAs (see main() below).
const ACCEPTED_APP_STORE_STATES = [
  'PENDING_DEVELOPER_RELEASE',
  'PENDING_APPLE_RELEASE',
  'PROCESSING_FOR_APP_STORE',
  'READY_FOR_SALE',
].join(',');

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
    appStoreState?: string;
  };
  relationships?: {
    build?: { data?: { type: 'builds'; id: string } | null };
  };
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

// A version App Store Connect has accepted, plus the build number of the build
// attached to it (CFBundleVersion). The build number is what the approval
// workflow matches against the build-ios-v<version>-<buildNumber>-<shortfp> tag
// to find the exact commit + fingerprint to anchor. null when ASC returned no
// attached build (the approval step then falls back to the latest build tag for
// the version).
type AcceptedVersion = { versionString: string; buildNumber: number | null };

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

// Pure mapping from the ASC appStoreVersions response (with `include=build`) to
// the accepted (version, build number) pairs. Exported so it can be unit-tested
// without the network; getAcceptedVersions is the thin fetch wrapper.
export function mapAcceptedVersions(data: JsonApiCollectionResponse<AppStoreVersionResource>): AcceptedVersion[] {
  const buildNumberById = new Map<string, number>();
  for (const included of data.included ?? []) {
    if (included.type !== 'builds') continue;
    const rawVersion = included.attributes?.version;
    const parsed = typeof rawVersion === 'string' ? Number.parseInt(rawVersion, 10) : Number.NaN;
    if (Number.isFinite(parsed)) buildNumberById.set(included.id, parsed);
  }

  return data.data
    .map((version): AcceptedVersion | null => {
      const versionString = version.attributes?.versionString;
      if (typeof versionString !== 'string' || versionString.length === 0) return null;
      const buildId = version.relationships?.build?.data?.id;
      const buildNumber = buildId ? (buildNumberById.get(buildId) ?? null) : null;
      return { versionString, buildNumber };
    })
    .filter((version): version is AcceptedVersion => version !== null);
}

async function getAcceptedVersions(token: string, appId: string): Promise<AcceptedVersion[]> {
  const data = await ascFetch<JsonApiCollectionResponse<AppStoreVersionResource>>(
    `/v1/apps/${appId}/appStoreVersions`,
    token,
    {
      'filter[appStoreState]': ACCEPTED_APP_STORE_STATES,
      'fields[appStoreVersions]': 'versionString,appStoreState,build',
      // Pull the attached build inline so we learn its build number without a
      // second round-trip per version.
      include: 'build',
      'fields[builds]': 'version',
      limit: '10',
    },
  );

  return mapAcceptedVersions(data);
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

    const versionMatch = content.match(/version:\s*'(\d+)\.(\d+)\.(\d+)'/);
    if (!versionMatch) {
      throw new Error(`Could not find version field in ${appConfigPath}`);
    }
    const [, major, minor, patch] = versionMatch;
    const currentVersion = `${major}.${minor}.${patch}`;
    console.log(`Current marketing version: ${currentVersion}`);

    const appId = await resolveAppId(token);
    const accepted = await getAcceptedVersions(token, appId);
    console.log(
      `Accepted App Store versions: ${
        accepted.length > 0
          ? accepted.map((version) => `${version.versionString} (build ${version.buildNumber ?? '?'})`).join(', ')
          : 'none'
      }`,
    );

    // Emit the accepted (version, build number) pairs so the workflow can cut the
    // release/<platform>-v<version>-<shortfp> anchor tags — independent of whether
    // the CURRENT app.config version is among them (an older accepted version may
    // still need anchoring). One-line JSON so it fits a single GITHUB_OUTPUT value.
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
