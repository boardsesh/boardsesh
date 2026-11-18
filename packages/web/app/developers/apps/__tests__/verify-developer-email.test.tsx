import React, { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const mocks = vi.hoisted(() => ({ request: vi.fn(), signedIn: true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => tFromCatalog('developers', key) }) }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: mocks.signedIn ? { user: { id: 'developer' } } : null,
    status: mocks.signedIn ? 'authenticated' : 'unauthenticated',
  }),
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: mocks.signedIn ? 'session-token' : null }),
}));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request: mocks.request }) }));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: React.forwardRef<HTMLAnchorElement, React.ComponentProps<'a'>>(function Link(props, ref) {
    return <a {...props} ref={ref} />;
  }),
}));
const { default: VerifyDeveloperEmail } = await import('../verify-email/verify-developer-email');

beforeEach(() => {
  mocks.signedIn = true;
  mocks.request.mockReset().mockResolvedValue({ confirmPartnerDeveloperEmail: true });
  window.history.replaceState({}, '', '/developers/apps/verify-email#token=proof-from-email');
});

describe('developer email explicit confirmation', () => {
  it('removes the fragment, never confirms on load, and survives StrictMode effects', async () => {
    render(
      <StrictMode>
        <VerifyDeveloperEmail />
      </StrictMode>,
    );
    expect(window.location.hash).toBe('');
    expect(mocks.request).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Confirm developer email' });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith(expect.anything(), { token: 'proof-from-email' }));
    expect(await screen.findByText('Your developer email is verified. You can register an app.')).toBeTruthy();
  });
  it('does not put the token in a sign-in URL or confirm while signed out', () => {
    mocks.signedIn = false;
    render(<VerifyDeveloperEmail />);
    expect((screen.getByRole('button', { name: 'Confirm developer email' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/auth/login');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('offers recovery when an expired, replayed or wrong-account link is refused', async () => {
    mocks.request.mockResolvedValue({ confirmPartnerDeveloperEmail: false });
    render(<VerifyDeveloperEmail />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm developer email' }));
    expect(await screen.findByText(/This link expired/)).toBeTruthy();
  });
});
