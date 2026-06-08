#!/usr/bin/env node
// Compute the next iOS marketing version for a TestFlight/App Store build.
//
// Reads the latest publicly-released version from App Store Connect and the
// current MARKETING_VERSION committed in the Xcode project, then prints the
// next version to stdout. Designed to be invoked from
// .github/workflows/ios-testflight.yml and to run cross-platform for local
// dry-runs (only Node + standard library are required).
//
// Inputs (env):
//   APP_STORE_CONNECT_API_KEY_ID       Apple API key id (e.g. ABC1234567)
//   APP_STORE_CONNECT_ISSUER_ID        Apple issuer uuid
//   APP_STORE_CONNECT_API_KEY_PATH     Path to the .p8 private key
//   APP_STORE_APP_ID                   Numeric App Store app id
//   PBXPROJ_PATH (optional)            Defaults to
//                                      mobile/ios/App/App.xcodeproj/project.pbxproj
//
// Output: prints "<major>.<minor>.<patch>" to stdout. All diagnostics go to stderr.

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  base64url,
  compareVersions,
  die,
  failAndExit,
  highestVersion,
  normalize,
  pickNextVersion,
  requireEnv,
} from './version-utils.mjs';

const SCRIPT = 'next-ios-marketing-version';

function signJwt({ keyId, issuerId, privateKey }) {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({
      iss: issuerId,
      iat: now,
      exp: now + 15 * 60,
      aud: 'appstoreconnect-v1',
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign('SHA256').update(signingInput).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}

function readCurrentMarketingVersion(pbxprojPath) {
  const contents = readFileSync(pbxprojPath, 'utf8');
  const matches = [...contents.matchAll(/MARKETING_VERSION\s*=\s*([0-9.]+)\s*;/g)].map((match) => match[1]);
  if (matches.length === 0) die(SCRIPT, `could not find MARKETING_VERSION in ${pbxprojPath}`);
  const unique = [...new Set(matches.map(normalize))];
  if (unique.length > 1) {
    process.stderr.write(
      `${SCRIPT}: warning — multiple MARKETING_VERSION values in pbxproj (${unique.join(', ')}); using the highest\n`,
    );
  }
  return unique.sort(compareVersions).at(-1);
}

async function fetchLatestReleasedVersion({ appId, jwt }) {
  // Fetch all READY_FOR_SALE versions and sort with compareVersions ourselves;
  // the API does not order by semver so a naive `limit=1` can miss the highest.
  const url = `https://api.appstoreconnect.apple.com/v1/apps/${encodeURIComponent(
    appId,
  )}/appStoreVersions?filter%5BappStoreState%5D=READY_FOR_SALE&limit=200`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
  if (!response.ok) {
    const body = await response.text();
    die(SCRIPT, `App Store Connect lookup failed: ${response.status} ${response.statusText}\n${body}`);
  }
  const json = await response.json();
  const versionStrings = (json?.data ?? []).map((entry) => entry?.attributes?.versionString).filter(Boolean);
  return highestVersion(versionStrings);
}

async function main() {
  const keyId = requireEnv(SCRIPT, 'APP_STORE_CONNECT_API_KEY_ID');
  const issuerId = requireEnv(SCRIPT, 'APP_STORE_CONNECT_ISSUER_ID');
  const keyPath = requireEnv(SCRIPT, 'APP_STORE_CONNECT_API_KEY_PATH');
  const appId = requireEnv(SCRIPT, 'APP_STORE_APP_ID');
  const pbxprojPath = resolve(process.env.PBXPROJ_PATH ?? 'mobile/ios/App/App.xcodeproj/project.pbxproj');

  const sourceVersion = readCurrentMarketingVersion(pbxprojPath);

  const privateKey = readFileSync(keyPath, 'utf8');
  const jwt = signJwt({ keyId, issuerId, privateKey });
  const releasedVersion = await fetchLatestReleasedVersion({ appId, jwt });

  process.stderr.write(`source MARKETING_VERSION: ${sourceVersion}\n`);
  process.stderr.write(`store READY_FOR_SALE version: ${releasedVersion ?? '(none — no public release yet)'}\n`);

  const nextVersion = pickNextVersion(sourceVersion, releasedVersion);

  process.stderr.write(`next marketing version: ${nextVersion}\n`);
  process.stdout.write(`${nextVersion}\n`);
}

main().catch((error) => failAndExit(SCRIPT, error));
