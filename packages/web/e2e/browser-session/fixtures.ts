import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { CONSENT_COOKIE_NAME, CONSENT_VERSION, serializeConsentCookieValue } from '@boardsesh/consent';
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { addLegacySession, type LegacySessionShape, type MintedLegacySession } from './legacy-session';
import {
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
 * checks in each engine (docs/better-auth-browser-session.md, "Browser-session
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

const WEBKIT_INTERNAL_ERROR = /WebKit encountered an internal error/;

/**
 * One named infrastructure retry (harness-retries.ts): WebKit failing a
 * navigation with "internal error", a failure of its network stack through the
 * proxy, not an answer from the app. The navigation is tried once more, and
 * the setup process counts it; the run fails when there were more than two.
 */
function retryWebKitInternalError(page: Page, stack: BrowserSessionStack): void {
  const retried =
    <Result>(navigate: () => Promise<Result>) =>
    async (): Promise<Result> => {
      try {
        return await navigate();
      } catch (error) {
        if (!(error instanceof Error) || !WEBKIT_INTERNAL_ERROR.test(error.message)) throw error;
        console.info(`[harness-retry] webkit-internal-error on ${page.url()}`);
        await control(stack, '/harness-retry', { method: 'POST', body: '{}' });
        return navigate();
      }
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
