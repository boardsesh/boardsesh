import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { viewerMarkerValue } from '@boardsesh/auth-protocol/browser-session-cookie';
import { resolve } from 'node:path';
import { CONSENT_COOKIE_NAME, CONSENT_VERSION, serializeConsentCookieValue } from '@boardsesh/consent';
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { firstLossOfContext, NETWORK_PROCESS_LOST_LOG_MARKER } from './harness-retries';
import { addLegacySession, type LegacySessionShape, type MintedLegacySession } from './legacy-session';
import type { CapturedMail } from './mail-sink';
import {
  MARKER_COOKIE,
  PARENT_DOMAIN,
  readStack,
  SEED_OUTPUT_PREFIX,
  SESSION_COOKIE_NAME,
  type BrowserSessionStack,
  type SeededAccount,
  type SetCookieRecord,
} from './stack';

/**
 * Every context goes through the stack's proxy, which is the only way both
 * engines reach the `.test` hosts without a hosts file: Chromium and WebKit each
 * honour a per-context proxy, and neither resolves the name itself. The proxy's
 * certificate is self-signed, so the context ignores HTTPS errors; `Secure`
 * cookies are still stored and sent over it, which `cookie-domain.spec.ts`
 * checks in each engine (docs/auth/better-auth-browser-session.md, "Browser-session
 * e2e harness").
 *
 * Fixtures beyond the context (docs, "What a spec can use"):
 *
 *   accountA, accountB   two seeded accounts: the dev database's test user and one made for the run
 *   openContext          another context, set up like `context`, closed with the test
 *   edgeCookies          a window over the Set-Cookie names every response carried
 *   legacySession        mints a legacy NextAuth session cookie and adds it to a context
 *   restartStack         restarts the backend and www with a changed environment
 *   freshAccount         a new account made for this one test, so tests never share sessions or limits
 *   accountDatabase      the few database steps a spec needs on its own accounts (database.ts)
 *   mailbox              what the run's mail sink took (mail-sink.ts): the emailed first-password link
 *   responseHolds        the edge holds the next response to a request until released (cookie order)
 */

/** One window over the edge's log: `end()` returns every response relayed since `begin()`. */
export interface SetCookieWindow {
  end(): Promise<SetCookieRecord[]>;
}

export interface EdgeCookies {
  begin(): Promise<SetCookieWindow>;
  /** Runs `action` and returns what it returned with every response relayed meanwhile. */
  during<T>(action: () => Promise<T>): Promise<{ result: T; records: SetCookieRecord[] }>;
}

export interface LegacySessionFixture {
  /** Adds a minted session for `account` in `shape` to `context` and returns the cookie names (never values). */
  addTo(context: BrowserContext, account: SeededAccount, shape: LegacySessionShape): Promise<MintedLegacySession>;
}

/**
 * Variables over the environment the run started the servers with (null unsets
 * one): `env` on both, `backendEnv` and `webEnv` on one each.
 */
export interface RestartOptions {
  env?: Record<string, string | null>;
  backendEnv?: Record<string, string | null>;
  webEnv?: Record<string, string | null>;
}

export interface AccountDatabase {
  /** Deletes the account's password row, as for a climber who only ever used Google. */
  removePassword(account: SeededAccount): void;
  /** Moves the session row's expiry to `days` ahead. */
  ageSession(account: SeededAccount, sessionId: string, days: number): void;
  /** The session row's expiry, or null when there is no row. */
  sessionExpiry(account: SeededAccount, sessionId: string): Date | null;
  /**
   * Makes the account one that may set a first password by email (database.ts
   * `first-password`): no password, a Google identity, a deliverable address and
   * its reservation. Returns the account with that address.
   */
  firstPasswordAccount(account: SeededAccount): SeededAccount;
  /** Whether the account has a password row. */
  hasPassword(account: SeededAccount): boolean;
}

export interface FirstPasswordLink {
  readonly token: string;
  readonly operation: string;
}

export interface Mailbox {
  /** The newest first-password link the run's mail sink took for `email`, waiting up to 20 s for one. */
  firstPasswordLink(email: string): Promise<FirstPasswordLink>;
  /** How many messages the mail sink has taken for `email`. */
  count(email: string): Promise<number>;
}

/** A response the edge holds after the server answered it, until `release()`. */
export interface HeldResponse {
  /** Resolves once the server answered the request and the edge is holding the response. */
  untilHeld(timeoutMs?: number): Promise<void>;
  release(): Promise<void>;
}

export interface ResponseHoldsFixture {
  /** Holds the next response to `method` `host``path` (path without query) at the edge. */
  arm(rule: { host: string; method: string; path: string }): Promise<HeldResponse>;
}

interface Fixtures {
  stack: BrowserSessionStack;
  accountA: SeededAccount;
  accountB: SeededAccount;
  openContext: () => Promise<BrowserContext>;
  edgeCookies: EdgeCookies;
  legacySession: LegacySessionFixture;
  restartStack: (options?: RestartOptions) => Promise<void>;
  freshAccount: () => SeededAccount;
  accountDatabase: AccountDatabase;
  mailbox: Mailbox;
  responseHolds: ResponseHoldsFixture;
}

const WEB_DIRECTORY = resolve(__dirname, '../..');

/** `database.ts` under tsx, as the global setup runs it. Returns what it printed. */
function databaseStep<T>(stack: BrowserSessionStack, args: string[]): T {
  const output = execFileSync('vp', ['exec', 'tsx', 'e2e/browser-session/database.ts', ...args], {
    cwd: WEB_DIRECTORY,
    env: { ...process.env, DATABASE_URL: stack.databaseUrl },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const line = output.split('\n').find((candidate) => candidate.startsWith(SEED_OUTPUT_PREFIX));
  if (!line) throw new Error(`database.ts ${args[0]} printed no result.`);
  return JSON.parse(line.slice(SEED_OUTPUT_PREFIX.length)) as T;
}

async function control<T>(stack: BrowserSessionStack, path: string, init?: RequestInit): Promise<T> {
  const { url, token } = stack.control;
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { 'x-control-token': token, 'content-type': 'application/json' },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`control ${path} answered ${response.status}: ${body.error ?? 'no detail'}`);
  return body;
}

/** The session cookies a window set or cleared, with the host, path and status of the response that did. */
export function sessionSetCookies(records: readonly SetCookieRecord[]) {
  return records.flatMap(({ host, path, status, setCookies }) =>
    setCookies
      .filter((cookie) => SESSION_COOKIE_NAME.test(cookie.name))
      .map((cookie) => ({ host, path, status, ...cookie })),
  );
}

/** The viewer marker writes and clears a window saw, with the host, path and status of the response. */
export function markerSetCookies(records: readonly SetCookieRecord[]) {
  return records.flatMap(({ host, path, status, setCookies }) =>
    setCookies.filter((cookie) => cookie.name === MARKER_COOKIE).map((cookie) => ({ host, path, status, ...cookie })),
  );
}

/** The marker a login carries, and the edge's digest of it (the edge logs no value). */
export function expectedMarker(authSessionId: string): { value: string; valueDigest: string } {
  const value = viewerMarkerValue(authSessionId);
  return { value, valueDigest: createHash('sha256').update(value).digest('hex').slice(0, 16) };
}

const WEBKIT_INTERNAL_ERROR = /WebKit encountered an internal error/;

/**
 * WebKit's network process holds a context's cookies in memory. When it dies,
 * every load in flight fails at once with "internal error" (in each failing
 * run so far: the app's session read, its icon font and its splash image, on
 * two hosts at the same instant), and the context comes back with no cookies:
 * the consent cookie every context starts with is gone, and the climber reads
 * as signed out. Nothing in the test can bring that state back.
 */

/**
 * Named infrastructure retries (harness-retries.ts), WebKit only:
 * - webkit-internal-error: the navigation itself, or its document or a script
 *   it loads, fails with "internal error" (the page never runs). The
 *   navigation is tried once more.
 * - webkit-network-process-lost: a load fails with "internal error" and the
 *   context's cookies are gone with it. The test cannot go on; its log gets
 *   the marker, and only a test whose failed attempt carries it may run once
 *   more (playwright.config.ts, harness-retry-reporter.ts).
 * Every request WebKit fails is logged with its URL, so a failure outside
 * these classes is visible. The setup process counts each retry; the run
 * fails when there were more than two.
 */
function retryWebKitInternalError(page: Page, stack: BrowserSessionStack): void {
  let failedLoads: string[] = [];
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'no detail';
    // A request the page itself cancelled (a navigation, an abort) is not a network failure.
    if (/cancelled/i.test(failure)) return;
    console.info(`[webkit] request failed: ${request.method()} ${request.url().slice(0, 200)} (${failure})`);
    if (!WEBKIT_INTERNAL_ERROR.test(failure)) return;
    if (['document', 'script'].includes(request.resourceType())) failedLoads.push(request.url());
    void page
      .context()
      .cookies()
      .then(async (cookies) => {
        const consentKept = cookies.some((cookie) => cookie.name === CONSENT_COOKIE_NAME);
        console.info(`[webkit] after the failure the context holds ${cookies.length} cookies`);
        // One lost context counts once, however many of its pages see it.
        if (consentKept || !firstLossOfContext(page.context())) return;
        console.info(
          `${NETWORK_PROCESS_LOST_LOG_MARKER}: the context lost its cookies with ${request.url().slice(0, 200)}`,
        );
        await control(stack, '/harness-retry', {
          method: 'POST',
          body: JSON.stringify({ kind: 'webkit-network-process-lost' }),
        });
      })
      .catch(() => undefined);
  });
  const retried =
    <Result>(navigate: () => Promise<Result>) =>
    async (): Promise<Result> => {
      failedLoads = [];
      let result: Result;
      try {
        result = await navigate();
      } catch (error) {
        if (!(error instanceof Error) || !WEBKIT_INTERNAL_ERROR.test(error.message)) throw error;
        console.info(`[harness-retry] webkit-internal-error on ${page.url()}`);
        await control(stack, '/harness-retry', { method: 'POST', body: '{}' });
        return navigate();
      }
      if (failedLoads.length === 0) return result;
      console.info(`[harness-retry] webkit-internal-error loading ${failedLoads[0]?.slice(0, 200)}`);
      await control(stack, '/harness-retry', { method: 'POST', body: '{}' });
      failedLoads = [];
      return navigate();
    };
  const goto = page.goto.bind(page);
  const reload = page.reload.bind(page);
  page.goto = (url, options) => retried(() => goto(url, options))();
  page.reload = (options) => retried(() => reload(options))();
}

async function newProxiedContext(browser: Browser, stack: BrowserSessionStack): Promise<BrowserContext> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    proxy: { server: stack.proxyServer },
  });
  if (browser.browserType().name() === 'webkit') context.on('page', (page) => retryWebKitInternalError(page, stack));
  // Analytics declined up front, so no consent banner sits over a form. A
  // Domain cookie on the parent, so every host under it sees the same answer.
  await context.addCookies([
    {
      name: CONSENT_COOKIE_NAME,
      value: serializeConsentCookieValue({
        analytics: 'denied',
        version: CONSENT_VERSION,
        source: 'web',
        decidedAt: new Date().toISOString(),
      }),
      domain: `.${PARENT_DOMAIN}`,
      path: '/',
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  return context;
}

export const test = base.extend<Fixtures>({
  // Read once per test. Its own fixture, so the others need no empty destructuring pattern.
  stack: async ({ browserName }, use) => {
    void browserName;
    await use(readStack());
  },

  context: async ({ browser, stack }, use) => {
    const context = await newProxiedContext(browser, stack);
    await use(context);
    await context.close();
  },

  openContext: async ({ browser, stack }, use) => {
    const opened: BrowserContext[] = [];
    await use(async () => {
      const context = await newProxiedContext(browser, stack);
      opened.push(context);
      return context;
    });
    await Promise.all(opened.map((context) => context.close()));
  },

  accountA: async ({ stack }, use) => {
    await use(stack.accounts.accountA);
  },

  accountB: async ({ stack }, use) => {
    await use(stack.accounts.accountB);
  },

  edgeCookies: async ({ stack }, use) => {
    const begin = async (): Promise<SetCookieWindow> => {
      const { mark } = await control<{ mark: number }>(stack, '/set-cookies/mark');
      return {
        end: async () => (await control<{ records: SetCookieRecord[] }>(stack, `/set-cookies?since=${mark}`)).records,
      };
    };
    await use({
      begin,
      during: async (action) => {
        const window = await begin();
        const result = await action();
        return { result, records: await window.end() };
      },
    });
  },

  legacySession: async ({ stack }, use) => {
    await use({
      addTo: (context, account, shape) => addLegacySession(context, account, shape, stack.nextAuthSecret),
    });
  },

  freshAccount: async ({ stack }, use) => {
    await use(() => databaseStep<SeededAccount>(stack, ['create', `${stack.runAccountPrefix}${randomUUID()}`]));
  },

  accountDatabase: async ({ stack }, use) => {
    await use({
      removePassword: (account) => {
        databaseStep(stack, ['remove-password', account.userId]);
      },
      ageSession: (account, sessionId, days) => {
        const { aged } = databaseStep<{ aged: number }>(stack, [
          'age-session',
          account.userId,
          sessionId,
          String(days),
        ]);
        if (aged !== 1) throw new Error(`No session row ${sessionId} for ${account.userId}.`);
      },
      firstPasswordAccount: (account) => {
        const { email } = databaseStep<{ email: string }>(stack, ['first-password', account.userId]);
        return { ...account, email };
      },
      hasPassword: (account) =>
        databaseStep<{ hasPassword: boolean }>(stack, ['has-password', account.userId]).hasPassword,
      sessionExpiry: (account, sessionId) => {
        const { expiresAt } = databaseStep<{ expiresAt: string | null }>(stack, [
          'session-expiry',
          account.userId,
          sessionId,
        ]);
        return expiresAt === null ? null : new Date(expiresAt);
      },
    });
  },

  mailbox: async ({ stack }, use) => {
    const messages = async (email: string) =>
      (await control<{ messages: CapturedMail[] }>(stack, `/mail?to=${encodeURIComponent(email.toLowerCase())}`))
        .messages;
    await use({
      count: async (email) => (await messages(email)).length,
      firstPasswordLink: async (email) => {
        const deadline = Date.now() + 20_000;
        for (;;) {
          const links = (await messages(email))
            .map(({ text }) => /confirm-first-password#token=([A-Za-z0-9_-]{43})&operation=([a-f0-9]{64})/.exec(text))
            .filter((match): match is RegExpExecArray => match !== null);
          const newest = links.at(-1);
          if (newest) return { token: newest[1], operation: newest[2] };
          if (Date.now() > deadline) throw new Error(`No first-password email for ${email} within 20 s.`);
          await new Promise((settle) => setTimeout(settle, 250));
        }
      },
    });
  },

  responseHolds: async ({ stack }, use) => {
    const armed: string[] = [];
    await use({
      arm: async (rule) => {
        const { id } = await control<{ id: string }>(stack, '/holds', { method: 'POST', body: JSON.stringify(rule) });
        armed.push(id);
        return {
          untilHeld: async (timeoutMs = 60_000) => {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
              const { state } = await control<{ state: string }>(stack, `/holds/${id}`);
              if (state === 'holding') return;
              if (state === 'released') throw new Error('The hold was released before it held anything.');
              if (Date.now() > deadline)
                throw new Error(`No ${rule.method} ${rule.host}${rule.path} response within ${timeoutMs} ms.`);
              await new Promise((settle) => setTimeout(settle, 100));
            }
          },
          release: async () => {
            await control(stack, `/holds/${id}/release`, { method: 'POST', body: '{}' });
          },
        };
      },
    });
    // No hold outlives its test.
    for (const id of armed)
      await control(stack, `/holds/${id}/release`, { method: 'POST', body: '{}' }).catch(() => {});
  },

  restartStack: async ({ stack }, use) => {
    await use(async ({ env = {}, backendEnv = {}, webEnv = {} } = {}) => {
      await control<{ state: string }>(stack, '/restart', {
        method: 'POST',
        body: JSON.stringify({ env, backendEnv, webEnv }),
      });
      for (;;) {
        const { state, error } = await control<{ state: string; error?: string }>(stack, '/restart/status');
        if (state === 'ready') return;
        if (state === 'failed') throw new Error(`restartStack failed: ${error ?? 'no detail'}`);
        await new Promise((done) => setTimeout(done, 1_000));
      }
    });
  },
});

export { expect };
