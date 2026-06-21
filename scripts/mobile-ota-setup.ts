/// <reference types="node" />

/**
 * One-time setup helper for the self-hosted production OTA (expo-open-ota).
 * Splits the runbook in docs/mobile-ota-updates.md into scriptable phases so the
 * error-prone bits (cert generation, base64 key encoding, the Railway env block)
 * aren't done by hand. Cloud actions (bucket, Railway service, DNS) stay manual.
 *
 * Phases (run in this order as infra comes online):
 *   vp run mobile:ota-setup keys            # generate signing certs + print server env
 *   vp run mobile:ota-setup expo            # create+map the Expo `production` channel/branch
 *   vp run mobile:ota-setup github --url <BASE_URL>/manifest   # set the EXPO_UPDATES_URL variable
 *
 * `vp run mobile:ota-setup` with no phase prints the runbook.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = resolve(ROOT_DIR, 'packages', 'mobile');
const CERTS_DIR = resolve(MOBILE_DIR, 'certs');

// Mirrors DEFAULT_EAS_PROJECT_ID in packages/mobile/app.config.ts. expo-open-ota
// uses this as EXPO_APP_ID to read channel↔branch metadata from Expo's API.
const EXPO_APP_ID = '87499648-655e-4fb8-9856-65da37e55fb1';
const CHANNEL = 'production';
const LOG = '[mobile:ota-setup]';

function log(message = ''): void {
  console.log(message ? `${LOG} ${message}` : '');
}

function fail(message: string): never {
  console.error(`${LOG} ${message}`);
  process.exit(1);
}

function base64File(path: string): string {
  return readFileSync(path).toString('base64');
}

function generateKeys(force: boolean): void {
  const certPath = resolve(CERTS_DIR, 'certificate.pem');
  if (existsSync(certPath) && !force) {
    log(`certs/certificate.pem already exists — skipping generation (pass --force to regenerate).`);
  } else {
    log('Generating code-signing certs via eoas@2 …');
    // eoas writes certs/{certificate,public-key,private-key}.pem under cwd.
    const result = spawnSync('bunx', ['eoas@2', 'generate-certs'], {
      cwd: MOBILE_DIR,
      stdio: 'inherit',
      env: { ...process.env },
    });
    if (result.status !== 0) fail('eoas generate-certs failed.');
  }

  const publicKeyPath = resolve(CERTS_DIR, 'public-key.pem');
  const privateKeyPath = resolve(CERTS_DIR, 'private-key.pem');
  for (const path of [certPath, publicKeyPath, privateKeyPath]) {
    if (!existsSync(path)) fail(`Expected ${path} after generate-certs, but it's missing.`);
  }

  log('');
  log('Commit ONLY the public certificate:');
  log('  git add -f packages/mobile/certs/certificate.pem');
  log('  (private-key.pem + public-key.pem stay gitignored — they go to the server)');
  log('');
  log('── Railway env for the expo-open-ota service ───────────────────────────');
  log('Fill in the storage + secret values; leave all CLOUDFRONT_* / AWSSM_* blank.');
  console.log(
    [
      `BASE_URL=https://ota.boardsesh.com`,
      `JWT_SECRET=<openssl rand -hex 32>`,
      `EXPO_APP_ID=${EXPO_APP_ID}`,
      `EXPO_ACCESS_TOKEN=<same value as the EXPO_TOKEN CI secret>`,
      `CACHE_MODE=local`,
      `KEYS_STORAGE_TYPE=environment`,
      `PUBLIC_EXPO_KEY_B64=${base64File(publicKeyPath)}`,
      `PRIVATE_EXPO_KEY_B64=${base64File(privateKeyPath)}`,
      `STORAGE_MODE=s3`,
      `S3_BUCKET_NAME=boardsesh-ota`,
      `AWS_REGION=<region, e.g. auto for R2>`,
      `AWS_BASE_ENDPOINT=<S3-compatible endpoint>`,
      `AWS_ACCESS_KEY_ID=<bucket key id>`,
      `AWS_SECRET_ACCESS_KEY=<bucket secret>`,
    ].join('\n'),
  );
  log('────────────────────────────────────────────────────────────────────────');
}

function setupExpoChannel(): void {
  if (!process.env.EXPO_TOKEN) {
    fail('expo phase needs EXPO_TOKEN (run `bunx eas login` or export EXPO_TOKEN).');
  }
  // Idempotent: tolerate "already exists" so re-runs are safe. eas-cli@16 matches
  // the version used by mobile-publish.ts / mobile-eas-update.yml.
  const runEas = (args: string[]): void => {
    log(`eas ${args.join(' ')}`);
    const result = spawnSync('bunx', ['eas-cli@16', ...args, '--non-interactive'], {
      cwd: MOBILE_DIR,
      stdio: 'inherit',
      env: { ...process.env },
    });
    if (result.status !== 0) {
      log(`(non-zero exit — fine if it already exists; verify with \`bunx eas-cli@16 channel:view ${CHANNEL}\`)`);
    }
  };

  runEas(['branch:create', CHANNEL]);
  runEas(['channel:create', CHANNEL]);
  // channel:edit points the channel at the same-named branch (what the binary's
  // expo-channel-name header resolves to, and where `eoas publish` ships).
  runEas(['channel:edit', CHANNEL, '--branch', CHANNEL]);
  log('');
  log(`Verify: bunx eas-cli@16 channel:view ${CHANNEL}  (should map → branch ${CHANNEL})`);
}

function parseUrlFlag(args: string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--url') return args[index + 1] ?? null;
    if (args[index].startsWith('--url=')) return args[index].slice('--url='.length);
  }
  return null;
}

function setupGithub(url: string | null): void {
  if (!url) fail('github phase needs --url <BASE_URL>/manifest (e.g. https://ota.boardsesh.com/manifest).');
  if (!/^https:\/\/.+\/manifest$/.test(url)) {
    fail(`--url must be an https URL ending in /manifest (got: ${url}).`);
  }
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
  } catch {
    fail('gh is not authenticated. Run `gh auth login` (or set GH_TOKEN) and retry.');
  }

  log(`Setting repo variable EXPO_UPDATES_URL=${url}`);
  const setVar = spawnSync('gh', ['variable', 'set', 'EXPO_UPDATES_URL', '--body', url], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
  if (setVar.status !== 0) fail('gh variable set failed.');

  // EXPO_TOKEN is a secret; we can't read its value, only confirm it exists.
  const secrets = spawnSync('gh', ['secret', 'list'], { cwd: ROOT_DIR, encoding: 'utf-8' });
  if (secrets.status === 0 && /(^|\n)EXPO_TOKEN\b/.test(secrets.stdout)) {
    log('✓ EXPO_TOKEN secret present.');
  } else {
    log('⚠ EXPO_TOKEN secret not found — add it (Expo access token) before publishing.');
  }
  log('');
  log('Now ship one native build from main (ios-testflight-rn / android-apk-rn) to bake in');
  log('the fingerprint runtimeVersion + server URL + cert, then OTAs auto-publish on main.');
}

function printRunbook(): void {
  log('Self-hosted production OTA setup. Run these phases as infra comes online:');
  log('');
  log('  1. vp run mobile:ota-setup keys');
  log('       → generates signing certs and prints the Railway env block.');
  log('         Commit certs/certificate.pem; paste the env into the Railway service.');
  log('  2. (cloud) create the boardsesh-ota bucket, deploy expo-open-ota on Railway,');
  log('       point ota.boardsesh.com at it (see docs/mobile-ota-updates.md).');
  log('  3. vp run mobile:ota-setup expo        (needs EXPO_TOKEN)');
  log('       → creates + maps the Expo `production` channel/branch.');
  log('  4. vp run mobile:ota-setup github --url https://ota.boardsesh.com/manifest');
  log('       → sets the EXPO_UPDATES_URL repo variable + checks the EXPO_TOKEN secret.');
  log('');
  log('Full runbook: docs/mobile-ota-updates.md');
}

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const phase = args[0];

switch (phase) {
  case 'keys':
    generateKeys(args.includes('--force'));
    break;
  case 'expo':
    setupExpoChannel();
    break;
  case 'github':
    setupGithub(parseUrlFlag(args));
    break;
  case undefined:
    printRunbook();
    break;
  default:
    fail(`Unknown phase "${phase}". Expected one of: keys, expo, github (or no argument for the runbook).`);
}
