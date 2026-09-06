import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod';
import { logger } from '../utils/logger';

// Validate recipient format before it ever goes into a URL or header.
const emailSchema = z.string().email();

// Where claim-review notifications go. Override with ADMIN_EMAIL.
export const ADMIN_NOTIFICATION_EMAIL = process.env.ADMIN_EMAIL || 'admin@boardsesh.com';

/** Public backend origin (no trailing slash) — used to build the verify link. */
export function backendPublicUrl(): string {
  return (process.env.BACKEND_PUBLIC_URL || 'https://ws.boardsesh.com').replace(/\/+$/, '');
}

/** Public web origin (no trailing slash) — used for admin/success links. */
export function webPublicUrl(): string {
  return (process.env.WEB_PUBLIC_URL || process.env.BOARDSESH_URL || 'https://www.boardsesh.com').replace(/\/+$/, '');
}

// Muted rose primary + neutrals, matching the web transactional emails closely
// enough without pulling in the web theme package.
const colors = {
  primary: '#b0757e',
  textPrimary: '#292524',
  textSecondary: '#78716c',
  textMuted: '#a8a29e',
  border: '#e7e5e4',
} as const;

const FONT_FAMILY = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// Lazy transporter so importing this module never touches SMTP.
let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
      throw new Error('SMTP credentials not configured. Set SMTP_USER and SMTP_PASSWORD environment variables.');
    }
    const port = parseInt(process.env.SMTP_PORT || '465', 10);
    // `secure: true` means TLS-on-connect (port 465). Port 587 uses STARTTLS and
    // must be `secure: false`, or the connection hangs. Derive it from the port,
    // with an explicit SMTP_SECURE override for non-standard setups.
    const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.fastmail.com',
      port,
      secure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
  }
  return transporter;
}

function escapeHtml(text: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
}

// Strip CR/LF (and collapse whitespace) before interpolating user text into a
// header like the subject. Nodemailer already encodes headers, but this is cheap
// defense-in-depth against header injection.
function headerSafe(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);
}

function fromAddress(): string | undefined {
  return process.env.EMAIL_FROM || process.env.SMTP_USER;
}

function button(href: string, label: string): string {
  return `<a href="${href}" style="display: inline-block; background-color: ${colors.primary}; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; margin: 24px 0; font-weight: 600; font-size: 16px;">${label}</a>`;
}

function shell(heading: string, body: string): string {
  return `
    <div style="font-family: ${FONT_FAMILY}; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h1 style="color: ${colors.primary}; margin-bottom: 24px;">${heading}</h1>
      ${body}
    </div>
  `;
}

// Shared with the other transactional-email modules (see `cnc-emails.ts`) so
// every Boardsesh email uses one shell, one button and one escaping story
// rather than each module growing its own near-identical copy. Exported as a
// block at the end of the private helpers so the definitions above stay
// unannotated and it is obvious in one place what leaves this module.
export { colors as emailColors, escapeHtml, headerSafe, fromAddress, getTransporter, button, shell };

/**
 * Send the domain-verification email for a gym claim. Clicking the link proves
 * the claimant controls an address at the gym's website domain and transfers
 * ownership TO THE CLAIMANT. The email names the requester so a recipient who
 * isn't them won't hand over the gym (guards against a confused-deputy transfer
 * to a third party who supplied someone else's work address).
 */
export async function sendGymClaimVerificationEmail(
  email: string,
  token: string,
  gymName: string,
  claimantName: string,
): Promise<void> {
  const validatedEmail = emailSchema.parse(email);
  const verifyUrl = `${backendPublicUrl()}/api/gym-claims/verify?token=${encodeURIComponent(token)}`;
  // The URL is already percent-encoded. Use it raw in the href — HTML-entity-
  // encoding it (`&`→`&amp;`) is for visible text, and some email clients don't
  // decode entities in an href, which would corrupt a multi-param link. `safeUrl`
  // is only for the human-readable "paste this link" line.
  const safeUrl = escapeHtml(verifyUrl);
  const safeGym = escapeHtml(gymName);
  const safeClaimant = escapeHtml(claimantName);

  await getTransporter().sendMail({
    from: fromAddress(),
    to: validatedEmail,
    subject: headerSafe(`Confirm the ownership claim for ${gymName} on Boardsesh`),
    html: shell(
      'Confirm a gym ownership claim',
      `
      <p style="color: ${colors.textPrimary}; font-size: 16px; line-height: 1.5;">
        <strong>${safeClaimant}</strong> is claiming ownership of <strong>${safeGym}</strong> on Boardsesh.
        If that's you, confirm below and the listing is yours.
      </p>
      ${button(verifyUrl, 'Confirm ownership')}
      <p style="color: ${colors.textSecondary}; font-size: 14px; margin-top: 24px;">Or paste this link into your browser:</p>
      <p style="color: ${colors.primary}; font-size: 14px; word-break: break-all;">${safeUrl}</p>
      <hr style="border: none; border-top: 1px solid ${colors.border}; margin: 32px 0;" />
      <p style="color: ${colors.textMuted}; font-size: 12px;">
        This link expires in 24 hours. Clicking it transfers ${safeGym} to ${safeClaimant}'s Boardsesh account.
        If you don't recognise this request, ignore this email — nothing changes.
      </p>
    `,
    ),
    text: `${claimantName} is claiming ownership of ${gymName} on Boardsesh. If that's you, confirm here (this transfers the listing to ${claimantName}'s account):\n\n${verifyUrl}\n\nThis link expires in 24 hours. If you don't recognise this request, ignore this email.`,
  });
}

/**
 * Notify the Boardsesh team that a user requested a gym claim that needs manual
 * review (no usable domain on file).
 *
 * `pendingClaimCount` is how many claims that same account now has waiting. Past
 * the first, the mail leads with the backlog so a claimant working through
 * several gyms reads as one job rather than N unrelated pings. Every claim still
 * mails: suppressing the later ones would let one failed send mute an account's
 * entire queue.
 */
export async function sendGymClaimAdminNotification(details: {
  gymName: string;
  gymUuid: string;
  claimantName: string;
  message?: string | null;
  pendingClaimCount?: number;
}): Promise<void> {
  // Static path, no user input — used raw in the href (see the verify email note).
  const reviewUrl = `${webPublicUrl()}/admin/gym-claims`;
  const safeGym = escapeHtml(details.gymName);
  const safeClaimant = escapeHtml(details.claimantName);
  const safeMessage = details.message ? escapeHtml(details.message) : null;
  const backlog = details.pendingClaimCount && details.pendingClaimCount > 1 ? details.pendingClaimCount : null;
  const backlogLine = backlog ? `${details.claimantName} now has ${backlog} claims waiting on review.` : null;

  await getTransporter().sendMail({
    from: fromAddress(),
    to: ADMIN_NOTIFICATION_EMAIL,
    subject: headerSafe(
      backlog
        ? `Gym claim to review: ${details.gymName} (${backlog} from this claimant)`
        : `Gym claim to review: ${details.gymName}`,
    ),
    html: shell(
      'New gym claim',
      `
      <p style="color: ${colors.textPrimary}; font-size: 16px; line-height: 1.5;">
        <strong>${safeClaimant}</strong> wants to claim <strong>${safeGym}</strong>.
      </p>
      ${backlogLine ? `<p style="color: ${colors.textSecondary}; font-size: 15px; line-height: 1.5;">${escapeHtml(backlogLine)} Review them together below.</p>` : ''}
      ${safeMessage ? `<p style="color: ${colors.textSecondary}; font-size: 15px; line-height: 1.5;">"${safeMessage}"</p>` : ''}
      ${button(reviewUrl, 'Review claims')}
      <hr style="border: none; border-top: 1px solid ${colors.border}; margin: 32px 0;" />
      <p style="color: ${colors.textMuted}; font-size: 12px;">Gym UUID: ${escapeHtml(details.gymUuid)}</p>
    `,
    ),
    text: `${details.claimantName} wants to claim ${details.gymName}.${backlogLine ? `\n\n${backlogLine}` : ''}${details.message ? `\n\nMessage: ${details.message}` : ''}\n\nReview: ${reviewUrl}\n\nGym UUID: ${details.gymUuid}`,
  });
}

/**
 * Notify the Boardsesh team that a gym owner (or a signed-in climber) flagged two
 * listings as the same gym, so an admin can fold them together in the merge queue.
 */
export async function sendGymDuplicateReportAdminNotification(details: {
  gymName: string;
  gymUuid: string;
  duplicateGymName: string;
  duplicateGymUuid: string;
  reporterName: string;
  note?: string | null;
}): Promise<void> {
  // Static path, no user input — used raw in the href (see the verify email note).
  const reviewUrl = `${webPublicUrl()}/admin/gym-duplicates`;
  const safeGym = escapeHtml(details.gymName);
  const safeDuplicate = escapeHtml(details.duplicateGymName);
  const safeReporter = escapeHtml(details.reporterName);
  const safeNote = details.note ? escapeHtml(details.note) : null;

  await getTransporter().sendMail({
    from: fromAddress(),
    to: ADMIN_NOTIFICATION_EMAIL,
    subject: headerSafe(`Duplicate gym report: ${details.gymName}`),
    html: shell(
      'Duplicate gym report',
      `
      <p style="color: ${colors.textPrimary}; font-size: 16px; line-height: 1.5;">
        <strong>${safeReporter}</strong> says <strong>${safeGym}</strong> and <strong>${safeDuplicate}</strong> are the same gym.
      </p>
      ${safeNote ? `<p style="color: ${colors.textSecondary}; font-size: 15px; line-height: 1.5;">"${safeNote}"</p>` : ''}
      ${button(reviewUrl, 'Review duplicates')}
      <hr style="border: none; border-top: 1px solid ${colors.border}; margin: 32px 0;" />
      <p style="color: ${colors.textMuted}; font-size: 12px;">Gym UUID: ${escapeHtml(details.gymUuid)}</p>
      <p style="color: ${colors.textMuted}; font-size: 12px;">Reported duplicate UUID: ${escapeHtml(details.duplicateGymUuid)}</p>
    `,
    ),
    text: `${details.reporterName} says ${details.gymName} and ${details.duplicateGymName} are the same gym.${details.note ? `\n\nNote: ${details.note}` : ''}\n\nReview: ${reviewUrl}\n\nGym UUID: ${details.gymUuid}\nReported duplicate UUID: ${details.duplicateGymUuid}`,
  });
}

/**
 * Let the claimant know their claim went through (domain-verified or approved).
 * Best-effort — failures are logged, never thrown, so they don't undo an
 * already-applied ownership transfer.
 */
export async function sendGymClaimApprovedEmail(email: string, gymName: string): Promise<void> {
  try {
    const validatedEmail = emailSchema.parse(email);
    const safeGym = escapeHtml(gymName);
    await getTransporter().sendMail({
      from: fromAddress(),
      to: validatedEmail,
      subject: headerSafe(`You now own ${gymName} on Boardsesh`),
      html: shell(
        `${safeGym} is yours`,
        `
        <p style="color: ${colors.textPrimary}; font-size: 16px; line-height: 1.5;">
          Your claim went through — you're the owner of <strong>${safeGym}</strong> on Boardsesh now.
          Keep the listing and boards accurate, and invite your crew to help.
        </p>
      `,
      ),
      text: `Your claim went through — you now own ${gymName} on Boardsesh.`,
    });
  } catch (error) {
    logger.warn('[GymClaim] Failed to send approval email:', error instanceof Error ? error.message : error);
  }
}

/**
 * Tell a claimant their claim was turned down, and how to get it looked at
 * again. Best-effort — a dead SMTP must not undo the review decision, which is
 * already committed by the time this runs.
 */
export async function sendGymClaimDeniedEmail(email: string, gymName: string): Promise<void> {
  try {
    const validatedEmail = emailSchema.parse(email);
    const safeGym = escapeHtml(gymName);
    await getTransporter().sendMail({
      from: fromAddress(),
      to: validatedEmail,
      subject: headerSafe(`Your claim for ${gymName} wasn't approved`),
      html: shell(
        'We couldn’t approve this claim',
        `
        <p style="color: ${colors.textPrimary}; font-size: 16px; line-height: 1.5;">
          We reviewed your claim for <strong>${safeGym}</strong> and couldn't confirm you run it,
          so the listing stays where it is.
        </p>
        <p style="color: ${colors.textSecondary}; font-size: 15px; line-height: 1.5;">
          If this is your gym, reply to this email with something that shows you manage it — a work
          email address, your role, anything on the gym's own site — and we'll take another look.
        </p>
      `,
      ),
      text: `We reviewed your claim for ${gymName} and couldn't confirm you run it, so the listing stays where it is. If this is your gym, reply with something that shows you manage it and we'll take another look.`,
    });
  } catch (error) {
    logger.warn('[GymClaim] Failed to send denial email:', error instanceof Error ? error.message : error);
  }
}

/**
 * Heads-up to a previous owner whose gym was claimed by someone who verified
 * control of the gym's domain (or was approved by an admin). They're kept on as
 * a gym admin, so this is transparency, not a lockout. Best-effort.
 */
export async function sendGymClaimOwnershipLostEmail(email: string, gymName: string): Promise<void> {
  try {
    const validatedEmail = emailSchema.parse(email);
    const safeGym = escapeHtml(gymName);
    await getTransporter().sendMail({
      from: fromAddress(),
      to: validatedEmail,
      subject: headerSafe(`Ownership of ${gymName} was transferred on Boardsesh`),
      html: shell(
        'A gym you owned was claimed',
        `
        <p style="color: ${colors.textPrimary}; font-size: 16px; line-height: 1.5;">
          Someone verified they manage <strong>${safeGym}</strong> and took over its Boardsesh listing.
          You're still a gym admin, so you can keep editing it. If this looks wrong, reply to this email
          and our team will take a look.
        </p>
      `,
      ),
      text: `Someone verified they manage ${gymName} and took over its Boardsesh listing. You're still a gym admin and can keep editing it. If this looks wrong, reply and our team will take a look.`,
    });
  } catch (error) {
    logger.warn('[GymClaim] Failed to send ownership-lost email:', error instanceof Error ? error.message : error);
  }
}
