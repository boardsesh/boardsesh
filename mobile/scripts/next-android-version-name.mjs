#!/usr/bin/env node
// Compute the next Android versionName for a Play Store build.
//
// Mints an OAuth2 access token from a Google service account, queries the
// Play Developer API for the production track's most recent release, and
// prints the next versionName to stdout. Designed to be invoked from
// .github/workflows/android-release.yml; runs anywhere with Node + the
// service account JSON in env.
//
// Inputs (env):
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON   Service account JSON (raw text)
//   ANDROID_PACKAGE_NAME (optional)    Defaults to com.boardsesh.app
//   BUILD_GRADLE_PATH (optional)       Defaults to mobile/android/app/build.gradle
//
// Output: prints "<major>.<minor>.<patch>" to stdout. Diagnostics go to stderr.

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  base64url,
  die,
  highestVersion,
  normalize,
  pickNextVersion,
  requireEnv,
} from './version-utils.mjs';

const SCRIPT = 'next-android-version-name';

function signServiceAccountJwt({ clientEmail, privateKey }) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 60 * 60,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

async function exchangeJwtForAccessToken(jwt) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  if (!response.ok) {
    const body = await response.text();
    die(SCRIPT, `OAuth2 token exchange failed: ${response.status} ${response.statusText}\n${body}`);
  }
  const json = await response.json();
  if (!json.access_token) die(SCRIPT, `OAuth2 response missing access_token: ${JSON.stringify(json)}`);
  return json.access_token;
}

function readCurrentVersionName(buildGradlePath) {
  const contents = readFileSync(buildGradlePath, 'utf8');
  const match = contents.match(/versionName\s*=?\s*"([^"]+)"/);
  if (!match) die(SCRIPT, `could not find versionName in ${buildGradlePath}`);
  return normalize(match[1]);
}

async function fetchLatestProductionVersionName({ accessToken, packageName }) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const baseUrl = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
    packageName,
  )}`;

  const editResponse = await fetch(`${baseUrl}/edits`, { method: 'POST', headers });
  if (!editResponse.ok) {
    const body = await editResponse.text();
    die(SCRIPT, `Play Developer API edits.insert failed: ${editResponse.status} ${editResponse.statusText}\n${body}`);
  }
  const { id: editId } = await editResponse.json();
  if (!editId) die(SCRIPT, 'Play Developer API returned no edit id');

  try {
    const trackResponse = await fetch(`${baseUrl}/edits/${editId}/tracks/production`, { headers });
    if (trackResponse.status === 404) return null;
    if (!trackResponse.ok) {
      const body = await trackResponse.text();
      die(
        SCRIPT,
        `Play Developer API tracks.get failed: ${trackResponse.status} ${trackResponse.statusText}\n${body}`,
      );
    }
    const track = await trackResponse.json();
    const releases = (track.releases ?? []).filter((release) =>
      release.status === 'completed' || release.status === 'inProgress',
    );
    return highestVersion(releases.map((release) => release.name));
  } finally {
    await fetch(`${baseUrl}/edits/${editId}`, { method: 'DELETE', headers }).catch(() => {});
  }
}

async function main() {
  const serviceAccountJson = requireEnv(SCRIPT, 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
  const packageName = process.env.ANDROID_PACKAGE_NAME ?? 'com.boardsesh.app';
  const buildGradlePath = resolve(process.env.BUILD_GRADLE_PATH ?? 'mobile/android/app/build.gradle');

  const sourceVersion = readCurrentVersionName(buildGradlePath);

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch (error) {
    die(SCRIPT, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON: ${error.message}`);
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    die(SCRIPT, 'service account JSON missing client_email or private_key');
  }

  const jwt = signServiceAccountJwt({
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key,
  });
  const accessToken = await exchangeJwtForAccessToken(jwt);

  const releasedVersion = await fetchLatestProductionVersionName({ accessToken, packageName });

  process.stderr.write(`source versionName: ${sourceVersion}\n`);
  process.stderr.write(
    `play production version: ${releasedVersion ?? '(none — no production release yet)'}\n`,
  );

  const nextVersion = pickNextVersion(sourceVersion, releasedVersion);

  process.stderr.write(`next versionName: ${nextVersion}\n`);
  process.stdout.write(`${nextVersion}\n`);
}

main().catch((error) => die(SCRIPT, error.stack ?? String(error)));
