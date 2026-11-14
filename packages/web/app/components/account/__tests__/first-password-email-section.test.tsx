import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({ t: (key: string) => tFromCatalog(namespace, key) }),
}));
import FirstPasswordEmailSection from '../first-password-email-section';

const owner = { userId: 'owned-user', authSessionId: 'original-sid' };
const send = vi.fn<typeof fetch>();
const context = () =>
  Response.json({
    outcome: 'available',
    actorContextKey: 'a'.repeat(64),
    userId: owner.userId,
    authSessionId: owner.authSessionId,
  });
const sent = () =>
  Response.json({ outcome: 'email_sent', operationKey: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' });
beforeEach(() => {
  send.mockReset();
  vi.stubGlobal('fetch', send);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('first-password Settings entry', () => {
  it('requests confirmation only for the account displayed by Settings', async () => {
    send.mockResolvedValueOnce(context()).mockResolvedValueOnce(sent());
    render(<FirstPasswordEmailSection expectedSession={owner} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation email' }));
    await screen.findByText('Check your email. Open the link in this browser within five minutes.');
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[1]![1]!.body as string)).toEqual({
      actorContextKey: 'a'.repeat(64),
      expectedUserId: owner.userId,
      expectedAuthSessionId: owner.authSessionId,
    });
    expect(send.mock.calls[1]![1]!.body).not.toContain('@');
  });
  it('refuses a central account change before requesting an email', async () => {
    send.mockResolvedValueOnce(
      Response.json({
        outcome: 'available',
        actorContextKey: 'b'.repeat(64),
        userId: 'different-user',
        authSessionId: 'different-sid',
      }),
    );
    const changed = vi.fn();
    render(<FirstPasswordEmailSection expectedSession={owner} onAccountChanged={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation email' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('retires a held old-account context before it can request mail for a new screen', async () => {
    let finish: ((response: Response) => void) | undefined;
    send.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const rendered = render(<FirstPasswordEmailSection expectedSession={owner} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation email' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const signal = send.mock.calls[0]![1]!.signal;
    rendered.rerender(
      <FirstPasswordEmailSection expectedSession={{ userId: 'different-user', authSessionId: 'different-sid' }} />,
    );
    expect(signal?.aborted).toBe(true);
    finish!(context());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send confirmation email' }).hasAttribute('disabled')).toBe(false),
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});
