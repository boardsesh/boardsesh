import {
  button,
  deliverableEmailSchema,
  escapeHtml,
  fromAddress,
  sendBoundedCncNotification,
  headerSafe,
  shell,
  webPublicUrl,
} from './email-service';

/** Fragment keeps the secret out of HTTP request targets and referrers. The page requires an explicit confirmation. */
export async function sendPartnerDeveloperVerificationEmail(email: string, token: string): Promise<void> {
  const recipient = deliverableEmailSchema.parse(email);
  const link = `${webPublicUrl()}/developers/apps/verify-email#token=${encodeURIComponent(token)}`;
  const heading = 'Verify your Boardsesh developer email';
  const explanation =
    'Confirm this email while signed in to the Boardsesh account that requested it. The link expires in 30 minutes. Opening the link does not verify it automatically.';
  await sendBoundedCncNotification({
    from: fromAddress(),
    to: recipient,
    subject: heading,
    html: shell(heading, `<p>${escapeHtml(explanation)}</p>${button(escapeHtml(link), 'Confirm developer email')}`),
    text: `${explanation}\n\n${link}`,
  });
}

/** Throws on transport failure: the durable notice worker retries it. */
export async function sendPartnerConnectionEmail(email: string, appName: string): Promise<void> {
  const recipient = deliverableEmailSchema.parse(email);
  const heading = 'An app connected to your Boardsesh account';
  const explanation = `${appName} connected to your account. Review its access in Settings → Connected apps. If this was not you, disconnect it and change your password.`;
  const settings = `${webPublicUrl()}/settings`;
  await sendBoundedCncNotification({
    from: fromAddress(),
    to: recipient,
    subject: headerSafe(heading),
    html: shell(heading, `<p>${escapeHtml(explanation)}</p>${button(escapeHtml(settings), 'Check connected apps')}`),
    text: `${explanation}\n\n${settings}`,
  });
}
