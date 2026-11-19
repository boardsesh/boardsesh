import { readViewer, signInOnWww } from './helpers';
import { expect, test, type RestartOptions } from './fixtures';

/**
 * #7596 acceptance 8: AUTH_BROWSER_SESSION_MODE is the one switch for the
 * whole web cutover, and `better-auth` with a precondition missing refuses to
 * boot with the code the rollout doc names, on each service. Two preconditions
 * per service, each by restarting both servers with that one value removed
 * from that one server (`restartStack` reports the failed start and the last
 * lines of the server's log, which carry the code). The run then restarts
 * with everything back and a sign-in works.
 *
 * Server boot does not depend on the browser, so this runs in the `chromium`
 * project only. The rest of the codes are unit tests
 * (`authority/__tests__/browser-session-mode.test.ts`,
 * `app/lib/auth/__tests__/browser-session-mode.server.test.ts`).
 */

test.skip(process.env.AUTH_BROWSER_SESSION_MODE !== 'better-auth', 'Runs under AUTH_BROWSER_SESSION_MODE=better-auth.');
test.describe.configure({ timeout: 1_200_000 });

const REFUSALS: ReadonlyArray<readonly [string, RestartOptions, string]> = [
  [
    'the backend without AUTH_LEGACY_BRIDGE_UNTIL',
    { backendEnv: { AUTH_LEGACY_BRIDGE_UNTIL: null } },
    'AUTH_BROWSER_SESSION_LEGACY_BRIDGE_UNTIL_INVALID',
  ],
  [
    'the backend without CURRENT_STORE_WEB_SESSION_MODE',
    { backendEnv: { CURRENT_STORE_WEB_SESSION_MODE: null } },
    'AUTH_BROWSER_SESSION_WEB_SESSION_MODE_REQUIRED',
  ],
  [
    'www without CURRENT_STORE_WEB_OAUTH_MODE',
    { webEnv: { CURRENT_STORE_WEB_OAUTH_MODE: null } },
    'AUTH_BROWSER_SESSION_WEB_OAUTH_MODE_REQUIRED',
  ],
  [
    'www without AUTH_BROWSER_SESSION_COOKIE_SECRET',
    { webEnv: { AUTH_BROWSER_SESSION_COOKIE_SECRET: null } },
    'AUTH_BROWSER_SESSION_WEB_COOKIE_SECRET_INVALID',
  ],
];

test('better-auth with one precondition missing refuses to boot with its code, on each service', async ({
  page,
  freshAccount,
  restartStack,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Server boot is engine-independent; runs once, in chromium.');
  try {
    for (const [label, options, code] of REFUSALS) {
      const failure = await restartStack(options).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(failure, `${label}: the restart should have failed`).toBeDefined();
      expect(failure, label).toContain(code);
    }
  } finally {
    await restartStack();
  }
  // Back with every precondition: a login is answered and read back.
  const account = freshAccount();
  await signInOnWww(page, account);
  expect((await readViewer(page)).userId).toBe(account.userId);
});
