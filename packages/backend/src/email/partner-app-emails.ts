import { logger } from '../utils/logger';
import {
  button,
  deliverableEmailSchema,
  emailColors,
  escapeHtml,
  fromAddress,
  getTransporter,
  headerSafe,
  shell,
  webPublicUrl,
} from './email-service';

/**
 * The email a developer gets when someone changes where one of their partner
 * apps sends codes and tokens (its redirect URIs, its client secret, or the app
 * itself), or registers a new app on their account (#7598). It is how a
 * developer whose session someone else holds finds out. The registration sends
 * it only to a verified address.
 *
 * Best-effort, like every transactional email here: the change is committed
 * before this runs, and a dead SMTP server must not undo it or fail the
 * developer's request. No secret ever goes in: the client ID is public, and a
 * redirect change is told as counts so the email carries no link someone else
 * chose. A deleted account's retired `.invalid` address gets nothing.
 */

/**
 * What happened, as the partner registration hands it over once committed. It
 * lives here, with the email that renders it, so this module never reaches into
 * `auth/partner/` (the boundary guard in `scripts/__tests__/better-auth-boundary.test.ts`).
 * Registering is not gated, so a new app is told too: it is how a developer
 * learns that someone holding their session registered one in their name.
 */
export type PartnerAppChangeNotice = {
  readonly developerEmail: string;
  readonly appName: string;
  readonly clientId: string;
  readonly changedAt: Date;
} & (
  | { readonly change: 'app_registered' }
  | { readonly change: 'redirect_uris_changed'; readonly added: number; readonly removed: number }
  | { readonly change: 'secret_rotated' }
  | { readonly change: 'app_deleted' }
);

function addedAndRemoved(added: number, removed: number): string {
  const addedText = `${added} redirect URI${added === 1 ? '' : 's'} added`;
  const removedText = `${removed} removed`;
  if (added > 0 && removed > 0) return `${addedText} and ${removedText}`;
  if (added > 0) return addedText;
  return `${removed} redirect URI${removed === 1 ? '' : 's'} removed`;
}

/** Subject, heading and one sentence, all plain text; the caller escapes. */
function describe(notice: PartnerAppChangeNotice): { subject: string; heading: string; what: string } {
  switch (notice.change) {
    case 'app_registered':
      return {
        subject: `New app registered on your Boardsesh account: ${notice.appName}`,
        heading: 'A new app was registered',
        what: 'It can ask climbers to connect it to their Boardsesh logbook. Nothing is shared until a climber approves it.',
      };
    case 'redirect_uris_changed':
      return {
        subject: `Redirect URIs changed for ${notice.appName} on Boardsesh`,
        heading: 'Your app’s redirect URIs changed',
        what:
          notice.added > 0
            ? `${addedAndRemoved(notice.added, notice.removed)}. Climbers who approved the app see the consent screen again the next time it asks for their logbook.`
            : `${addedAndRemoved(notice.added, notice.removed)}.`,
      };
    case 'secret_rotated':
      return {
        subject: `New client secret for ${notice.appName} on Boardsesh`,
        heading: 'Your app has a new client secret',
        what: 'The old secret stopped working at once. Token requests that use it now fail.',
      };
    case 'app_deleted':
      return {
        subject: `${notice.appName} was deleted from Boardsesh`,
        heading: 'Your app was deleted',
        what: 'Every climber connected to it was disconnected, and its tokens stopped working.',
      };
  }
}

export async function sendPartnerAppChangeEmail(notice: PartnerAppChangeNotice): Promise<void> {
  try {
    const recipient = deliverableEmailSchema.parse(notice.developerEmail);
    const { subject, heading, what } = describe(notice);
    const happened = notice.change === 'app_registered' ? 'was registered' : 'changed';
    const lead = `${notice.appName} (client ID ${notice.clientId}) ${happened} in the Boardsesh developer console on ${notice.changedAt.toUTCString()}.`;
    const consoleUrl = `${webPublicUrl()}/developers/apps`;
    const notYou =
      'If this wasn’t you, someone else may be signed in to your Boardsesh account. Change your password, check your apps in the developer console, and reply to this email so we can help.';
    await getTransporter().sendMail({
      from: fromAddress(),
      to: recipient,
      subject: headerSafe(subject),
      html: shell(
        escapeHtml(heading),
        `
        <p style="color: ${emailColors.textPrimary}; font-size: 16px; line-height: 1.5;">${escapeHtml(lead)}</p>
        <p style="color: ${emailColors.textPrimary}; font-size: 16px; line-height: 1.5;">${escapeHtml(what)}</p>
        <p style="color: ${emailColors.textSecondary}; font-size: 15px; line-height: 1.5;">${escapeHtml(notYou)}</p>
        ${button(escapeHtml(consoleUrl), 'Open the developer console')}
      `,
      ),
      text: `${lead}\n\n${what}\n\n${notYou}\n\n${consoleUrl}`,
    });
  } catch (error) {
    // The name only: an SMTP error can quote the recipient.
    logger.warn('[PartnerApps] Failed to send the app change email', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
  }
}
