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
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.fastmail.com',
      port: parseInt(process.env.SMTP_PORT || '465', 10),
      secure: true,
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

/**
 * Send the domain-verification email for a gym claim. Clicking the link proves
 * the claimant controls an address at the gym's website domain and transfers
 * ownership.
 */
export async function sendGymClaimVerificationEmail(email: string, token: string, gymName: string): Promise<void> {
  const validatedEmail = emailSchema.parse(email);
  const verifyUrl = `${backendPublicUrl()}/api/gym-claims/verify?token=${encodeURIComponent(token)}`;
  const safeUrl = escapeHtml(verifyUrl);
  const safeGym = escapeHtml(gymName);

  await getTransporter().sendMail({
    from: fromAddress(),
    to: validatedEmail,
    subject: `Verify your ownership of ${gymName} on Boardsesh`,
    html: shell(
      'Claim your gym',
      `
      <p style="color: ${colors.textPrimary}; font-size: 16px; line-height: 1.5;">
        Confirm you manage <strong>${safeGym}</strong> to take ownership of its Boardsesh listing.
        Click below and it's yours.
      </p>
      ${button(safeUrl, 'Confirm ownership')}
      <p style="color: ${colors.textSecondary}; font-size: 14px; margin-top: 24px;">Or paste this link into your browser:</p>
      <p style="color: ${colors.primary}; font-size: 14px; word-break: break-all;">${safeUrl}</p>
      <hr style="border: none; border-top: 1px solid ${colors.border}; margin: 32px 0;" />
      <p style="color: ${colors.textMuted}; font-size: 12px;">
        This link expires in 24 hours. If you didn't request this, you can ignore this email.
      </p>
    `,
    ),
    text: `Confirm you manage ${gymName} to take ownership of its Boardsesh listing:\n\n${verifyUrl}\n\nThis link expires in 24 hours. If you didn't request this, you can ignore this email.`,
  });
}

/**
 * Notify the Boardsesh team that a user requested a gym claim that needs manual
 * review (no usable domain on file).
 */
export async function sendGymClaimAdminNotification(details: {
  gymName: string;
  gymUuid: string;
  claimantName: string;
  message?: string | null;
}): Promise<void> {
  const reviewUrl = `${webPublicUrl()}/admin/gym-claims`;
  const safeReviewUrl = escapeHtml(reviewUrl);
  const safeGym = escapeHtml(details.gymName);
  const safeClaimant = escapeHtml(details.claimantName);
  const safeMessage = details.message ? escapeHtml(details.message) : null;

  await getTransporter().sendMail({
    from: fromAddress(),
    to: ADMIN_NOTIFICATION_EMAIL,
    subject: `Gym claim to review: ${details.gymName}`,
    html: shell(
      'New gym claim',
      `
      <p style="color: ${colors.textPrimary}; font-size: 16px; line-height: 1.5;">
        <strong>${safeClaimant}</strong> wants to claim <strong>${safeGym}</strong>.
      </p>
      ${safeMessage ? `<p style="color: ${colors.textSecondary}; font-size: 15px; line-height: 1.5;">"${safeMessage}"</p>` : ''}
      ${button(safeReviewUrl, 'Review claims')}
      <hr style="border: none; border-top: 1px solid ${colors.border}; margin: 32px 0;" />
      <p style="color: ${colors.textMuted}; font-size: 12px;">Gym UUID: ${escapeHtml(details.gymUuid)}</p>
    `,
    ),
    text: `${details.claimantName} wants to claim ${details.gymName}.${details.message ? `\n\nMessage: ${details.message}` : ''}\n\nReview: ${reviewUrl}\n\nGym UUID: ${details.gymUuid}`,
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
      subject: `You now own ${gymName} on Boardsesh`,
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
