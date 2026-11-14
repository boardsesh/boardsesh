import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import ProviderMethodsSection, {
  type ProviderMethodsSectionProps,
  type ProviderMethodResult,
} from '../provider-methods-section';
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
  }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>((props, ref) => (
    <a {...props} ref={ref} />
  )),
}));
afterEach(cleanup);
const completed = { outcome: 'completed' } as const;
const google = { methodId: 'google-method', provider: 'google', usable: true, canUnlink: true } as const;
const defaults = (): ProviderMethodsSectionProps => ({
  actorContextKey: 'owned-actor-A',
  methods: [google],
  configuredProviders: ['google', 'apple'],
  passwordUsable: true,
  googleReauthenticationAvailable: true,
  passwordSetupHref: '/settings#password',
  recoveryHref: '/auth/forgot-password',
  onAction: vi.fn(async () => completed),
  onReauthenticate: vi.fn(async () => completed),
});
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe('controlled provider methods card', () => {
  it('restores an actor-bound operation for explicit confirmation without acting on mount', async () => {
    const props = defaults();
    render(
      <ProviderMethodsSection
        {...props}
        resumeAction={{ action: 'unlink', provider: 'google', methodId: google.methodId }}
      />,
    );
    await screen.findByRole('dialog');
    expect(props.onAction).not.toHaveBeenCalled();
    confirm();
    await waitFor(() =>
      expect(props.onAction).toHaveBeenCalledExactlyOnceWith({
        action: 'unlink',
        provider: 'google',
        methodId: google.methodId,
      }),
    );
  });
  it('offers only configured Google/Apple methods and respects unlink capability', () => {
    const props = defaults();
    render(
      <ProviderMethodsSection
        {...props}
        methods={[
          { ...google, canUnlink: false },
          { ...google, methodId: 'ignored', provider: 'facebook' } as unknown as typeof google,
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Unlink Google' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Link Apple' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /facebook/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Link Google' })).toBeNull();
    expect(screen.getByText('Keep at least one usable way to sign in.')).toBeTruthy();
    expect(props.onAction).not.toHaveBeenCalled();
  });

  it('confirms all security effects and allows cancellation without an action', () => {
    const props = defaults();
    render(<ProviderMethodsSection {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link Apple' }));
    expect(screen.getByText('Link Apple to this account?')).toBeTruthy();
    expect(
      screen.getByText(
        "You'll stay signed in on this device. Other devices will sign out, partner apps will disconnect, and older recovery and verification links will stop working.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onAction).not.toHaveBeenCalled();
  });

  it('submits the exact method ID and leaves methods controlled by the parent', async () => {
    const props = defaults();
    render(<ProviderMethodsSection {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Google' }));
    confirm();
    await screen.findByText('Google is unlinked.');
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({
      action: 'unlink',
      provider: 'google',
      methodId: 'google-method',
    });
    expect(screen.getByRole('button', { name: 'Unlink Google' })).toBeTruthy();
  });

  it('allows one pending mutation and waits for an explicit redirect outcome', async () => {
    const pending = deferred<ProviderMethodResult>();
    const props = defaults();
    const action = vi.fn(() => pending.promise);
    render(<ProviderMethodsSection {...props} onAction={action} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link Apple' }));
    confirm();
    confirm();
    expect(action).toHaveBeenCalledOnce();
    pending.resolve({ outcome: 'redirecting' });
    await screen.findByText('Continue in your browser to finish.');
  });

  it('verifies an actual password once, clears it before awaiting and retries the confirmed action', async () => {
    const pending = deferred<ProviderMethodResult>();
    const props = defaults();
    const action = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'reauthentication_required' })
      .mockResolvedValueOnce(completed);
    const reauthenticate = vi.fn(() => pending.promise);
    render(<ProviderMethodsSection {...props} onAction={action} onReauthenticate={reauthenticate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Google' }));
    confirm();
    const input = await screen.findByLabelText('Current password');
    fireEvent.change(input, { target: { value: 'owned-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify password' }));
    expect(reauthenticate).toHaveBeenCalledExactlyOnceWith({ method: 'password', password: 'owned-password' });
    expect((input as HTMLInputElement).value).toBe('');
    pending.resolve(completed);
    await screen.findByText('Google is unlinked.');
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('clears a failed password attempt and never persists or echoes the password', async () => {
    const props = defaults();
    const reauthenticate = vi.fn(async () => {
      throw new Error('owned-password-must-not-echo');
    });
    render(
      <ProviderMethodsSection
        {...props}
        onAction={vi.fn(async () => ({ outcome: 'reauthentication_required' as const }))}
        onReauthenticate={reauthenticate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Link Apple' }));
    confirm();
    const input = await screen.findByLabelText('Current password');
    fireEvent.change(input, { target: { value: 'owned-password-must-not-echo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify password' }));
    await screen.findByText('Could not complete this change. Try again.');
    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('owned-password-must-not-echo')).toBeNull();
  });

  it('offers qualified Google reauthentication without offering Apple as a freshness method', async () => {
    const props = defaults();
    const action = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'reauthentication_required' })
      .mockResolvedValueOnce(completed);
    render(<ProviderMethodsSection {...props} passwordUsable={false} onAction={action} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Google' }));
    confirm();
    fireEvent.click(await screen.findByRole('button', { name: 'Verify with Google' }));
    await screen.findByText('Google is unlinked.');
    expect(props.onReauthenticate).toHaveBeenCalledExactlyOnceWith({ method: 'google' });
    expect(screen.queryByRole('button', { name: /verify.*apple/i })).toBeNull();
  });

  it('refuses Apple-only freshness without suggesting an unavailable first-password or recovery path', async () => {
    const props = defaults();
    render(
      <ProviderMethodsSection
        {...props}
        methods={[{ ...google, methodId: 'apple-method', provider: 'apple', canUnlink: false }]}
        passwordUsable={false}
        googleReauthenticationAvailable={false}
        passwordSetupHref={undefined}
        recoveryHref={undefined}
        onAction={vi.fn(async () => ({ outcome: 'reauthentication_unavailable' as const }))}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Link Google' }));
    confirm();
    await screen.findByText('Recent verification is unavailable for this account.');
    expect(screen.queryByRole('link', { name: 'Open password options' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Account recovery' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Verify with Google' })).toBeNull();
    expect(screen.queryByLabelText('Current password')).toBeNull();
    expect(props.onReauthenticate).not.toHaveBeenCalled();
  });

  it('shows only supplied usable routes and never treats opening them as fresh proof', async () => {
    const props = defaults();
    render(
      <ProviderMethodsSection
        {...props}
        passwordSetupHref={undefined}
        onAction={vi.fn(async () => ({ outcome: 'reauthentication_required' as const }))}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Link Apple' }));
    confirm();
    await screen.findByText('Opening password or recovery options does not confirm recent access.');
    expect(screen.queryByRole('link', { name: 'Open password options' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Account recovery' }).getAttribute('href')).toBe('/auth/forgot-password');
    expect(props.onReauthenticate).not.toHaveBeenCalled();
  });

  it.each([
    ['identity_changed', 'Your sign-in changed. Check the account before trying again.'],
    ['last_usable_method', 'Keep at least one usable way to sign in.'],
    ['ownership_conflict', 'That provider account is already linked elsewhere. Your account stays unchanged.'],
    ['unavailable', 'Could not complete this change. Try again.'],
  ] as const)('shows the controlled %s outcome without changing methods', async (outcome, message) => {
    const props = defaults();
    render(<ProviderMethodsSection {...props} onAction={vi.fn(async () => ({ outcome }))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link Apple' }));
    confirm();
    await screen.findByText(message);
    expect(screen.getByRole('button', { name: 'Unlink Google', hidden: true })).toBeTruthy();
  });

  it('suppresses stale completion after a different method basis replaces the card', async () => {
    const pending = deferred<ProviderMethodResult>();
    const props = defaults();
    const { rerender } = render(<ProviderMethodsSection {...props} onAction={() => pending.promise} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link Apple' }));
    confirm();
    rerender(<ProviderMethodsSection {...props} methods={[]} />);
    await act(async () => pending.resolve(completed));
    await waitFor(() => expect(screen.queryByText('Apple is linked.')).toBeNull());
  });

  it('keeps the actor-bound callbacks that owned confirmation when parent callbacks change', async () => {
    const props = defaults();
    const newer = vi.fn(async () => completed);
    const { rerender } = render(<ProviderMethodsSection {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link Apple' }));
    rerender(<ProviderMethodsSection {...props} onAction={newer} />);
    confirm();
    await screen.findByText('Apple is linked.');
    expect(props.onAction).toHaveBeenCalledOnce();
    expect(newer).not.toHaveBeenCalled();
  });
  it.each(['account-switch', 'same-user-new-sid', 'same-sid-new-generation'])(
    'suppresses old completion for %s even when method facts are identical',
    async (change) => {
      const pending = deferred<ProviderMethodResult>();
      const props = { ...defaults(), methods: [] };
      const first = vi.fn(() => pending.promise);
      const next = vi.fn(async () => completed);
      const { rerender } = render(<ProviderMethodsSection {...props} onAction={first} />);
      fireEvent.click(screen.getByRole('button', { name: 'Link Google' }));
      confirm();
      rerender(<ProviderMethodsSection {...props} actorContextKey={change} onAction={next} />);
      await act(async () => pending.resolve(completed));
      expect(screen.queryByText('Google is linked.')).toBeNull();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'Link Google' }));
      confirm();
      await screen.findByText('Google is linked.');
      expect(first).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledOnce();
    },
  );

  it('clears typed password and never retries an old action when the actor changes during verification', async () => {
    const pending = deferred<ProviderMethodResult>();
    const props = defaults();
    const action = vi.fn(async () => ({ outcome: 'reauthentication_required' as const }));
    const { rerender } = render(
      <ProviderMethodsSection {...props} onAction={action} onReauthenticate={() => pending.promise} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Link Apple' }));
    confirm();
    const input = await screen.findByLabelText('Current password');
    fireEvent.change(input, { target: { value: 'owned-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify password' }));
    rerender(<ProviderMethodsSection {...props} actorContextKey="new-actor" />);
    await act(async () => pending.resolve(completed));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Apple is linked.')).toBeNull();
    expect(action).toHaveBeenCalledOnce();
  });
});
