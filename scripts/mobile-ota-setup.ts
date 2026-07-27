/// <reference types="node" />

/**
 * One-time setup helper for the self-hosted production OTA — the green-field
 * expo-open-ota **V3** control-plane server at updates.boardsesh.com. Splits the
 * runbook in docs/mobile-ota-updates.md into scriptable phases so the error-prone
 * bits (the Railway env block, the S3 lifecycle rule, the GitHub secret/var checks)
 * aren't done by hand. Cloud actions (bucket, Postgres, Railway service, DNS) and
 * dashboard actions (create the app, export the cert, mint the eoo_ key) stay manual.
 *
 * V3 differs from V2 in ways this script reflects:
 *   - Signing keys are generated SERVER-SIDE (in Postgres, sealed under
 *     DB_KEYS_MASTER_KEY_B64). You EXPORT the app's public cert from /dashboard —
 *     there is no local `eoas generate-certs`, no *_EXPO_KEY_B64 env.
 *   - Channels are created by `eoas publish` and MAPPED via the management API
 *     (scripts/ota-channel-map.ts) or the dashboard — no eas-cli channel:create/edit.
 *   - Publish auth is the app-scoped EOO_TOKEN (Expo tokens are rejected).
 *
 * Phases (run in this order as infra comes online):
 *   vp run mobile:ota-setup keys            # print the V3 Railway env + cert-export steps
 *   vp run mobile:ota-setup map             # map the `production` channel → branch (post first publish; `expo` alias)
 *   vp run mobile:ota-setup github --url <BASE_URL>/manifest   # set the EXPO_UPDATES_URL variable + secret checks
 *   vp run mobile:ota-setup preview         # per-PR preview infra: S3 lifecycle rule + GitHub bits
 *
 * `vp run mobile:ota-setup` with no phase prints the runbook.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EOAS_PACKAGE_SPEC } from './lib/eoas';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = resolve(ROOT_DIR, 'packages', 'mobile');
const CERTS_DIR = resolve(MOBILE_DIR, 'certs');
const CHANNEL_MAP_SCRIPT = resolve(ROOT_DIR, 'scripts', 'ota-channel-map.ts');

// The app id the V3 server routes on (the `expo-app-id` header the client sends).
// This is NOT the EAS project id — it's the server's internal app UUID. Matches
// DEFAULT_APP_ID in scripts/ota-channel-map.ts and OTA_APP_ID in app.config.ts.
const OTA_APP_ID = '007e6fd7-f200-448c-9449-8d48ba5d51fc';
const CHANNEL = 'production';
const LOG = '[mobile:ota-setup]';

// Per-PR preview channels (mobile-ota-preview.yml). Post-V3 the channel NAME prefix
// and the S3 lifecycle KEY prefix DIFFER: V3 keys objects as {appId}/{branch}/…, so
// the lifecycle rule must key off the appId-scoped prefix while the channels stay
// `pr-<number>`. scripts/ota-channel-map.ts delete is the primary GC; the lifecycle
// rule is only an orphan backstop.
const BUCKET = 'boardsesh-ota-v3';
const PREVIEW_CHANNEL_PREFIX = 'pr-';
const PREVIEW_S3_PREFIX = `${OTA_APP_ID}/${PREVIEW_CHANNEL_PREFIX}`;
const PREVIEW_TTL_DAYS = 14;

function log(message = ''): void {
  console.log(message ? `${LOG} ${message}` : '');
}

function fail(message: string): never {
  console.error(`${LOG} ${message}`);
  process.exit(1);
}

/** First whitespace-delimited token of each `gh secret/variable list` row (the name). */
function ghListNames(args: string[]): string[] {
  const result = spawnSync('gh', args, { cwd: ROOT_DIR, encoding: 'utf-8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => name.length > 0);
}

function printServerSetup(): void {
  const certPath = resolve(CERTS_DIR, 'certificate.pem');

  log('── V3 control-plane: signing keys are generated SERVER-SIDE ─────────────');
  log('The control-plane server generates the app keypair in its Postgres, sealed');
  log('under DB_KEYS_MASTER_KEY_B64. There is NO local `eoas generate-certs` and NO');
  log('key env var. Instead, after the app exists in /dashboard:');
  log('  1. /dashboard → the app → export/download its PUBLIC certificate.');
  log('  2. Save it as packages/mobile/certs/certificate.pem and commit it:');
  log('       git add -f packages/mobile/certs/certificate.pem');
  log('     (the private key never leaves the server — Postgres is its only home).');
  log('');
  if (existsSync(certPath)) {
    log('✓ packages/mobile/certs/certificate.pem already present.');
  } else {
    log('⚠ packages/mobile/certs/certificate.pem missing — export it from the dashboard.');
  }

  log('');
  log('── Railway env for the expo-open-ota V3 service (as built) ──────────────');
  log('⚠ DB_KEYS_MASTER_KEY_B64 is the ONLY key that can unseal the app signing key.');
  log('  Generate it ONCE: printf %s "$(openssl rand -base64 32)"  (no trailing newline,');
  log('  strict base64). Store it in 1Password + one out-of-band copy and NEVER');
  log('  regenerate it — losing it together with the Postgres backups makes the entire');
  log('  V3 fleet unsignable.');
  log('');
  console.log(
    [
      `BASE_URL=https://updates.boardsesh.com`,
      `JWT_SECRET=<openssl rand -hex 32>`,
      `DB_URL=<Railway Postgres internal URL, with explicit sslmode; DB must exist before first boot>`,
      `DB_KEYS_MASTER_KEY_B64=<openssl rand -base64 32 — store safely, NEVER regenerate>`,
      `ADMIN_EMAIL=admin@boardsesh.com`,
      `ADMIN_PASSWORD=<at least 8 chars incl. upper+lower+digit+special — first boot crash-loops otherwise>`,
      `USE_DASHBOARD=true`,
      `STORAGE_MODE=s3`,
      `S3_BUCKET_NAME=${BUCKET}`,
      `AWS_BASE_ENDPOINT=<S3-compatible endpoint; e.g. https://t3.storage.dev for Tigris>`,
      `AWS_REGION=auto`,
      `AWS_ACCESS_KEY_ID=<bucket key id>`,
      `AWS_SECRET_ACCESS_KEY=<bucket secret>`,
      `CACHE_MODE=local`,
      `PROMETHEUS_ENABLED=true`,
    ].join('\n'),
  );
  log('────────────────────────────────────────────────────────────────────────');
  log('NOT needed in control-plane (leave unset): EXPO_APP_ID, EXPO_ACCESS_TOKEN,');
  log('PUBLIC_EXPO_KEY_B64 / PRIVATE_EXPO_KEY_B64, KEYS_STORAGE_TYPE — keys are');
  log('DB-generated per app. Healthcheck may point at /ready immediately.');
}

function setupChannel(): void {
  log('── V3 control-plane: channels are created by PUBLISH, then MAPPED ───────');
  log('There is no eas-cli channel:create/edit in control-plane. `eoas publish` (via');
  log('`vp run mobile:publish -- --channel production`, EOO_TOKEN) creates the branch');
  log('that holds the update AND the same-named channel — but leaves them UNMAPPED, so');
  log('a client resolving `production` gets "No branch mapping found" until it is mapped.');
  log('');
  log('Mapping is a dashboard-admin action (the eoo_ publish key CANNOT map). After the');
  log('first production publish, do ONE of:');
  log(`  a) Dashboard: /dashboard → the app → map channel \`${CHANNEL}\` → branch \`${CHANNEL}\`.`);
  log('  b) Headless (needs OTA_ADMIN_EMAIL + OTA_ADMIN_PASSWORD + EXPO_UPDATES_URL/OTA_BASE_URL):');
  log(`       bun scripts/ota-channel-map.ts map --channel ${CHANNEL} --branch ${CHANNEL}`);
  log('');
  log('The production mapping is a ONE-TIME step — CI never carries admin creds on main.');
  log('');

  const hasAdminCreds = Boolean(process.env.OTA_ADMIN_EMAIL && process.env.OTA_ADMIN_PASSWORD);
  const hasBaseUrl = Boolean(process.env.EXPO_UPDATES_URL || process.env.OTA_BASE_URL);
  if (hasAdminCreds && hasBaseUrl) {
    log('OTA_ADMIN_* + server URL present — attempting the map now (best-effort; it fails');
    log(`harmlessly if branch ${CHANNEL} has not been published yet).`);
    const result = spawnSync('bun', [CHANNEL_MAP_SCRIPT, 'map', '--channel', CHANNEL, '--branch', CHANNEL], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: { ...process.env },
    });
    if (result.status !== 0) {
      log(
        `(map exited non-zero — publish to branch ${CHANNEL} first, then re-run this phase or map in the dashboard.)`,
      );
    }
  } else {
    log('Set OTA_ADMIN_EMAIL + OTA_ADMIN_PASSWORD (+ EXPO_UPDATES_URL) to have this phase run the map for you.');
  }
  log('');
  log(`Verify after mapping: bunx ${EOAS_PACKAGE_SPEC} doctor --channel ${CHANNEL}  (needs EOO_TOKEN)`);
}

function parseUrlFlag(args: string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--url') return args[index + 1] ?? null;
    if (args[index].startsWith('--url=')) return args[index].slice('--url='.length);
  }
  return null;
}

function setupGithub(url: string | null): void {
  if (!url) fail('github phase needs --url <BASE_URL>/manifest (e.g. https://updates.boardsesh.com/manifest).');
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

  // Repo-level publish key (also add it to the ota-preview environment for previews).
  if (ghListNames(['secret', 'list']).includes('EOO_TOKEN')) {
    log('✓ EOO_TOKEN repo secret present.');
  } else {
    log('⚠ EOO_TOKEN repo secret not found — add the app-scoped expo-open-ota key before publishing:');
    log('    gh secret set EOO_TOKEN   (then also add it to the ota-preview environment)');
  }

  // The dashboard admin creds used to map/delete preview channels live in the
  // ota-preview-unattended environment (no required reviewers — the map/cleanup/
  // sweep jobs run trusted-base code there so they never hang and never expose the
  // creds to PR code). Best-effort check — the env may not exist yet (the `preview`
  // phase creates it).
  const unattendedSecrets = ghListNames(['secret', 'list', '--env', 'ota-preview-unattended']);
  const unattendedVars = ghListNames(['variable', 'list', '--env', 'ota-preview-unattended']);
  if (unattendedSecrets.includes('OTA_ADMIN_PASSWORD')) {
    log('✓ OTA_ADMIN_PASSWORD secret present in the ota-preview-unattended environment.');
  } else {
    log('⚠ Add OTA_ADMIN_PASSWORD to the ota-preview-unattended environment (dashboard admin password):');
    log('    gh secret set OTA_ADMIN_PASSWORD --env ota-preview-unattended');
  }
  if (unattendedVars.includes('OTA_ADMIN_EMAIL')) {
    log('✓ OTA_ADMIN_EMAIL variable present in the ota-preview-unattended environment.');
  } else {
    log('⚠ Add OTA_ADMIN_EMAIL to the ota-preview-unattended environment:');
    log('    gh variable set OTA_ADMIN_EMAIL --env ota-preview-unattended --body admin@boardsesh.com');
  }
  log('');
  log('(The ota-preview-unattended environment is created by the `preview` phase — run');
  log(' `vp run mobile:ota-setup preview` FIRST if the gh --env commands above fail because');
  log(' the environment does not exist yet.)');
  log('');
  log('Now ship one native build from main (ios-testflight-rn / android-apk-rn) to bake in');
  log('the fingerprint runtimeVersion + server URL + cert, then OTAs auto-publish on main.');
}

function ghTry(args: string[], okMessage: string): void {
  log(`gh ${args.join(' ')}`);
  const result = spawnSync('gh', args, { cwd: ROOT_DIR, stdio: 'inherit' });
  if (result.status === 0) log(`✓ ${okMessage}`);
  else log('(non-zero exit — fine if it already exists, or do it manually)');
}

function setupPreview(): void {
  log('Per-PR OTA preview channels — one-time infra (mobile-ota-preview.yml).');
  log('');
  log('Server-side deletion is the PRIMARY GC: the on-close cleanup + the daily sweep');
  log('(mobile-ota-preview-sweep.yml) call scripts/ota-channel-map.ts delete, which removes');
  log('the pr-<n> channel (mapping first) then the branch. The lifecycle rule below is only');
  log('an ORPHAN BACKSTOP for objects a failed delete leaves behind.');
  log('');
  log('── 1. S3 lifecycle rule (orphan backstop; bounds storage) ──');
  log(`Expire objects under the "${PREVIEW_S3_PREFIX}" key prefix after ${PREVIEW_TTL_DAYS} days.`);
  log('V3 keys updates as {appId}/{branch}/{runtimeVersion}/…, so this appId-scoped prefix matches');
  log(`only pr-<number> branches — {appId}/production/ is untouched. NOTE the channel-name prefix`);
  log(`("${PREVIEW_CHANNEL_PREFIX}") and the S3 key prefix DIFFER post-V3: the rule keys off "${PREVIEW_S3_PREFIX}".`);
  log('');
  console.log(
    JSON.stringify(
      {
        Rules: [
          {
            ID: 'expire-pr-preview-channels',
            Filter: { Prefix: PREVIEW_S3_PREFIX },
            Status: 'Enabled',
            Expiration: { Days: PREVIEW_TTL_DAYS },
          },
        ],
      },
      null,
      2,
    ),
  );
  log('');
  log(`Apply via the S3 API (${BUCKET} is Tigris on t3.storage.dev — pass its --endpoint-url; any`);
  log('S3-compatible provider works the same). FIRST get-bucket-lifecycle-configuration and MERGE —');
  log('put-bucket-lifecycle-configuration REPLACES all rules:');
  log(`  aws s3api put-bucket-lifecycle-configuration --bucket ${BUCKET} \\`);
  log('    --lifecycle-configuration file://lifecycle.json --endpoint-url <S3 endpoint>');
  log('');
  log('── 2. GitHub setup (best-effort, idempotent) ──');
  ghTry(
    ['api', '-X', 'PUT', 'repos/{owner}/{repo}/environments/ota-preview', '--silent'],
    'ensured the `ota-preview` environment exists (publish key; optional required reviewers)',
  );
  ghTry(
    ['api', '-X', 'PUT', 'repos/{owner}/{repo}/environments/ota-preview-unattended', '--silent'],
    'ensured the `ota-preview-unattended` environment exists (admin creds; NO reviewers)',
  );
  ghTry(
    ['api', '-X', 'PUT', 'repos/{owner}/{repo}/environments/pr-preview', '--silent'],
    'ensured the `pr-preview` environment exists (hosts the readiness Deployment; no protection needed)',
  );
  log('');
  log('The preview jobs read from TWO environments so the admin creds never share a job with');
  log('PR-author code:');
  log('  # ota-preview — the PUBLISH job (runs PR-author code); may carry required reviewers.');
  log('  gh secret set EOO_TOKEN --env ota-preview                        (publish key)');
  log('  # ota-preview-unattended — the map + cleanup + sweep jobs (trusted base only); NO reviewers.');
  log('  gh secret set OTA_ADMIN_PASSWORD --env ota-preview-unattended    (map/delete via the management API)');
  log('  gh variable set OTA_ADMIN_EMAIL --env ota-preview-unattended --body admin@boardsesh.com');
  log('');
  log('GOOGLE_MAPS_API_KEY must be readable by the (gated) preview job for Android fingerprint parity.');
  if (ghListNames(['secret', 'list']).includes('GOOGLE_MAPS_API_KEY')) {
    log('✓ GOOGLE_MAPS_API_KEY repo secret present.');
  } else {
    log('⚠ Add GOOGLE_MAPS_API_KEY as a REPO-level secret (it already ships inside the public APK, so');
    log('  this is not a new exposure): gh secret set GOOGLE_MAPS_API_KEY  (same value as Production).');
  }
  log('');
  log('── 3. The two-environment security model (why previews stay fully automated) ──');
  log('The publish job holds EOO_TOKEN and runs PR-author code, so `ota-preview` is where you may add');
  log('the maintainers as REQUIRED REVIEWERS (Settings → Environments → ota-preview): each preview');
  log('PUBLISH then pauses for approval before its secrets reach PR code. That gate is publish-only.');
  log('');
  log('The channel↔branch mapping, on-close cleanup, and daily sweep run in a SEPARATE trusted-base');
  log('job set that carries the dashboard admin creds (OTA_ADMIN_*) — and those jobs must never hang.');
  log('So they declare `ota-preview-unattended`, which MUST stay WITHOUT required reviewers: reviewers');
  log('there would pause a PR close or the scheduled sweep forever. It is safe unattended because every');
  log('one of those jobs checks out the TRUSTED BASE (never PR head) and only mutates a ^pr-[0-9]+$');
  log('channel — PR-author code never runs with the admin creds. Keep the two environments split.');
}

function printRunbook(): void {
  log('Self-hosted production OTA setup (green-field expo-open-ota V3 control-plane).');
  log('Run these phases as infra comes online:');
  log('');
  log('  1. (cloud) create the boardsesh-ota-v3 bucket + a dedicated Railway Postgres,');
  log('       deploy ghcr.io/mercuretechnologies/expo-open-ota:v3.0.5 on Railway,');
  log('       point updates.boardsesh.com at it (see docs/mobile-ota-updates.md).');
  log('  2. vp run mobile:ota-setup keys');
  log('       → prints the V3 Railway env block + the cert-export steps.');
  log('         Create the app in /dashboard, export certs/certificate.pem, commit it.');
  log('  3. vp run mobile:ota-setup github --url https://updates.boardsesh.com/manifest');
  log('       → sets the EXPO_UPDATES_URL repo variable + checks EOO_TOKEN / OTA_ADMIN_*.');
  log('  4. Ship one native build from main, then let the production OTA publish once.');
  log('  5. vp run mobile:ota-setup map         (needs OTA_ADMIN_EMAIL + OTA_ADMIN_PASSWORD; `expo` alias)');
  log('       → maps the `production` channel → its branch (dashboard or headless).');
  log('  6. vp run mobile:ota-setup preview     (optional — per-PR preview channels)');
  log('       → prints the S3 {appId}/pr- lifecycle rule + ensures the GitHub environments/secrets.');
  log('');
  log('Full runbook: docs/mobile-ota-updates.md');
}

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const phase = args[0];

switch (phase) {
  case 'keys':
    printServerSetup();
    break;
  // The phase maps on our own server; `expo` is a backwards-compatible alias.
  case 'map':
  case 'expo':
    setupChannel();
    break;
  case 'github':
    setupGithub(parseUrlFlag(args));
    break;
  case 'preview':
    setupPreview();
    break;
  case undefined:
    printRunbook();
    break;
  default:
    fail(
      `Unknown phase "${phase}". Expected one of: keys, map (alias: expo), github, preview (or no argument for the runbook).`,
    );
}
