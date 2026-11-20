/// <reference types="node" />
// Orchestrated browser-session e2e (#7596, B7a): builds the standalone Expo web
// export with the three `.test` origins baked in, then runs the Playwright
// config in packages/web/e2e/browser-session, whose global setup boots the real
// backend, www, the static app host and the TLS proxy against the dev database.
// Exit code mirrors Playwright's. Invoked by `vp run test:e2e:browser-session`
// (which provides db:up and the web-runtime install as task dependencies).
//
// Extra arguments go to Playwright, e.g. `-- --project=webkit`.
// BROWSER_SESSION_E2E_REUSE_EXPORT=1 skips the export when one is already there.
// BROWSER_SESSION_E2E_GREP=@smoke runs only the specs whose title has that tag
// (the per-PR subset of the acceptance specs; the nightly runs them all).
// AUTH_BROWSER_SESSION_MODE=better-auth starts both servers in the new mode,
// with every precondition it checks (global-setup.ts, better-auth-environment.ts).
// BROWSER_SESSION_E2E_WWW=production (or the `--www-production` flag) runs www as
// `next build` + `next start` instead of `next dev`: Router Cache behaviour and
// several auth branches differ under NODE_ENV=production. The build is slow, so
// the nightly uses it and a pull request does not.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  APP_EXPORT_ENVIRONMENT_VARIABLE,
  APP_ORIGIN,
  BACKEND_ORIGIN,
  GRAPHQL_URL,
  WWW_ORIGIN,
} from '../packages/web/e2e/browser-session/stack';

const repoRoot = path.resolve(__dirname, '..');
const exportDirectory = path.join(repoRoot, '.boardsesh/browser-session/app-export');

function buildExport(): void {
  if (process.env.BROWSER_SESSION_E2E_REUSE_EXPORT === '1' && existsSync(path.join(exportDirectory, 'index.html'))) {
    console.info(`[browser-session-e2e] reusing the Expo web export in ${exportDirectory}`);
    return;
  }
  console.info('[browser-session-e2e] building the standalone Expo web export (baseUrl /)');
  const build = spawnSync('bash', ['scripts/build-expo-web-export.sh', '--subdomain', exportDirectory], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Baked into the bundle, as production bakes https://www.boardsesh.com and https://ws.boardsesh.com.
      EXPO_PUBLIC_WEB_URL: WWW_ORIGIN,
      EXPO_PUBLIC_APP_URL: APP_ORIGIN,
      EXPO_PUBLIC_BACKEND_URL: BACKEND_ORIGIN,
      EXPO_PUBLIC_WS_URL: GRAPHQL_URL,
      BOARDSESH_EXPORT_EXPECT_URLS: `${WWW_ORIGIN} ${BACKEND_ORIGIN}`,
    },
  });
  if (build.status !== 0) {
    throw new Error(`the Expo web export failed (exit ${build.status ?? build.signal})`);
  }
}

function runPlaywright(extraArguments: string[]): Promise<number> {
  const playwright = spawn(
    'vp',
    ['exec', 'playwright', 'test', '--config=e2e/browser-session/playwright.config.ts', ...extraArguments],
    {
      cwd: path.join(repoRoot, 'packages/web'),
      stdio: 'inherit',
      env: {
        ...process.env,
        [APP_EXPORT_ENVIRONMENT_VARIABLE]: exportDirectory,
        TEST_USER_EMAIL: process.env.TEST_USER_EMAIL ?? 'test@boardsesh.com',
        TEST_USER_PASSWORD: process.env.TEST_USER_PASSWORD ?? 'test',
      },
    },
  );
  return new Promise<number>((resolve) => {
    playwright.once('exit', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<number> {
  // vp forwards the literal `--` separator into a script's argv.
  const extraArguments = process.argv.slice(2).filter((argument) => argument !== '--');
  const productionFlag = extraArguments.indexOf('--www-production');
  if (productionFlag !== -1) {
    extraArguments.splice(productionFlag, 1);
    process.env.BROWSER_SESSION_E2E_WWW = 'production';
  }
  const grep = process.env.BROWSER_SESSION_E2E_GREP;
  if (grep) extraArguments.push(`--grep=${grep}`);
  buildExport();
  return runPlaywright(extraArguments);
}

main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error: unknown) => {
    console.error('[browser-session-e2e]', error);
    process.exit(1);
  });
