import {
  button,
  deliverableEmailSchema,
  escapeHtml,
  fromAddress,
  headerSafe,
  sendBoundedCncNotification,
  shell,
  webPublicUrl,
} from './email-service';

export async function sendPartnerWebhookDisabledEmail(email: string, appName: string): Promise<void> {
  if (!deliverableEmailSchema.safeParse(email).success) return;
  const subject = 'Your Boardsesh webhook needs attention';
  const explanation = `${appName}'s webhook has failed for three days and is now paused. Your app can keep reading the API. Fix the endpoint and re-enable webhooks in the developer console.`;
  const url = `${webPublicUrl()}/developers/apps`;
  await sendBoundedCncNotification({
    from: fromAddress(),
    to: email,
    subject: headerSafe(subject),
    html: shell(subject, `<p>${escapeHtml(explanation)}</p>${button(escapeHtml(url), 'Check webhooks')}`),
    text: `${explanation}\n\n${url}`,
  });
}
