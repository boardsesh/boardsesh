/// <reference types="node" />
// Orchestrated Expo-web smoke runner: boots the full expo-web dev stack
// (backend + Next proxy + Metro web) via the dev orchestrator, waits for the
// /app surface to serve, runs the `expo-web-smoke` Playwright project against
// the printed Next origin, then tears the stack down. Exit code mirrors
// Playwright's. Invoked by `vp run test:e2e:expo-web` (which provides db:up +
// the web-runtime install as task dependencies).

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as setNodeTimeout } from 'node:timers';

import { extractExpoWebEntryBundleSource } from './lib/expo-web-readiness';

const repoRoot = path.resolve(__dirname, '..');
const READY_LINE = /\[dev\] Expo web app: (\S+)/;
const APP_READY_TIMEOUT_MS = 300_000;
const APP_POLL_INTERVAL_MS = 2_000;

function hasExited(child: ChildProcess): boolean {
  // A signal-killed child (OOM killer, external SIGKILL) has exitCode === null
  // but signalCode set — checking exitCode alone would treat it as still
  // running, register an 'exit' listener that never fires (the event already
  // did), and hang the returned promise. That hang drains the event loop and
  // turns a crashed stack into exit code 0.
  return child.exitCode !== null || child.signalCode !== null;
}

function terminate(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (hasExited(child)) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    // The orchestrator terminates its full child tree on SIGTERM.
    child.kill('SIGTERM');
    const forceKillTimeout = setNodeTimeout(() => {
      if (!hasExited(child)) child.kill('SIGKILL');
    }, 15_000) as unknown as NodeJS.Timeout;
    forceKillTimeout.unref();
  });
}

async function waitForAppSurface(appUrl: string): Promise<void> {
  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  let lastFailure = 'no request made yet';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(appUrl, { redirect: 'manual' });
      if (response.ok) {
        const html = await response.text();
        // Dev-mode Metro references the entry as a `<script src>` containing
        // `entry.bundle` + `platform=web` — the same detection the dev
        // orchestrator's prewarm uses (extractExpoWebEntryBundleSource), so
        // this probe and the prewarm agree on what "ready" means. An exported
        // shell instead references hashed bundles under `/_expo`. Accept
        // either; an error page or a bare Next proxy response (which can
        // still carry an `/app/` link) matches neither.
        if (extractExpoWebEntryBundleSource(html) !== null || html.includes('/_expo')) return;
        lastFailure = 'HTML shell missing the Expo entry reference';
      } else {
        lastFailure = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastFailure = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, APP_POLL_INTERVAL_MS));
  }
  throw new Error(`Expo web app at ${appUrl} not ready within ${APP_READY_TIMEOUT_MS / 1000}s (last: ${lastFailure})`);
}

async function main(): Promise<number> {
  const orchestrator = spawn(
    path.join(repoRoot, 'node_modules/.bin/tsx'),
    ['scripts/dev-orchestrator.ts', '--expo-web'],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env,
    },
  );

  const appUrl = await new Promise<string>((resolve, reject) => {
    const bootTimeout = setNodeTimeout(
      () => reject(new Error('dev orchestrator never printed the Expo web app URL')),
      APP_READY_TIMEOUT_MS,
    ) as unknown as NodeJS.Timeout;
    bootTimeout.unref();
    orchestrator.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      const readyMatch = READY_LINE.exec(text);
      if (readyMatch) {
        clearTimeout(bootTimeout);
        resolve(readyMatch[1]);
      }
    });
    orchestrator.once('exit', (code) => {
      clearTimeout(bootTimeout);
      reject(new Error(`dev orchestrator exited early with code ${code}`));
    });
  }).catch(async (error: unknown) => {
    await terminate(orchestrator);
    throw error;
  });

  try {
    await waitForAppSurface(appUrl);
    const nextOrigin = new URL(appUrl).origin;
    const playwright = spawn(
      'vp',
      ['exec', 'playwright', 'test', '--project=expo-web-smoke', '--config=playwright.config.ts'],
      {
        cwd: path.join(repoRoot, 'packages/web'),
        stdio: 'inherit',
        env: {
          ...process.env,
          PLAYWRIGHT_TEST_BASE_URL: nextOrigin,
          PLAYWRIGHT_SKIP_CLASSIC_SETUP: '1',
          TEST_USER_EMAIL: process.env.TEST_USER_EMAIL ?? 'test@boardsesh.com',
          TEST_USER_PASSWORD: process.env.TEST_USER_PASSWORD ?? 'test',
        },
      },
    );
    return await new Promise<number>((resolve) => {
      playwright.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    await terminate(orchestrator);
  }
}

main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error: unknown) => {
    console.error('[expo-web-e2e]', error);
    process.exit(1);
  });
