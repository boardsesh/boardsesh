import { emailSchema, emailTheme, escapeHtml, sendEmail } from './transport';

/** The backend supplies the existing account recipient. No address or UID is
 * placed in the confirmation URL; its fragment stays out of HTTP requests. */
export async function sendFirstPasswordConfirmationEmail(
  recipient: string,
  confirmationToken: string,
  operationKey: string,
  canonicalOrigin: string,
): Promise<void> {
  const address = emailSchema.parse(recipient);
  const origin = new URL(canonicalOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== canonicalOrigin ||
    !/^[A-Za-z0-9_-]{43}$/.test(confirmationToken) ||
    !/^[a-f0-9]{64}$/.test(operationKey)
  )
    throw new Error('Invalid first-password delivery plan');
  const confirmation = new URL('/auth/confirm-first-password', origin);
  confirmation.hash = new URLSearchParams({ token: confirmationToken, operation: operationKey }).toString();
  const link = confirmation.toString();
  await sendEmail({
    to: address,
    subject: 'Confirm your email to add a Boardsesh password',
    html: `<div style="font-family: ${emailTheme.fontFamily}; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h1>Add a password to your Boardsesh account</h1>
      <p>Open this link in the browser where you requested it, then choose a password.</p>
      <p><a href="${escapeHtml(link)}">Confirm email and choose a password</a></p>
      <p>This link expires within five minutes. If you did not request it, you can ignore this email.</p>
    </div>`,
    text: `Add a password to your Boardsesh account\n\nOpen this link in the browser where you requested it, then choose a password:\n\n${link}\n\nThis link expires within five minutes. If you did not request it, you can ignore this email.`,
  });
}
