import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PartnerAppChangeNotice } from '../partner-app-emails';

const sendMail = vi.hoisted(() => vi.fn());
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => ({ sendMail })) } }));
import { logger } from '../../utils/logger';
import { sendPartnerAppChangeEmail } from '../partner-app-emails';

const BASE = {
  developerEmail: 'ana@example.com',
  appName: 'Crimp <Planner>',
  clientId: 'client-id-0123456789',
  changedAt: new Date(Date.UTC(2026, 10, 16, 9, 30)),
} as const;

type SentMail = { to: string; subject: string; html: string; text: string };

function sentMail(): SentMail {
  expect(sendMail).toHaveBeenCalledTimes(1);
  return sendMail.mock.calls[0][0] as SentMail;
}

beforeEach(() => {
  vi.stubEnv('SMTP_USER', 'partner-email-test');
  vi.stubEnv('SMTP_PASSWORD', 'test-only-password');
  sendMail.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the partner app change email (#7598)', () => {
  it.each<[PartnerAppChangeNotice, RegExp, RegExp]>([
    [
      { ...BASE, change: 'redirect_uris_changed', added: 1, removed: 2 },
      /^Redirect URIs changed for Crimp <Planner> on Boardsesh$/,
      /1 redirect URI added and 2 removed\. Climbers who approved the app see the consent screen again/,
    ],
    [
      { ...BASE, change: 'redirect_uris_changed', added: 0, removed: 1 },
      /^Redirect URIs changed for/,
      /1 redirect URI removed\.\n/,
    ],
    [
      { ...BASE, change: 'app_registered' },
      /^New app registered on your Boardsesh account: Crimp <Planner>$/,
      /was registered in the Boardsesh developer console on .*\n\nIt can ask climbers to connect it/,
    ],
    [{ ...BASE, change: 'secret_rotated' }, /^New client secret for/, /The old secret stopped working at once/],
    [
      { ...BASE, change: 'app_deleted' },
      /was deleted from Boardsesh$/,
      /Every climber connected to it was disconnected/,
    ],
  ])('says what changed, when, and what to do if it was not them', async (notice, subject, body) => {
    await sendPartnerAppChangeEmail(notice);
    const mail = sentMail();
    expect(mail.to).toBe('ana@example.com');
    expect(mail.subject).toMatch(subject);
    expect(mail.text).toMatch(body);
    expect(mail.text).toContain('client ID client-id-0123456789');
    expect(mail.text).toContain('Mon, 16 Nov 2026 09:30:00 GMT');
    expect(mail.text).toContain('If this wasn’t you');
    expect(mail.text).toContain('https://www.boardsesh.com/developers/apps');
    // The app name is the developer's text: escaped in the HTML.
    expect(mail.html).toContain('Crimp &lt;Planner&gt;');
    expect(mail.html).not.toContain('<Planner>');
  });

  it('never sends to a retired address, and never throws or logs the address when sending fails', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await sendPartnerAppChangeEmail({
      ...BASE,
      developerEmail: 'deleted@retired.boardsesh.invalid',
      change: 'app_deleted',
    });
    expect(sendMail).not.toHaveBeenCalled();

    sendMail.mockRejectedValueOnce(new Error('550 mailbox ana@example.com unavailable'));
    await expect(sendPartnerAppChangeEmail({ ...BASE, change: 'secret_rotated' })).resolves.toBeUndefined();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('ana@example.com');
    expect(logged).not.toContain('retired.boardsesh.invalid');
    warn.mockRestore();
  });
});
