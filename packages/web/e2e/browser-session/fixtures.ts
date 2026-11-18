import { CONSENT_COOKIE_NAME, CONSENT_VERSION, serializeConsentCookieValue } from '@boardsesh/consent';
import { test as base, expect, type Browser, type BrowserContext } from '@playwright/test';
import { addLegacySession, type LegacySessionShape, type MintedLegacySession } from './legacy-session';
import {
  PARENT_DOMAIN,
  readStack,
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

/** Variables to set on both servers (null unsets one), over the environment the run started them with. */
export interface RestartOptions {
  env?: Record<string, string | null>;
}

interface Fixtures {
  stack: BrowserSessionStack;
  accountA: SeededAccount;
  accountB: SeededAccount;
  openContext: () => Promise<BrowserContext>;
  edgeCookies: EdgeCookies;
  legacySession: LegacySessionFixture;
  restartStack: (options?: RestartOptions) => Promise<void>;
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

async function newProxiedContext(browser: Browser, stack: BrowserSessionStack): Promise<BrowserContext> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    proxy: { server: stack.proxyServer },
  });
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

  restartStack: async ({ stack }, use) => {
    await use(async ({ env = {} } = {}) => {
      await control<{ state: string }>(stack, '/restart', { method: 'POST', body: JSON.stringify({ env }) });
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
