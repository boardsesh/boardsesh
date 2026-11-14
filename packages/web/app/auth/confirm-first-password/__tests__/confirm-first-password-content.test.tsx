import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({ t: (key: string) => tFromCatalog(namespace, key) }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/app/lib/auth/first-password-readiness', () => ({ publicFirstPasswordReady: () => true }));
import ConfirmFirstPasswordContent from '../confirm-first-password-content';

const operationKey = 'a'.repeat(64);
const confirmationToken = 'B'.repeat(43);
const send = vi.fn<typeof fetch>();
beforeEach(() => {
  window.history.replaceState(
    {},
    '',
    `/auth/confirm-first-password#token=${confirmationToken}&operation=${operationKey}`,
  );
  send
    .mockReset()
    .mockImplementation(async () => Response.json({ outcome: 'pending', expiresAt: '2099-01-01T00:00:00.000Z' }));
  vi.stubGlobal('fetch', send);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
async function form() {
  const rendered = render(<ConfirmFirstPasswordContent />);
  await screen.findByLabelText('Password');
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: ' exact password ' } });
  fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: ' exact password ' } });
  return rendered;
}
describe('first-password confirmation page', () => {
  it('removes the secret fragment before reading state, including StrictMode replay', async () => {
    render(
      <StrictMode>
        <ConfirmFirstPasswordContent />
      </StrictMode>,
    );
    await screen.findByLabelText('Password');
    expect(window.location.hash).toBe('');
    for (const [, options] of send.mock.calls) expect(options?.body).toBe(JSON.stringify({ operationKey }));
  });
  it('submits only after choosing matching passwords and shows known commit success', async () => {
    const rendered = await form();
    send.mockResolvedValueOnce(Response.json({ outcome: 'completed', operationKey }));
    fireEvent.submit(rendered.container.querySelector('form')!);
    await screen.findByText('Your password is ready. You can use it next time you sign in.');
    expect(JSON.parse(send.mock.calls.at(-1)![1]!.body as string)).toEqual({
      operationKey,
      confirmationToken,
      password: ' exact password ',
      confirmPassword: ' exact password ',
    });
    expect(screen.queryByLabelText('Password')).toBeNull();
  });
  it('does not retry a submission or call password reset after an uncertain reply', async () => {
    const rendered = await form();
    send.mockRejectedValueOnce(new Error('Owned uncertain finalization'));
    fireEvent.submit(rendered.container.querySelector('form')!);
    await screen.findByText('We could not confirm password setup. Check Settings before trying again.');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([url]) => url)).toEqual([
      '/api/internal/auth/first-password/read',
      '/api/internal/auth/first-password/submit',
    ]);
  });
  it('refuses changed account state without exposing a password form', async () => {
    send.mockResolvedValueOnce(Response.json({ outcome: 'identity_changed' }, { status: 409 }));
    render(<ConfirmFirstPasswordContent />);
    await screen.findByText('Your account changed. Open Settings for the account that requested this email.');
    expect(screen.queryByLabelText('Password')).toBeNull();
  });
  it('rejects duplicate fragment parameters before network activity', async () => {
    window.location.hash += `&token=${confirmationToken}`;
    render(<ConfirmFirstPasswordContent />);
    await screen.findByText('This link has expired or cannot be used. Request another from Settings.');
    expect(send).not.toHaveBeenCalled();
  });
  it('retires a held result when the screen unmounts', async () => {
    let finish: ((response: Response) => void) | undefined;
    send.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const rendered = render(<ConfirmFirstPasswordContent />);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const signal = send.mock.calls[0]![1]!.signal;
    rendered.unmount();
    expect(signal?.aborted).toBe(true);
    finish!(Response.json({ outcome: 'pending', expiresAt: '2099-01-01T00:00:00.000Z' }));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
