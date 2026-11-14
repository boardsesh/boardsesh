import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
const sendEmail = vi.hoisted(() => vi.fn());
vi.mock('../transport', async (original) => ({ ...(await original<typeof import('../transport')>()), sendEmail }));
import { sendFirstPasswordConfirmationEmail } from '../first-password-email';

beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue(undefined);
});
describe('account-bound first-password email', () => {
  it('keeps the confirmation in a fragment with no email, UID or HTTP query', async () => {
    await sendFirstPasswordConfirmationEmail(
      'existing-owner@example.test',
      'A'.repeat(43),
      'b'.repeat(64),
      'https://www.boardsesh.test',
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const message = sendEmail.mock.calls[0]![0] as { to: string; html: string; text: string };
    expect(message.to).toBe('existing-owner@example.test');
    const link = new URL(message.text.match(/https:\/\/\S+/)![0]);
    expect(link.pathname).toBe('/auth/confirm-first-password');
    expect(link.search).toBe('');
    expect(new URLSearchParams(link.hash.slice(1)).get('token')).toBe('A'.repeat(43));
    expect(new URLSearchParams(link.hash.slice(1)).get('operation')).toBe('b'.repeat(64));
    expect(message.html).not.toContain('existing-owner@example.test');
    expect(message.html).toContain('&amp;operation=');
  });
  it.each([
    'http://www.boardsesh.test',
    'https://www.boardsesh.test/foreign',
    'https://www.boardsesh.test?redirect=foreign',
    'https://user:password@www.boardsesh.test',
  ])('refuses noncanonical origin %s before delivery', async (origin) => {
    await expect(
      sendFirstPasswordConfirmationEmail('existing-owner@example.test', 'A'.repeat(43), 'b'.repeat(64), origin),
    ).rejects.toThrow();
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it('refuses token injection and retired recipient before delivery', async () => {
    await expect(
      sendFirstPasswordConfirmationEmail(
        'existing-owner@example.test',
        'bad&token',
        'b'.repeat(64),
        'https://www.boardsesh.test',
      ),
    ).rejects.toThrow();
    await expect(
      sendFirstPasswordConfirmationEmail(
        'retired@retired.boardsesh.invalid',
        'A'.repeat(43),
        'b'.repeat(64),
        'https://www.boardsesh.test',
      ),
    ).rejects.toThrow();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
