import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PARTNER_CONSENT_ERRORS } from '@boardsesh/auth-protocol/partner-oauth';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { PartnerConsentView } from '@/app/lib/partner-oauth/page-views';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(
    function MockLocaleLink(props, ref) {
      return <a ref={ref} {...props} />;
    },
  ),
}));

const { default: PartnerConsentContent } = await import('../partner-consent-content');

const SIGNED_QUERY = 'client_id=bsk_sequence&state=app-state&sig=signed';
const CONSENT_VIEW: PartnerConsentView = {
  kind: 'consent',
  signedQuery: SIGNED_QUERY,
  account: 'climber@example.com',
  signInPath: `/oauth/sign-in?${SIGNED_QUERY}`,
  signOutPath: `/auth/signout?callbackUrl=${encodeURIComponent(`/oauth/sign-in?${SIGNED_QUERY}`)}`,
};

function details(overrides: Record<string, unknown> = {}) {
  return {
    client: {
      clientId: 'bsk_sequence',
      name: 'Sequence',
      homepageUrl: 'https://sequence.example',
      privacyPolicyUrl: 'https://sequence.example/privacy',
      termsUrl: 'javascript:alert(1)',
      redirectHost: 'com.example.app',
    },
    scopes: [
      { scope: 'profile:read', includesOnlyMeTicks: false },
      { scope: 'offline_access', includesOnlyMeTicks: false },
    ],
    reconnect: false,
    reviewed: false,
    expiresAt: '2026-11-10T12:10:00.000Z',
    ...overrides,
  };
}

/** The JSON a request posted. Every consent call sends a string body. */
function postedJson(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
const assign = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  fetchMock.mockReset();
  assign.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window, 'location', {
    value: { href: originalLocation.href, origin: originalLocation.origin, assign },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
});

async function renderReady(detailsBody = details()) {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, detailsBody));
  render(<PartnerConsentContent view={CONSENT_VIEW} />);
  return screen.findByRole('heading', { level: 1 });
}

describe('PartnerConsentContent', () => {
  it('shows what the app gets, in plain words, and who is signed in', async () => {
    const heading = await renderReady();
    expect(heading.textContent).toBe('Connect Sequence to your Boardsesh account?');
    expect(screen.getByText('Signed in as climber@example.com.')).toBeTruthy();
    const scopes = within(screen.getByRole('region', { name: 'Sequence will be able to' }));
    expect(scopes.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'See your display name and profile photo',
      'Keep this access until you disconnect it',
    ]);
    expect(screen.getByText("It can't change anything in your account, and it never sees your password.")).toBeTruthy();
    expect(screen.getByText("Boardsesh hasn't reviewed this app. Only connect apps you trust.")).toBeTruthy();
    expect(screen.getByText('After you choose, you go back to com.example.app.')).toBeTruthy();
    expect(screen.getByText(/Settings › Connected apps/)).toBeTruthy();
  });

  it('says who makes the app when the developer registered a publisher', async () => {
    const heading = await renderReady(
      details({ client: { ...details().client, publisherName: 'Sequence Climbing Ltd' } }),
    );
    expect(heading.textContent).toBe('Connect Sequence to your Boardsesh account?');
    expect(screen.getByText('Made by Sequence Climbing Ltd')).toBeTruthy();
  });

  it('shows no "Made by" line, and nothing in its place, for an app without a publisher', async () => {
    // Null from the backend, a blank one, and a backend too old to send the field.
    for (const publisherName of [null, '   ', undefined]) {
      fetchMock.mockReset();
      const body = details({ client: { ...details().client, publisherName } });
      fetchMock.mockResolvedValueOnce(jsonResponse(200, body));
      const view = render(<PartnerConsentContent view={CONSENT_VIEW} />);
      await view.findByRole('heading', { level: 1 });
      expect(view.queryByText(/^Made by/)).toBeNull();
      view.unmount();
    }
  });

  it('links only ordinary web pages, each marked as opening a new tab', async () => {
    await renderReady();
    const links = within(screen.getByRole('navigation', { name: 'About Sequence' })).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://sequence.example/',
      'https://sequence.example/privacy',
    ]);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.textContent).toContain('(opens in a new tab)');
    }
  });

  it('says that logbook:read includes ticks kept to "Only me" (decision 21)', async () => {
    await renderReady(details({ scopes: [{ scope: 'logbook:read', includesOnlyMeTicks: true }] }));
    const item = within(screen.getByRole('region', { name: 'Sequence will be able to' })).getByRole('listitem');
    expect(item.textContent).toContain('See every tick in your logbook, on every board');
    expect(item.textContent).toContain('Including ticks you keep to “Only me”');
  });

  it('says that logbook:read includes unlisted climbs and drafts set by others (#7387), and only there', async () => {
    await renderReady(
      details({
        scopes: [
          { scope: 'logbook:read', includesOnlyMeTicks: true },
          { scope: 'profile:read', includesOnlyMeTicks: false },
        ],
      }),
    );
    const [logbook, profile] = within(screen.getByRole('region', { name: 'Sequence will be able to' })).getAllByRole(
      'listitem',
    );
    const unlisted = "Including other setters' unlisted climbs and drafts you've logged";
    const spraywall = "Climbs on someone else's Private or Link only Spraywall arrive without their names";
    expect(logbook.textContent).toContain(unlisted);
    expect(logbook.textContent).toContain(spraywall);
    expect(profile.textContent).not.toContain(unlisted);
    expect(profile.textContent).not.toContain(spraywall);
  });

  it('names a reconnect in the title and explains it', async () => {
    const heading = await renderReady(details({ reconnect: true }));
    expect(heading.textContent).toBe('Connect Sequence again?');
    expect(screen.getByText('You disconnected Sequence before. Choosing Allow connects it again.')).toBeTruthy();
  });

  it('drops the "can\'t change anything" line when a scope it does not know is asked for', async () => {
    await renderReady(details({ scopes: [{ scope: 'workouts:write', includesOnlyMeTicks: false }] }));
    expect(screen.getByText('Other access: workouts:write')).toBeTruthy();
    expect(screen.queryByText(/can't change anything/)).toBeNull();
  });

  it('sends Allow with the signed query and goes to the app with its code', async () => {
    await renderReady();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { redirect: true, url: 'com.example.app:/cb?code=abc&state=s' }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));

    const connected = await screen.findByRole('heading', { name: 'Sequence is connected' });
    expect(document.activeElement).toBe(connected);
    expect(assign).toHaveBeenCalledWith('com.example.app:/cb?code=abc&state=s');
    const [, init] = fetchMock.mock.calls[1];
    expect(postedJson(init)).toEqual({ accept: true, oauth_query: SIGNED_QUERY });
    expect(screen.getByRole('link', { name: 'Back to Sequence' }).getAttribute('href')).toBe(
      'com.example.app:/cb?code=abc&state=s',
    );
  });

  it("sends Don't allow, and the app hears access_denied", async () => {
    await renderReady();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { redirect: true, url: 'https://sequence.example/cb?error=access_denied&state=s' }),
    );
    fireEvent.click(screen.getByRole('button', { name: "Don't allow" }));
    expect(await screen.findByRole('heading', { name: "Sequence isn't connected" })).toBeTruthy();
    expect(postedJson(fetchMock.mock.calls[1][1]).accept).toBe(false);
    expect(assign).toHaveBeenCalledWith('https://sequence.example/cb?error=access_denied&state=s');
  });

  it('explains an app at its connection cap before sending the climber back', async () => {
    await renderReady();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { redirect: true, url: 'https://sequence.example/cb?error=temporarily_unavailable' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(await screen.findByRole('heading', { name: "Sequence can't take new connections right now" })).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back to Sequence' }).getAttribute('href')).toBe(
      'https://sequence.example/cb?error=temporarily_unavailable',
    );
  });

  it('keeps both buttons disabled while the answer is on its way', async () => {
    await renderReady();
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect((screen.getByRole('button', { name: "Don't allow" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Sending your answer');
  });

  it.each([
    [401, { error: PARTNER_CONSENT_ERRORS.loginRequired }, 'Sign in again to continue'],
    [400, { error: PARTNER_CONSENT_ERRORS.linkSpent, error_description: 'any text' }, 'This link has expired'],
    [403, { error: PARTNER_CONSENT_ERRORS.appSuspended, error_description: 'any text' }, "This app can't connect"],
    [404, {}, "Connecting apps isn't available right now"],
  ])('explains a %i %j refusal of the details', async (status, body, title) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(status, body));
    render(<PartnerConsentContent view={CONSENT_VIEW} />);
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('offers sign-in again for the same request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: PARTNER_CONSENT_ERRORS.loginRequired }));
    render(<PartnerConsentContent view={CONSENT_VIEW} />);
    const signIn = await screen.findByRole('link', { name: 'Sign in' });
    expect(signIn.getAttribute('href')).toBe(CONSENT_VIEW.kind === 'consent' ? CONSENT_VIEW.signInPath : '');
  });

  it('lets the climber retry when Boardsesh is busy', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'temporarily_unavailable' }));
    render(<PartnerConsentContent view={CONSENT_VIEW} />);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, details()));
    fireEvent.click(retry);
    expect(await screen.findByRole('heading', { name: 'Connect Sequence to your Boardsesh account?' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ kind: 'expired' } as const, 'This link has expired'],
    [{ kind: 'invalid' } as const, "This link doesn't work"],
    [{ kind: 'unavailable' } as const, "Connecting apps isn't available right now"],
    [{ kind: 'sign-in-again', signInPath: '/oauth/sign-in?sig=x' } as const, 'Sign in again to continue'],
  ])('renders the server-decided %j state without asking the backend', (view, title) => {
    render(<PartnerConsentContent view={view} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
