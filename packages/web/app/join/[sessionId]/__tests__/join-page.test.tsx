import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { __resetSessionInboundCampaignForTests } from '@/app/lib/inbound-campaign';
import type { SessionInvite } from '../session-invite';

// The invite page as someone without the app sees it (#6004): what it says for
// each state of the session, and that the store buttons and the landing event
// are there in every one of them.

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    locale: 'en-US',
  })),
}));
vi.mock('@/app/lib/seo/dynamic-og-data', () => ({ getSessionOgSummary: vi.fn() }));
vi.mock('@/app/lib/board-data', () => ({ BOULDER_GRADES: [] }));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const trackBeforeNavigation = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn(), trackBeforeNavigation }));

const fetchSessionInvite = vi.hoisted(() => vi.fn());
vi.mock('../session-invite', () => ({ fetchSessionInvite }));

const JoinSessionPage = (await import('../page')).default;
const { __resetReportedLandingsForTests } = await import('../session-invite-landing-tracker');

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

function invite(overrides: Partial<SessionInvite> = {}): SessionInvite {
  return {
    state: 'live',
    hostName: 'Alex',
    boardLabel: 'Hangar Kilter',
    boardAngle: 40,
    gymName: 'The Climbing Hangar',
    ...overrides,
  };
}

const withoutDetails = { hostName: null, boardLabel: null, boardAngle: null, gymName: null };

async function renderPage(result: SessionInvite, sessionId = SESSION_ID) {
  fetchSessionInvite.mockResolvedValue(result);
  render(await JoinSessionPage({ params: Promise.resolve({ sessionId }) }));
}

function storeHref(label: string): string {
  return screen.getByText(label).closest('a')?.getAttribute('href') ?? '';
}

function playReferrer(): URLSearchParams {
  return new URLSearchParams(new URL(storeHref('Get it on Google Play')).searchParams.get('referrer') ?? '');
}

beforeEach(() => {
  fetchSessionInvite.mockReset();
  trackBeforeNavigation.mockClear();
  __resetReportedLandingsForTests();
  __resetSessionInboundCampaignForTests();
  window.history.replaceState(null, '', `/join/${SESSION_ID}`);
});

describe('session invite page', () => {
  it('shows the host, board, gym and both store buttons for a live session', async () => {
    await renderPage(invite());

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Alex wants you on the wall');
    expect(screen.getByText('The session is live. Get the app to join it.')).toBeTruthy();
    expect(screen.getByText('Alex')).toBeTruthy();
    expect(screen.getByText('Hangar Kilter at 40°')).toBeTruthy();
    expect(screen.getByText('The Climbing Hangar')).toBeTruthy();
    expect(storeHref('Get it on Google Play')).toContain('play.google.com');
    expect(storeHref('Download on the App Store')).toContain('apps.apple.com');
  });

  it('carries the session id to Google Play in the referrer utm_content', async () => {
    await renderPage(invite());

    expect(playReferrer().get('utm_content')).toBe(`join-page.${SESSION_ID}`);
    expect(playReferrer().get('utm_campaign')).toBe('session-invite');
  });

  it('says a dormant session is still open instead of calling it missing', async () => {
    await renderPage(invite({ state: 'dormant' }));

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Alex wants you on the wall');
    expect(
      screen.getByText("The session is still open. Nobody's connected right now, and you can still join."),
    ).toBeTruthy();
    expect(screen.queryByText("We can't find this session")).toBeNull();
    expect(playReferrer().get('utm_content')).toBe(`join-page.${SESSION_ID}`);
  });

  it('leaves out the rows it has nothing for (no host name, no gym, no angle)', async () => {
    await renderPage(invite({ hostName: null, gymName: null, boardAngle: null }));

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("You're invited to climb");
    expect(screen.getByText('Hangar Kilter')).toBeTruthy();
    expect(screen.queryByText('Started by')).toBeNull();
    expect(screen.queryByText('Gym')).toBeNull();
  });

  it('drops the details section entirely when the session has no host, board or gym to show', async () => {
    await renderPage(invite(withoutDetails));

    expect(screen.queryByText('The session')).toBeNull();
    expect(storeHref('Get it on Google Play')).toContain('play.google.com');
  });

  it('says an ended session has ended, and still offers the app', async () => {
    await renderPage({ state: 'ended', ...withoutDetails });

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('This session has ended');
    expect(screen.getByText('Start your own session')).toBeTruthy();
    expect(screen.queryByText('Join from your phone')).toBeNull();
    expect(storeHref('Get it on Google Play')).toContain('play.google.com');
    expect(storeHref('Download on the App Store')).toContain('apps.apple.com');
  });

  it('says a missing session cannot be found, and keeps its id out of install data', async () => {
    await renderPage({ state: 'not_found', ...withoutDetails }, 'no-such-session');

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("We can't find this session");
    expect(playReferrer().get('utm_content')).toBe('join-page');
    expect(storeHref('Get it on Google Play')).not.toContain('no-such-session');
  });

  it('keeps the invite standing when the lookup failed, without calling the session missing', async () => {
    await renderPage({ state: 'unavailable', ...withoutDetails });

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("You're invited to climb");
    expect(
      screen.getByText("We couldn't load the session details just now. The invite still works in the app."),
    ).toBeTruthy();
    expect(screen.queryByText("We can't find this session")).toBeNull();
    expect(playReferrer().get('utm_content')).toBe(`join-page.${SESSION_ID}`);
  });

  it.each(['live', 'dormant', 'ended', 'not_found', 'unavailable'] as const)(
    'reports the landing for a %s invite',
    async (state) => {
      await renderPage(invite({ state }));

      expect(trackBeforeNavigation).toHaveBeenCalledWith(
        'Session Invite Page Viewed',
        expect.objectContaining({ sessionId: SESSION_ID, state }),
      );
    },
  );

  it('decodes the session id from the route before looking it up', async () => {
    await renderPage(invite(), encodeURIComponent(SESSION_ID));

    expect(fetchSessionInvite).toHaveBeenCalledWith(SESSION_ID);
  });

  it('links on to the home page with a real anchor', async () => {
    await renderPage(invite());

    expect(screen.getByText('See what Boardsesh does').closest('a')?.getAttribute('href')).toBe('/');
  });
});
