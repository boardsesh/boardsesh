import type { Page } from '@playwright/test';
import { APP_ORIGIN, WWW_ORIGIN, type SeededAccount } from './stack';

/** What www's cookie route (`/api/internal/ws-auth`) says about the viewer. */
export interface WsAuthRead {
  authenticated: boolean;
  userId?: string;
  authSessionId?: string;
}

/** The viewer www's cookie route answers for, called from the page's own origin or cross-origin from the app. */
export async function readViewer(page: Page): Promise<WsAuthRead> {
  return page.evaluate(async (wwwOrigin) => {
    const response = await fetch(`${wwwOrigin}/api/internal/ws-auth`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const { authenticated, userId, authSessionId } = (await response.json()) as WsAuthRead;
    return { authenticated, userId, authSessionId };
  }, WWW_ORIGIN);
}

/** Signs `account` in through www's own login form and lands on /settings. */
export async function signInOnWww(page: Page, account: SeededAccount): Promise<void> {
  await page.goto(`${WWW_ORIGIN}/auth/login?callbackUrl=${encodeURIComponent('/settings')}`);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL(`${WWW_ORIGIN}/settings`);
}

/** Opens the app and declines the one-time analytics question a fresh account may be asked. */
export async function openApp(page: Page): Promise<void> {
  const consentPrompt = page.getByRole('button', { name: 'No thanks', exact: true });
  await page.addLocatorHandler(consentPrompt, async () => {
    await consentPrompt.click();
  });
  await page.goto(`${APP_ORIGIN}/`);
}
