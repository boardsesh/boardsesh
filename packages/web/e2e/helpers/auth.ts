import type { Page } from '@playwright/test';

const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL ?? 'test@boardsesh.com';
const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD ?? 'test';

export async function loginAs(page: Page, callbackUrl = '/') {
  await page.goto('/auth/login?callbackUrl=' + encodeURIComponent(callbackUrl));
  await page.getByLabel('Email').fill(TEST_USER_EMAIL);
  await page.getByLabel('Password').fill(TEST_USER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(callbackUrl, { timeout: 20_000 });
}
