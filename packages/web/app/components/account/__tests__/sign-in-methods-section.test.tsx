import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getSession: vi.fn(),
  refresh: vi.fn(),
  showMessage: vi.fn(),
  assign: vi.fn(),
  replaceState: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));
// The page already knows who it shows: the guard's first session read is done.
vi.mock('@/app/lib/auth/session-guard', () => ({
  guardedFetch: mocks.fetch,
  browserSessionGuard: () => ({ whenViewerKnown: async () => 'viewer' }),
}));
vi.mock('@/app/lib/auth/web-session-events', () => ({ bridgeLegacyBrowserSession: mocks.getSession }));
vi.mock('@/app/lib/auth/browser-access-token', () => ({ refreshAccessTokenAfterCredentialChange: mocks.refresh }));
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mocks.showMessage }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(
    function LocaleLinkStub(props, ref) {
      return <a ref={ref} {...props} />;
    },
  ),
}));

const { default: SignInMethodsSection } = await import('../sign-in-methods-section');

type MethodsBody = Record<string, unknown>;
const methods = (overrides: MethodsBody = {}): MethodsBody => ({
  status: 'methods',
  passwordUsable: true,
  providers: [{ methodId: 'a'.repeat(64), provider: 'google', usable: true, canUnlink: true }],
  configuredProviders: ['google', 'apple'],
  reauthentication: { password: true, google: true, apple: false },
  linking: { google: { available: true }, apple: { available: true } },
  ...overrides,
});

/** Answers each route path from a queue, or with its last answer. */
function routes(answers: Record<string, Array<[number, MethodsBody]>>) {
  mocks.fetch.mockImplementation(async (input: string) => {
    const path = new URL(input, 'https://www.boardsesh.com').pathname.replace('/api/auth/provider-security/', '');
    const queue = answers[path];
    if (!queue?.length) return new Response(null, { status: 404 });
    const [status, body] = queue.length > 1 ? queue.shift()! : queue[0];
    return Response.json(body, { status });
  });
}
const calledPaths = () =>
  mocks.fetch.mock.calls.map(([input]) => String(input).replace('/api/auth/provider-security/', ''));

function setAddress(search = '') {
  Object.defineProperty(window, 'location', {
    value: {
      href: `https://www.boardsesh.com/settings${search}`,
      pathname: '/settings',
      search,
      hash: '',
      assign: mocks.assign,
    },
    configurable: true,
  });
  Object.defineProperty(window, 'history', {
    value: { state: null, replaceState: mocks.replaceState },
    configurable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({});
  setAddress();
});

describe('SignInMethodsSection', () => {
  it('shows an error with a retry, and no buttons, when the methods read fails', async () => {
    routes({ methods: [[503, { status: 'unavailable' }]] });
    render(<SignInMethodsSection />);
    expect(await screen.findByText("We couldn't load your sign-in methods.")).toBeTruthy();
    expect(screen.queryByLabelText('Disconnect Google')).toBeNull();
  });

  it('lists the password and Google, and offers to connect Apple now that the server reports it linkable', async () => {
    routes({ methods: [[200, methods()]] });
    render(<SignInMethodsSection />);
    expect(await screen.findByText('Set')).toBeTruthy();
    expect((screen.getByLabelText('Disconnect Google') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Connect Apple')).toBeTruthy();
    expect(screen.queryByText('Not available yet')).toBeNull();
  });

  it('shows Apple as not available yet when the server says it cannot be linked now', async () => {
    routes({
      methods: [
        [
          200,
          methods({ linking: { google: { available: true }, apple: { available: false, reason: 'unavailable' } } }),
        ],
      ],
    });
    render(<SignInMethodsSection />);
    expect(await screen.findByText('Not available yet')).toBeTruthy();
    expect(screen.queryByText('Connect Apple')).toBeNull();
  });

  it('keeps the only sign-in method and says why', async () => {
    routes({
      methods: [
        [
          200,
          methods({
            passwordUsable: false,
            providers: [{ methodId: 'b'.repeat(64), provider: 'google', usable: true, canUnlink: false }],
            reauthentication: { password: false, google: true, apple: false },
          }),
        ],
      ],
    });
    render(<SignInMethodsSection />);
    expect(((await screen.findByLabelText('Disconnect Google')) as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText('This is your only way to sign in. Add another one before you disconnect it.'),
    ).toBeTruthy();
  });

  it('sends an Apple-only account to set a password first', async () => {
    routes({
      methods: [
        [
          200,
          methods({
            passwordUsable: false,
            providers: [{ methodId: 'c'.repeat(64), provider: 'apple', usable: true, canUnlink: false }],
            reauthentication: { password: false, google: false, apple: false },
          }),
        ],
      ],
    });
    render(<SignInMethodsSection />);
    const link = await screen.findByText('Set a password');
    expect(link.closest('a')?.getAttribute('href')).toBe('/settings/first-password');
    expect((screen.getByText('Connect Google') as HTMLButtonElement).disabled).toBe(true);
  });

  it('re-reads the session once for a legacy-only browser', async () => {
    routes({
      methods: [
        [403, { status: 'refused', outcome: 'canonical_session_required', code: 'canonical_session_required' }],
        [200, methods()],
      ],
    });
    render(<SignInMethodsSection />);
    expect(await screen.findByLabelText('Disconnect Google')).toBeTruthy();
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
  });

  it('disconnects after a password: a wrong one keeps the flow, then success refreshes the token', async () => {
    routes({
      methods: [
        [200, methods()],
        [200, methods({ providers: [] })],
      ],
      start: [[200, { status: 'reauthentication_required', action: 'unlink', provider: 'google' }]],
      'reauthenticate/password': [
        [403, { status: 'refused', outcome: 'reauthentication_required', code: 'invalid_proof' }],
        [200, { status: 'committed', action: 'unlink', provider: 'google', refreshAccessToken: true }],
      ],
    });
    render(<SignInMethodsSection />);
    fireEvent.click(await screen.findByLabelText('Disconnect Google'));
    const field = await screen.findByLabelText('Password');
    fireEvent.change(field, { target: { value: 'my password' } });
    fireEvent.click(screen.getByText('Confirm'));
    expect(await screen.findByText("That password didn't work. Try again.")).toBeTruthy();
    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.showMessage).toHaveBeenCalledWith(
      'Google is disconnected. Your other devices will ask you to sign in again.',
      'success',
    );
  });

  it('a rate-limited password (503, nothing to recover) keeps the flow open and says try again in a minute', async () => {
    routes({
      methods: [[200, methods()]],
      start: [[200, { status: 'reauthentication_required', action: 'unlink', provider: 'google' }]],
      'reauthenticate/password': [[503, { status: 'unavailable' }]],
      // What the route answers when the flow holds no proof yet.
      recover: [[400, { status: 'refused', outcome: 'denied', code: 'invalid_intent' }]],
    });
    render(<SignInMethodsSection />);
    fireEvent.click(await screen.findByLabelText('Disconnect Google'));
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'my password' } });
    fireEvent.click(screen.getByText('Confirm'));
    expect(await screen.findByText("That didn't go through. Try again in a minute.")).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(calledPaths().filter((path) => path === 'recover')).toHaveLength(1);
    expect(mocks.showMessage).not.toHaveBeenCalled();
  });

  it('offers a Google-only account the first-password link and keeps Google working', async () => {
    routes({
      methods: [
        [
          200,
          methods({
            passwordUsable: false,
            providers: [{ methodId: 'd'.repeat(64), provider: 'google', usable: true, canUnlink: false }],
            reauthentication: { password: false, google: true, apple: false },
          }),
        ],
      ],
    });
    render(<SignInMethodsSection />);
    const link = await screen.findByText('Set a password');
    expect(link.closest('a')?.getAttribute('href')).toBe('/settings/first-password');
    expect(screen.getByText(/You don't have a password yet/)).toBeTruthy();
  });

  it('gives too_many_pending a way out that cancels the open change', async () => {
    routes({
      methods: [[200, methods({ providers: [] })]],
      start: [[400, { status: 'refused', outcome: 'denied', code: 'too_many_pending' }]],
      abort: [[200, { status: 'aborted' }]],
    });
    render(<SignInMethodsSection />);
    fireEvent.click(await screen.findByText('Connect Google'));
    fireEvent.click(await screen.findByText('Cancel pending changes'));
    await waitFor(() => expect(calledPaths()).toContain('abort'));
    await waitFor(() => expect(screen.queryByText('Cancel pending changes')).toBeNull());
  });

  it('names each Disconnect button after its provider', async () => {
    routes({
      methods: [
        [
          200,
          methods({
            providers: [
              { methodId: 'e'.repeat(64), provider: 'google', usable: true, canUnlink: true },
              { methodId: 'f'.repeat(64), provider: 'apple', usable: true, canUnlink: true },
            ],
          }),
        ],
      ],
    });
    render(<SignInMethodsSection />);
    expect(await screen.findByLabelText('Disconnect Google')).toBeTruthy();
    expect(screen.getByLabelText('Disconnect Apple')).toBeTruthy();
  });

  it('reads the provider result on return, says it, and takes it out of the address', async () => {
    setAddress('?providerSecurity=linked&provider=google');
    routes({ methods: [[200, methods()]] });
    render(<SignInMethodsSection />);
    await waitFor(() => expect(mocks.replaceState).toHaveBeenCalledWith(null, '', '/settings'));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.showMessage).toHaveBeenCalledWith(
      'Google is connected. Your other devices will ask you to sign in again.',
      'success',
    );
  });
});
