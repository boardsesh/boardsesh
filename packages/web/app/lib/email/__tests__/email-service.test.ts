import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail })) },
}));

import { sendPasswordResetEmail } from '../email-service';

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
});
