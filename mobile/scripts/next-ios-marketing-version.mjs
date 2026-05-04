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

function die(message) {
  process.stderr.write(`next-ios-marketing-version: ${message}\n`);
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) die(`missing required env var ${name}`);
  return value;
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

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
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}

function normalize(version) {
  const parts = String(version).trim().split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.join('.');
}

function compareVersions(left, right) {
  const lp = left.split('.').map(Number);
  const rp = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (lp[index] !== rp[index]) return lp[index] - rp[index];
  }
  return 0;
}

function bumpPatch(version) {
  const parts = version.split('.').map(Number);
  parts[2] += 1;
  return parts.join('.');
}

function readCurrentMarketingVersion(pbxprojPath) {
  const contents = readFileSync(pbxprojPath, 'utf8');
  const matches = [...contents.matchAll(/MARKETING_VERSION\s*=\s*([0-9.]+)\s*;/g)].map((match) => match[1]);
  if (matches.length === 0) die(`could not find MARKETING_VERSION in ${pbxprojPath}`);
  const unique = [...new Set(matches.map(normalize))];
  if (unique.length > 1) {
    process.stderr.write(
      `next-ios-marketing-version: warning — multiple MARKETING_VERSION values in pbxproj (${unique.join(
        ', ',
      )}); using the highest\n`,
    );
  }
  return unique.sort(compareVersions).at(-1);
}

async function fetchLatestReleasedVersion({ appId, jwt }) {
  const url = `https://api.appstoreconnect.apple.com/v1/apps/${encodeURIComponent(
    appId,
  )}/appStoreVersions?filter%5BappStoreState%5D=READY_FOR_SALE&limit=1`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
  if (!response.ok) {
    const body = await response.text();
    die(`App Store Connect lookup failed: ${response.status} ${response.statusText}\n${body}`);
  }
  const json = await response.json();
  const released = json?.data?.[0]?.attributes?.versionString;
  return released ? normalize(released) : null;
}

async function main() {
  const keyId = requireEnv('APP_STORE_CONNECT_API_KEY_ID');
  const issuerId = requireEnv('APP_STORE_CONNECT_ISSUER_ID');
  const keyPath = requireEnv('APP_STORE_CONNECT_API_KEY_PATH');
  const appId = requireEnv('APP_STORE_APP_ID');
  const pbxprojPath = resolve(
    process.env.PBXPROJ_PATH ?? 'mobile/ios/App/App.xcodeproj/project.pbxproj',
  );

  const sourceVersion = readCurrentMarketingVersion(pbxprojPath);

  const privateKey = readFileSync(keyPath, 'utf8');
  const jwt = signJwt({ keyId, issuerId, privateKey });
  const releasedVersion = await fetchLatestReleasedVersion({ appId, jwt });

  process.stderr.write(`source MARKETING_VERSION: ${sourceVersion}\n`);
  process.stderr.write(`store READY_FOR_SALE version: ${releasedVersion ?? '(none — no public release yet)'}\n`);

  let nextVersion;
  if (!releasedVersion) {
    nextVersion = sourceVersion;
  } else {
    const candidate = bumpPatch(releasedVersion);
    nextVersion = compareVersions(sourceVersion, candidate) > 0 ? sourceVersion : candidate;
  }

  process.stderr.write(`next marketing version: ${nextVersion}\n`);
  process.stdout.write(`${nextVersion}\n`);
}

main().catch((error) => die(error.stack ?? String(error)));
