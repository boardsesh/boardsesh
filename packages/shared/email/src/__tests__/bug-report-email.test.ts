import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail })) },
}));

import { buildBugReportIssueEmail, sendBugReportIssueEmail } from '../bug-report-email';

const ISSUE_URL = 'https://github.com/boardsesh/boardsesh/issues/4021';

describe('buildBugReportIssueEmail', () => {
  it('sets a bug-report subject and links the issue in both html and text', () => {
    const email = buildBugReportIssueEmail({ issueUrl: ISSUE_URL, issueNumber: 4021 });
    expect(email.subject).toBe("We're on it — your Boardsesh bug report");
    expect(email.html).toContain(ISSUE_URL);
    expect(email.text).toContain(ISSUE_URL);
    expect(email.html).toContain('#4021');
    expect(email.text).toContain('#4021');
  });

  it('html-escapes the issue url', () => {
    const email = buildBugReportIssueEmail({
      issueUrl: 'https://example.com/i?a=1&b=2',
      issueNumber: 1,
    });
    expect(email.html).toContain('a=1&amp;b=2');
    expect(email.html).not.toContain('a=1&b=2');
    // Plain text keeps the raw url.
    expect(email.text).toContain('a=1&b=2');
  });
});

describe('sendBugReportIssueEmail', () => {
  const original = {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
    from: process.env.EMAIL_FROM,
  };

  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (original.user === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = original.user;
    if (original.pass === undefined) delete process.env.SMTP_PASSWORD;
    else process.env.SMTP_PASSWORD = original.pass;
    if (original.from === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = original.from;
  });

  it('no-ops (does not send) when SMTP credentials are unset', async () => {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    await sendBugReportIssueEmail({ to: 'climber@example.com', issueUrl: ISSUE_URL, issueNumber: 1 });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends to the reporter when SMTP is configured', async () => {
    process.env.SMTP_USER = 'smtp-user@example.com';
    process.env.SMTP_PASSWORD = 'secret';
    process.env.EMAIL_FROM = 'noreply@boardsesh.com';

    await sendBugReportIssueEmail({ to: 'climber@example.com', issueUrl: ISSUE_URL, issueNumber: 7 });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0] as { to: string; subject: string; text: string };
    expect(mail.to).toBe('climber@example.com');
    expect(mail.text).toContain(ISSUE_URL);
  });

  it.each([
    'reporter@privaterelay.appleid.com',
    'another@PRIVATERELAY.APPLEID.COM',
    'climber@icloud.com',
    'climber@privaterelay.appleid.com.example.com',
  ])('sends to recipient %s', async (to) => {
    process.env.SMTP_USER = 'smtp-user@example.com';
    process.env.SMTP_PASSWORD = 'secret';

    await sendBugReportIssueEmail({ to, issueUrl: ISSUE_URL, issueNumber: 7 });

    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to }));
  });

  it('never throws when the transport rejects', async () => {
    process.env.SMTP_USER = 'smtp-user@example.com';
    process.env.SMTP_PASSWORD = 'secret';
    sendMail.mockRejectedValueOnce(new Error('smtp down'));

    await expect(
      sendBugReportIssueEmail({ to: 'climber@example.com', issueUrl: ISSUE_URL, issueNumber: 1 }),
    ).resolves.toBeUndefined();
  });
});
