import { webcrypto, createHash } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { providerSettingsViewFrame, PROVIDER_SETTINGS_VIEW_HEADER } from '@/app/lib/auth/provider-security-view';
type Authority = ReturnType<typeof createBrowserBackendClient>;
const state = vi.hoisted(() => ({ authority: null as Authority | null, ready: true }));
vi.mock('@/app/lib/auth/browser-backend-client', () => ({
  browserBackendClient: {
    getSnapshot: () => state.authority!.getSnapshot(),
    isSessionCurrent: (session: unknown) => state.authority!.isSessionCurrent(session),
    subscribe: (listener: () => void) => state.authority!.subscribe(listener),
    retire: () => state.authority!.retire(),
  },
}));
vi.mock('@/app/lib/auth/provider-security-readiness', () => ({ publicProviderSecurityReady: () => state.ready }));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
import ProviderSettingsController from '../provider-settings-controller';
const send = vi.fn<typeof fetch>();
function session(userId = 'climber-a') {
  const scope = {
    userId,
    authSessionId: `sid-${userId}`,
    generation: 3,
    cursor: { bindingId: 'a'.repeat(64), version: 2 },
  };
  return {
    user: { id: userId },
    authSessionId: scope.authSessionId,
    authGeneration: 3,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: scope,
  };
}
function methods(provider: 'google' | 'apple' = 'google', passwordUsable = true) {
  return {
    outcome: 'available',
    actorContextKey: 'a'.repeat(64),
    methods: [{ methodId: 'c'.repeat(64), provider, usable: true, canUnlink: true }],
    configuredProviders: ['google', 'apple'],
    passwordUsable,
    googleReauthenticationAvailable: passwordUsable,
  };
}
beforeEach(() => {
  window.history.replaceState({}, '', '/settings');
  state.ready = true;
  state.authority = createBrowserBackendClient({
    ready: () => true,
    fetch: async () => {
      throw new Error('Unexpected lease fetch');
    },
    endpoint: '/unused',
    now: () => 1,
    schedule: () => () => {},
  });
  send.mockReset().mockImplementation(async () => Response.json(methods()));
  vi.stubGlobal('fetch', send);
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  state.authority!.dispose();
  vi.unstubAllGlobals();
});

describe('mounted provider Settings controller', () => {
  it('loads methods from an actual accepted Session and mounts the controlled card', async () => {
    const current = session();
    state.authority!.acceptSession(current);
    render(<ProviderSettingsController session={current} />);
    await screen.findByRole('button', { name: 'Unlink Google' });
    expect(screen.getByRole('button', { name: 'Link Apple' })).toBeTruthy();
    expect(new Headers(send.mock.calls[0]![1]!.headers).get(PROVIDER_SETTINGS_VIEW_HEADER)).toBe(
      createHash('sha256').update(providerSettingsViewFrame(current.browserSelection)).digest('hex'),
    );
    expect(screen.queryByRole('button', { name: /facebook/i })).toBeNull();
  });
  it('keeps late A methods out of B after an actual accepted-view switch', async () => {
    const current = session();
    state.authority!.acceptSession(current);
    let finish: ((response: Response) => void) | undefined;
    send
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockImplementation(async () => Response.json(methods('apple')));
    const view = render(<ProviderSettingsController session={current} />);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const later = session('climber-b');
    act(() => {
      state.authority!.acceptSession(later);
      view.rerender(<ProviderSettingsController session={later} />);
    });
    await screen.findByRole('button', { name: 'Unlink Apple' });
    await act(async () => {
      finish!(Response.json(methods()));
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: 'Unlink Google' })).toBeNull();
    expect(state.authority!.isSessionCurrent(later)).toBe(true);
  });
  it('offers no unusable reset or setup link for an Apple-only passwordless account', async () => {
    const current = session();
    state.authority!.acceptSession(current);
    send.mockImplementation(async (input) => {
      if (typeof input !== 'string') throw new Error('Expected relative route');
      if (input.endsWith('/intent'))
        return Response.json({ outcome: 'reauthentication_required', operationKey: 'b'.repeat(64) });
      return Response.json(methods('apple', false));
    });
    render(<ProviderSettingsController session={current} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Link Google' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await screen.findByText('Recent verification is unavailable for this account.');
    expect(screen.queryByRole('link', { name: 'Account recovery' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open password options' })).toBeNull();
  });
  it('restores a sealed operation for explicit confirmation without a new intent', async () => {
    const current = session();
    state.authority!.acceptSession(current);
    const operationKey = 'b'.repeat(64);
    window.history.replaceState({}, '', `/settings?providerSecurityResume=${operationKey}`);
    send.mockImplementation(async (input) => {
      if (typeof input !== 'string') throw new Error('Expected relative route');
      if (input.endsWith('/acknowledge')) return Response.json({ outcome: 'identity_changed' }, { status: 409 });
      if (input.endsWith('/resume'))
        return Response.json({
          providerSecurityResumeVersion: 1,
          outcome: 'resumable',
          operationKey,
          actorContextKey: 'a'.repeat(64),
          action: 'unlink',
          provider: 'google',
          methodId: 'c'.repeat(64),
          reauthenticationReady: true,
        });
      return Response.json(methods());
    });
    render(<ProviderSettingsController session={current} />);
    await screen.findByRole('dialog');
    expect(send.mock.calls.map(([input]) => input)).toEqual([
      '/api/internal/auth/provider-security/methods',
      '/api/internal/auth/provider-security/acknowledge',
      '/api/internal/auth/provider-security/resume',
    ]);
    expect(screen.getByRole('button', { name: 'Confirm change' })).toBeTruthy();
  });
  it('default dark readiness causes no card or network request', () => {
    state.ready = false;
    const current = session();
    state.authority!.acceptSession(current);
    render(<ProviderSettingsController session={current} />);
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByText('Sign-in methods')).toBeNull();
  });
});
