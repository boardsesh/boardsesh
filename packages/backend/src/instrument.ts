// Sentry initialization. MUST be imported before anything else in the backend
// entry point so OpenTelemetry can patch HTTP/Postgres/Redis/etc. modules
// before they're loaded. See https://docs.sentry.io/platforms/javascript/guides/node/install/
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const inheritedEnvKeys = new Set(Object.keys(process.env));
const dotenvConfigPath = process.env.DOTENV_CONFIG_PATH;
if (dotenvConfigPath) {
  dotenv.config({ path: dotenvConfigPath });
} else {
  dotenv.config();
}

function applyGeneratedDevDbEnv(): void {
  const sourceFile = fileURLToPath(import.meta.url);
  const generatedEnvFile = resolve(dirname(sourceFile), '../../..', '.boardsesh', 'dev-db.env');
  if (!existsSync(generatedEnvFile)) return;

  const lines = readFileSync(generatedEnvFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    const separatorIndex = trimmedLine.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmedLine.slice(0, separatorIndex);
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (inheritedEnvKeys.has(key)) continue;

    process.env[key] = trimmedLine.slice(separatorIndex + 1);
  }
}

applyGeneratedDevDbEnv();
dotenv.config({ path: '.env.development.local', override: true });

import * as Sentry from '@sentry/node';
// Leaf config module — pure env-detection helpers with no side effects and no
// postgres/driver imports, so pulling it in here can't defeat the OTel patching
// this file must run before.
import { isProductionSentryEnvironment, resolveSentryEnvironment } from '@boardsesh/db/client/config';

// Report only from the *production* environment. Railway prod leaves NODE_ENV
// unset, so we can't gate on `NODE_ENV === 'production'` (that regressed prod to
// silence — issue #3603 / #3183); but "any non-dev, non-test runtime" was too
// broad and let preview/staging backends (branch-deploy.yml runs them with
// NODE_ENV=production) pollute the prod project, disguised as `environment:
// production`. resolveSentryEnvironment() collapses both: prod resolves to
// 'production' and stays on, while preview/staging declare SENTRY_ENVIRONMENT and
// opt out. It also treats a private DATABASE_URL and a GitHub Actions runner as
// non-production, which is what keeps a laptop or an e2e job running
// `pnpm --filter boardsesh-backend run start` (no NODE_ENV, so prod-shaped to every other check) from
// filing its dev-database failures against prod. See @boardsesh/db/client/config.
const dsn =
  process.env.SENTRY_DSN ??
  'https://f55e6626faf787ae5291ad75b010ea14@o4510644927660032.ingest.us.sentry.io/4510644930150400';

Sentry.init({
  dsn,
  enabled: isProductionSentryEnvironment() && Boolean(dsn),
  enableLogs: true,
  // Matches the web service. Backend tags events with userId / clientIp from
  // ConnectionContext for incident triage; the data is already in our own
  // logs and is not exfiltrated beyond Sentry.
  sendDefaultPii: true,
  // Platform-neutral — no RAILWAY_*-style branching. See resolveSentryEnvironment.
  environment: resolveSentryEnvironment(),
  serverName: 'boardsesh-backend',
});

// Sentry's default integrations install onUncaughtExceptionIntegration and
// onUnhandledRejectionIntegration, which capture *and* preserve Node's
// "exit on unhandled" behavior. Don't add manual process.on() handlers here:
// they'd shadow Sentry's, and a bare captureException without exit leaves
// the process in an undefined state (per Node docs).
