import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod';

/** Validates address format before it's used in URLs or as a recipient. */
export const emailSchema = z
  .string()
  .email()
  .refine(
    (address) => !address.toLowerCase().split('@')[1]?.replace(/\.$/, '').endsWith('.invalid'),
    'Recipient is unavailable.',
  );

/**
 * Inline style values for HTML emails. These were lifted verbatim from the web
 * design tokens (`themeTokens`) when this code moved into the shared package, so
 * the rendered emails are byte-identical. Inlined here on purpose — a shared
 * server-only package must not import the web theme.
 */
export const emailTheme = {
  primary: '#8C4A52', // muted dusty rose — themeTokens.colors.primary
  textPrimary: '#1F2937', // themeTokens.neutral[800]
  textSecondary: '#6B7280', // themeTokens.neutral[500]
  textMuted: '#9CA3AF', // themeTokens.neutral[400]
  border: '#E5E7EB', // themeTokens.neutral[200]
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  borderRadiusMd: 8, // themeTokens.borderRadius.md
  fontWeightSemibold: 600, // themeTokens.typography.fontWeight.semibold
} as const;

// Lazy-loaded transporter to avoid initialization at module load.
let transporter: Transporter | null = null;

export function getTransporter(): Transporter {
  if (!transporter) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
      throw new Error('SMTP credentials not configured. Set SMTP_USER and SMTP_PASSWORD environment variables.');
    }

    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.fastmail.com',
      port: parseInt(process.env.SMTP_PORT || '465', 10),
      secure: true, // true for 465, false for 587
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });
  }
  return transporter;
}

/** Escapes HTML special characters to prevent injection in email markup. */
export function escapeHtml(text: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
}

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

/**
 * Send a transactional email through the shared SMTP transport. Validates the
 * recipient and applies the default `from`. Throws if SMTP is unconfigured or
 * the send fails — callers that must not fail (fire-and-forget side effects)
 * should guard/catch.
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  const to = emailSchema.parse(message.to);
  await getTransporter().sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
}
