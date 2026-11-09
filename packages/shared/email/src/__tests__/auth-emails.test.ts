import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail })) },
}));

import { sendPasswordResetEmail, sendVerificationEmail } from '../auth-emails';

type SentMail = { to: string; from: string; subject: string; html: string; text: string };

describe('sendPasswordResetEmail', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
    process.env.SMTP_USER = 'smtp-user@example.com';
    process.env.SMTP_PASSWORD = 'secret';
    process.env.EMAIL_FROM = 'noreply@boardsesh.com';
  });

  function lastMail(): SentMail {
    expect(sendMail).toHaveBeenCalledTimes(1);
    return sendMail.mock.calls[0][0] as SentMail;
  }

  it('builds the link against /auth/reset-password with the token and encoded email', async () => {
    await sendPasswordResetEmail('user@example.com', 'tok-123', 'https://boardsesh.com');

    const mail = lastMail();
    expect(mail.text).toContain('https://boardsesh.com/auth/reset-password?token=tok-123&email=user%40example.com');
    expect(mail.to).toBe('user@example.com');
    expect(mail.subject).toContain('Reset your Boardsesh password');
  });

  it('url-encodes the email address in the link', async () => {
    await sendPasswordResetEmail('user+tag@example.com', 'tok', 'https://boardsesh.com');

    expect(lastMail().text).toContain('email=user%2Btag%40example.com');
  });

  it('escapes the URL in the HTML body but leaves the plain-text link raw', async () => {
    // A single quote survives encodeURIComponent but must be HTML-escaped to &#39;
    // in the markup — proves the URL is both URL-safe and HTML-safe.
    await sendPasswordResetEmail('user@example.com', "a'b", 'https://boardsesh.com');

    const mail = lastMail();
    expect(mail.html).toContain('token=a&#39;b');
    expect(mail.html).not.toContain("token=a'b");
    expect(mail.text).toContain("token=a'b");
  });

  it('rejects an invalid email before sending', async () => {
    await expect(sendPasswordResetEmail('not-an-email', 'tok', 'https://boardsesh.com')).rejects.toThrow();
    expect(sendMail).not.toHaveBeenCalled();
  });
  it.each([`pr1_${'A'.repeat(43)}`, 'a363934b-b7ba-41ba-a279-52185daa100e'])(
    'round-trips %s and the committed email hint through real plain and HTML templates',
    async (token) => {
      const email = 'MixedCase+tag@example.test';
      await sendPasswordResetEmail(email, token, 'https://www.boardsesh.test');
      const mail = lastMail();
      const text = mail.text.match(/https:\/\/www\.boardsesh\.test\/auth\/reset-password\?\S+/);
      const html = mail.html.match(/href="([^"]+)"/);
      expect(text).not.toBeNull();
      expect(html).not.toBeNull();
      for (const encoded of [text![0], html![1].replaceAll('&amp;', '&').replaceAll('&#39;', "'")]) {
        const url = new URL(encoded);
        expect(url.origin + url.pathname).toBe('https://www.boardsesh.test/auth/reset-password');
        expect([...url.searchParams.keys()]).toEqual(['token', 'email']);
        expect(url.searchParams.get('token')).toBe(token);
        expect(url.searchParams.get('email')).toBe(email);
        expect(url.hash).toBe('');
      }
      expect(mail.to).toBe(email);
      expect(mail.text).toContain('expires in 1 hour');
      expect(mail.html).toContain('expires in 1 hour');
    },
  );
});

describe('sendVerificationEmail token round trips', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
    process.env.SMTP_USER = 'smtp-user@example.com';
    process.env.SMTP_PASSWORD = 'secret';
    process.env.EMAIL_FROM = 'noreply@boardsesh.com';
  });

  it.each([`ev1_${'A'.repeat(43)}`, 'a363934b-b7ba-41ba-a279-52185daa100e', "a'b&other=forged#fragment"])(
    'preserves the exact token and committed mixed-case address in real text and HTML',
    async (token) => {
      const email = 'MixedCase+tag@example.com';
      await sendVerificationEmail(email, token, 'https://www.boardsesh.test');
      expect(sendMail).toHaveBeenCalledOnce();
      const mail = sendMail.mock.calls[0][0] as SentMail;
      const textMatch = mail.text.match(/https:\/\/www\.boardsesh\.test\/api\/auth\/verify-email\?\S+/);
      const htmlMatch = mail.html.match(/href="([^"]+)"/);
      expect(textMatch).not.toBeNull();
      expect(htmlMatch).not.toBeNull();
      for (const encoded of [textMatch![0], htmlMatch![1].replaceAll('&amp;', '&').replaceAll('&#39;', "'")]) {
        const link = new URL(encoded);
        expect(link.origin + link.pathname).toBe('https://www.boardsesh.test/api/auth/verify-email');
        expect([...link.searchParams.keys()]).toEqual(['token', 'email']);
        expect(link.searchParams.get('token')).toBe(token);
        expect(link.searchParams.get('email')).toBe(email);
        expect(link.hash).toBe('');
      }
      expect(mail.to).toBe(email);
      expect(mail.subject).toBe('Verify your Boardsesh email');
      expect(mail.text).toContain('expires in 24 hours');
      expect(mail.html).toContain('expires in 24 hours');
      if (!token.startsWith('ev1_') && !token.includes('&')) {
        expect(mail.text).toContain(`?token=${token}&email=MixedCase%2Btag%40example.com`);
      }
    },
  );
});
