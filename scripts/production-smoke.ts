#!/usr/bin/env tsx
/// <reference types="node" />

/**
 * Post-deploy smoke for www.boardsesh.com.
 *
 * `deploy-web` had no post-deploy verification at all: a deploy that built and
 * uploaded cleanly but 500s on every request reported success, and the first
 * signal was a user. This script is the detector — it runs after the deploy,
 * so it cannot block one, but it turns the job red and fires notify-failure.
 *
 * Scope is deliberately shallow. These are reachability and shape checks over
 * the surfaces that (a) carry organic traffic, (b) other systems depend on, or
 * (c) are load-bearing for the Expo Web Program's front door. Anything needing
 * a session, a mutation, or seeded data belongs in e2e, not here — this runs
 * against production and must stay read-only.
 *
 *   vp run smoke:production                    # www.boardsesh.com
 *   vp run smoke:production -- --base <url>    # a preview deployment
 *
 * Fixture-dependent checks (kiosk, embed) need a real gym slug / board uuid.
 * They are configured through SMOKE_KIOSK_GYM_SLUG / SMOKE_EMBED_BOARD_UUID and
 * report as skipped when unset. They are NOT fail-closed on missing config:
 * a deploy gate that fails because someone forgot a repo variable stops
 * production deploys for days (see #3977), and that cure is worse than the
 * disease this script treats.
 */

import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'https://www.boardsesh.com';

/** Per-request ceiling. Generous: a cold serverless route can be slow. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Attempts per check, to ride out a single edge/CDN blip. */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

export type SmokeResponse = {
  status: number;
  contentType: string;
  body: string;
};

export type SmokeCheck = {
  /** Human-readable, appears in the pass/fail log. */
  name: string;
  /** Path appended to the base URL. */
  path: string;
  /**
   * Returns null when the check passes, or a reason string when it fails.
   * Never throws — a thrown error is reported as an infrastructure failure
   * rather than an assertion failure, which reads very differently on-call.
   */
  assert: (response: SmokeResponse) => string | null;
  /**
   * Env var holding the fixture this check needs. When set on the check and
   * absent from the environment, the check is skipped rather than failed.
   */
  fixtureEnvVar?: string;
};

function expectStatus(response: SmokeResponse, expected: number): string | null {
  return response.status === expected ? null : `expected HTTP ${expected}, got ${response.status}`;
}

function expectContentType(response: SmokeResponse, fragment: string): string | null {
  return response.contentType.includes(fragment)
    ? null
    : `expected content-type containing "${fragment}", got "${response.contentType}"`;
}

function expectBodyContains(response: SmokeResponse, needle: string, label: string): string | null {
  return response.body.includes(needle) ? null : `response body has no ${label}`;
}

/** First non-null failure reason, or null when every assertion passed. */
function firstFailure(...reasons: (string | null)[]): string | null {
  return reasons.find((reason) => reason !== null) ?? null;
}

export const WWW_CHECKS: SmokeCheck[] = [
  {
    name: 'homepage renders server-side',
    path: '/',
    // A spinner-only shell is the failure this catches: the page 200s, but the
    // crawlable payload is gone. An <h1> is the cheapest proof of real SSR.
    assert: (response) =>
      firstFailure(
        expectStatus(response, 200),
        expectContentType(response, 'text/html'),
        expectBodyContains(response, '<h1', 'server-rendered <h1>'),
      ),
  },
  {
    name: 'robots.txt serves and points at the sitemap',
    path: '/robots.txt',
    assert: (response) =>
      firstFailure(
        expectStatus(response, 200),
        expectContentType(response, 'text/plain'),
        expectBodyContains(response, 'Sitemap:', 'Sitemap: directive'),
      ),
  },
  {
    name: 'sitemap.xml serves at least one URL',
    path: '/sitemap.xml',
    assert: (response) =>
      firstFailure(
        expectStatus(response, 200),
        expectContentType(response, 'xml'),
        expectBodyContains(response, '<loc>', '<loc> entry'),
      ),
  },
  {
    name: 'auth session endpoint answers anonymously',
    path: '/api/auth/session',
    assert: (response) => firstFailure(expectStatus(response, 200), expectContentType(response, 'application/json')),
  },
  {
    name: 'ws-auth answers anonymously (kiosk + embed depend on it)',
    path: '/api/internal/ws-auth',
    // Kiosks and embeds open a presence socket with no session. If this starts
    // 401ing or 500ing, every unattended gym screen goes dark — and nobody is
    // watching a kiosk to report it.
    assert: (response) => {
      const failure = firstFailure(expectStatus(response, 200), expectContentType(response, 'application/json'));
      if (failure) return failure;
      try {
        const payload: unknown = JSON.parse(response.body);
        if (typeof payload !== 'object' || payload === null || !('authenticated' in payload)) {
          return 'payload has no `authenticated` field';
        }
        return null;
      } catch {
        return `payload is not valid JSON: ${response.body.slice(0, 120)}`;
      }
    },
  },
  {
    name: 'kiosk page renders for a real gym',
    path: '',
    fixtureEnvVar: 'SMOKE_KIOSK_GYM_SLUG',
    assert: (response) => firstFailure(expectStatus(response, 200), expectContentType(response, 'text/html')),
  },
  {
    name: 'board embed renders for a real board',
    path: '',
    fixtureEnvVar: 'SMOKE_EMBED_BOARD_UUID',
    assert: (response) => firstFailure(expectStatus(response, 200), expectContentType(response, 'text/html')),
  },
];

/** Fixture-backed paths, kept next to the checks that consume them. */
export const FIXTURE_PATHS: Record<string, (value: string) => string> = {
  SMOKE_KIOSK_GYM_SLUG: (slug) => `/kiosk/${slug}`,
  SMOKE_EMBED_BOARD_UUID: (uuid) => `/embed/board/${uuid}`,
};

function resolvePath(check: SmokeCheck, env: NodeJS.ProcessEnv): string | null {
  if (!check.fixtureEnvVar) return check.path;
  const fixtureValue = env[check.fixtureEnvVar];
  if (!fixtureValue) return null;
  const buildPath = FIXTURE_PATHS[check.fixtureEnvVar];
  return buildPath ? buildPath(fixtureValue) : null;
}

async function fetchOnce(url: string): Promise<SmokeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Identify the smoke in access logs, and ask for the uncached answer —
        // a CDN hit would happily serve the *previous* deploy's HTML and mask
        // exactly the regression this exists to catch.
        'User-Agent': 'boardsesh-production-smoke/1.0',
        'Cache-Control': 'no-cache',
      },
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      body: await response.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type CheckOutcome = { name: string; state: 'pass' | 'fail' | 'skip'; detail: string };

async function runCheck(check: SmokeCheck, baseUrl: string, env: NodeJS.ProcessEnv): Promise<CheckOutcome> {
  const path = resolvePath(check, env);
  if (path === null) {
    return { name: check.name, state: 'skip', detail: `${check.fixtureEnvVar} not set` };
  }

  const url = `${baseUrl}${path}`;
  let lastDetail = '';

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetchOnce(url);
      const failure = check.assert(response);
      if (failure === null) return { name: check.name, state: 'pass', detail: path };
      lastDetail = failure;
    } catch (error) {
      lastDetail = `request failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (attempt < ATTEMPTS) {
      console.log(`  ${check.name}: attempt ${attempt} failed (${lastDetail}); retrying in 5s...`);
      await delay(RETRY_DELAY_MS);
    }
  }

  return { name: check.name, state: 'fail', detail: `${path} — ${lastDetail}` };
}

function parseBaseUrl(argv: string[]): string {
  const flagIndex = argv.indexOf('--base');
  if (flagIndex === -1) return process.env.SMOKE_BASE_URL || DEFAULT_BASE_URL;
  const value = argv[flagIndex + 1];
  if (!value) throw new Error('--base needs a URL');
  return value.replace(/\/$/, '');
}

async function main(): Promise<void> {
  const baseUrl = parseBaseUrl(process.argv.slice(2));
  console.log(`Production smoke against ${baseUrl}\n`);

  const outcomes: CheckOutcome[] = [];
  for (const check of WWW_CHECKS) {
    const outcome = await runCheck(check, baseUrl, process.env);
    outcomes.push(outcome);
    const marker = outcome.state === 'pass' ? 'ok' : outcome.state === 'skip' ? '--' : 'FAIL';
    console.log(`${marker.padEnd(4)} ${outcome.name}${outcome.state === 'pass' ? '' : ` (${outcome.detail})`}`);
  }

  const failures = outcomes.filter((outcome) => outcome.state === 'fail');
  const skipped = outcomes.filter((outcome) => outcome.state === 'skip');
  console.log(
    `\n${outcomes.length - failures.length - skipped.length} passed, ${failures.length} failed, ${skipped.length} skipped`,
  );

  for (const failure of failures) {
    console.log(`::error::production smoke failed: ${failure.name} — ${failure.detail}`);
  }
  if (failures.length > 0) process.exit(1);
}

// Only run when invoked directly, so the test can import the check table.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::production smoke crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
