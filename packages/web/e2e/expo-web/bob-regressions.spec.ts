import { expect, test, type Page } from '@playwright/test';
import { CONSENT_VERSION } from '@boardsesh/consent';
import type { Gym, PlaceSuggestion, UserBoard } from '@boardsesh/shared-schema';

test.describe.configure({ mode: 'serial' });

const COLD_LOAD_TIMEOUT_MS = 180_000;
const WARM_TIMEOUT_MS = 30_000;
const GYM_NAME = 'Central Rock Gym Atlanta Bouldering';
const BOARD_NAME = 'Atlanta Kilter';
const ATLANTA: PlaceSuggestion = {
  id: 4180439,
  name: 'Atlanta',
  region: 'Georgia',
  country: 'United States',
  countryCode: 'US',
  latitude: 33.749,
  longitude: -84.388,
};
const GYM: Gym = {
  uuid: 'ec467822-d95a-49b4-9001-af6eeb3ad701',
  ownerId: 'e2e-gym-owner',
  name: GYM_NAME,
  address: 'Atlanta, Georgia',
  latitude: ATLANTA.latitude,
  longitude: ATLANTA.longitude,
  isPublic: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  boardCount: 1,
  boardTypes: ['kilter'],
  memberCount: 0,
  followerCount: 0,
  commentCount: 0,
  isFollowedByMe: false,
  isMember: false,
  canEdit: false,
  canGrantAccess: false,
  canClaim: false,
  isClaimed: true,
  canClaimByDomain: false,
};
const BOARD: UserBoard = {
  uuid: '527c60ae-fd5a-4de4-8449-e2e6cecb08ef',
  slug: 'e2e-atlanta-kilter',
  ownerId: 'e2e-gym-owner',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 7,
  setIds: '1',
  name: BOARD_NAME,
  isPublic: true,
  isUnlisted: false,
  hideLocation: false,
  isOwned: false,
  angle: 40,
  isAngleAdjustable: true,
  hasLeds: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  totalAscents: 0,
  uniqueClimbers: 0,
  followerCount: 0,
  commentCount: 0,
  isFollowedByMe: true,
  gymUuid: GYM.uuid,
  gymName: GYM_NAME,
  canEdit: false,
};

type GraphQLRequest = {
  query?: string;
  variables?: { query?: string; input?: Record<string, unknown>; gymUuid?: string; boardUuid?: string };
};

/** Only discovery and consent are stubbed; credentials and sign-out use the dev server. */
async function prepareBrowser(page: Page): Promise<{ gymSearches: Array<Record<string, unknown>> }> {
  await page.addInitScript(() => {
    const denyLocation = (_success: PositionCallback, failure?: PositionErrorCallback | null) => {
      failure?.({
        code: 1,
        message: 'Location denied for this test',
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      });
    };
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: denyLocation, watchPosition: denyLocation, clearWatch: () => {} },
    });
    Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: undefined });
  });
  const gymSearches: Array<Record<string, unknown>> = [];
  await page.route('**/graphql', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const { query = '', variables } = route.request().postDataJSON() as GraphQLRequest;
    let response: Record<string, unknown>;
    if (/\bquery\s+SearchPlaces\b/.test(query)) {
      response = { searchPlaces: variables?.query === 'Atlanta' ? [ATLANTA] : [] };
    } else if (/\bquery\s+SearchGyms\b/.test(query)) {
      const input = variables?.input ?? {};
      gymSearches.push(input);
      // A name result without a pin must still reach the list and its roster.
      const gym = input.query ? { ...GYM, latitude: null, longitude: null } : GYM;
      response = { searchGyms: { gyms: [gym], totalCount: 1, hasMore: false } };
    } else if (/\bquery\s+SearchBoards\b/.test(query)) {
      response = { searchBoards: { boards: [], totalCount: 0, hasMore: false } };
    } else if (/\bquery\s+GetGymBoardsForSwitcher\b/.test(query) && variables?.gymUuid === GYM.uuid) {
      response = { gymBoards: [BOARD] };
    } else if (/\bquery\s+GetBoard\b/.test(query) && variables?.boardUuid === BOARD.uuid) {
      response = { board: BOARD };
    } else if (/\bquery\s+GetMyAnalyticsConsent\b/.test(query)) {
      response = {
        myAnalyticsConsent: {
          analytics: 'denied',
          version: CONSENT_VERSION,
          source: 'web',
          decidedAt: '2026-01-01T00:00:00.000Z',
        },
      };
    } else if (/\bquery\s+GetConsentRegion\b/.test(query)) {
      response = { consentRegion: { countryCode: 'US', promptRequired: false, globalPrivacyControl: false } };
    } else return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': route.request().headers().origin ?? '*',
        'access-control-allow-credentials': 'true',
      },
      body: JSON.stringify({ data: response }),
    });
  });
  return { gymSearches };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/app/auth/login', { timeout: COLD_LOAD_TIMEOUT_MS });
  const email = page.getByRole('textbox', { name: 'Email', exact: true });
  const userMenu = page.getByRole('button', { name: 'User menu', exact: true });
  await expect(email.or(userMenu).first()).toBeVisible({ timeout: COLD_LOAD_TIMEOUT_MS });
  if (await email.isVisible()) {
    await email.fill(process.env.TEST_USER_EMAIL ?? 'test@boardsesh.com');
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill(process.env.TEST_USER_PASSWORD ?? 'test');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await expect(userMenu).toBeVisible({ timeout: WARM_TIMEOUT_MS });
}

test('onboarding city selection finds Atlanta gyms with location denied', async ({ page }) => {
  const { gymSearches } = await prepareBrowser(page);
  await signIn(page);
  await page.goto('/app/gyms?source=onboarding', { timeout: COLD_LOAD_TIMEOUT_MS });
  const search = page.getByRole('combobox', { name: 'Search a city, gym, or board' });
  await search.fill('Atlanta');
  await page.getByRole('option', { name: 'Atlanta, Georgia, United States', exact: true }).click();

  await expect(page.getByText(GYM_NAME, { exact: true })).toBeVisible();
  expect(gymSearches.at(-1)).toMatchObject({ latitude: ATLANTA.latitude, longitude: ATLANTA.longitude, radiusKm: 50 });
  expect(gymSearches.at(-1)).not.toHaveProperty('query');
  await page.getByText(GYM_NAME, { exact: true }).click();
  await expect(page.getByText(BOARD_NAME, { exact: true })).toBeVisible();
});

test('gym-name search shows a pinless gym, activates its board, and explains Bluetooth', async ({ page }) => {
  const { gymSearches } = await prepareBrowser(page);
  await signIn(page);
  await page.goto('/app/gyms', { timeout: COLD_LOAD_TIMEOUT_MS });
  const search = page.getByRole('combobox', { name: 'Search a city, gym, or board' });
  await search.fill('atlanta bouldering');
  await search.press('Enter');

  await expect(page.getByText(GYM_NAME, { exact: true })).toBeVisible();
  expect(gymSearches.at(-1)).toMatchObject({ query: 'atlanta bouldering' });
  expect(gymSearches.at(-1)).not.toHaveProperty('latitude');
  expect(gymSearches.at(-1)).not.toHaveProperty('longitude');
  await page.getByText(GYM_NAME, { exact: true }).click();
  await page.getByText(BOARD_NAME, { exact: true }).click();
  await expect(page).toHaveURL(/\/app\/climbs(?:\?|$)/);
  const connect = page.getByRole('button', { name: 'Connect Board', exact: true }).first();
  await expect(connect).toBeVisible({ timeout: WARM_TIMEOUT_MS });
  await connect.click();
  await expect(page.getByText('Bluetooth in your browser', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'WebBT setup', exact: true })).toBeVisible();
  await expect(page.getByText(/You can still browse climbs and grades\./)).toBeVisible();
});

test('Sign out is near account details, cancellation keeps login, and confirmation survives reload', async ({
  page,
}) => {
  await prepareBrowser(page);
  await signIn(page);
  const userMenu = page.getByRole('button', { name: 'User menu', exact: true });
  await userMenu.click();
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(signOut).toBeVisible();
  const signOutBounds = await signOut.boundingBox();
  const settingsBounds = await page.getByRole('button', { name: 'Settings', exact: true }).boundingBox();
  expect(signOutBounds).not.toBeNull();
  expect(settingsBounds).not.toBeNull();
  expect(signOutBounds?.y).toBeLessThan(settingsBounds?.y ?? 0);
  await signOut.click();
  await expect(page.getByText('Sign out?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await userMenu.click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByText('Sign out?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const email = page.getByRole('textbox', { name: 'Email', exact: true });
  await expect(email).toBeVisible({ timeout: WARM_TIMEOUT_MS });
  await page.reload();
  await expect(email).toBeVisible({ timeout: WARM_TIMEOUT_MS });
});
