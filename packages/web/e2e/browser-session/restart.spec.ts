import { WS_HOST, WWW_ORIGIN } from './stack';
import { readViewer, signInOnWww } from './helpers';
import { expect, test } from './fixtures';

/**
 * `restartStack({ env })`: both servers stop and start again with a changed
 * environment, and the database, the edge, the browser context and the signed-in
 * session stay. The Phase B rollback spec uses it to flip AUTH_BROWSER_SESSION_MODE
 * between `legacy` and `better-auth` inside one run.
 *
 * Restarted with an innocuous change: the backend reports RAILWAY_DEPLOYMENT_ID
 * on /health/db and does nothing else with it, so the report shows the new
 * process is the one answering.
 */

test.skip(
  !!process.env.AUTH_BROWSER_SESSION_MODE,
  'The baseline runs in legacy mode; AUTH_BROWSER_SESSION_MODE is set for this run.',
);

test.describe.configure({ timeout: 600_000 });

test('the signed-in session survives a restart of both servers with a changed environment', async ({
  page,
  context,
  accountA,
  restartStack,
}) => {
  const deploymentId = async () =>
    ((await (await context.request.get(`https://${WS_HOST}/health/db`)).json()) as { deploymentId: string })
      .deploymentId;

  await signInOnWww(page, accountA);
  const before = await readViewer(page);
  expect(before.userId).toBe(accountA.userId);
  expect(await deploymentId()).not.toBe('browser-session-restart-1');

  await restartStack({ env: { RAILWAY_DEPLOYMENT_ID: 'browser-session-restart-1' } });

  expect(await deploymentId()).toBe('browser-session-restart-1');
  // Same browser context, same cookie: the new www process decodes it with the run's secret.
  await page.goto(`${WWW_ORIGIN}/settings`);
  expect(await readViewer(page)).toEqual(before);

  // Restarting with no changes goes back to the environment the run started with.
  await restartStack();
  expect(await deploymentId()).toBe('unknown');
  expect(await readViewer(page)).toEqual(before);
});
