import { emailTheme, escapeHtml, sendEmail } from './transport';

export type BugReportIssueEmail = {
  subject: string;
  html: string;
  text: string;
};

/**
 * Build the "we turned your bug into an issue" email. Pure — no I/O — so the
 * copy and escaping are unit-testable. Mirrors the inline-style HTML + plain
 * text shape of the auth emails.
 */
export function buildBugReportIssueEmail(args: { issueUrl: string; issueNumber: number }): BugReportIssueEmail {
  const safeUrl = escapeHtml(args.issueUrl);
  return {
    subject: "We're on it — your Boardsesh bug report",
    html: `
      <div style="font-family: ${emailTheme.fontFamily}; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: ${emailTheme.primary}; margin-bottom: 24px;">Thanks for the report</h1>
        <p style="color: ${emailTheme.textPrimary}; font-size: 16px; line-height: 1.5;">
          We turned your bug report into issue #${args.issueNumber} so we can track it to a fix. Follow along, or add
          anything that'd help us reproduce it:
        </p>
        <a href="${safeUrl}" style="
          display: inline-block;
          background-color: ${emailTheme.primary};
          color: white;
          padding: 14px 28px;
          text-decoration: none;
          border-radius: ${emailTheme.borderRadiusMd}px;
          margin: 24px 0;
          font-weight: ${emailTheme.fontWeightSemibold};
          font-size: 16px;
        ">View the issue</a>
        <p style="color: ${emailTheme.textSecondary}; font-size: 14px; margin-top: 24px;">
          Or copy and paste this link into your browser:
        </p>
        <p style="color: ${emailTheme.primary}; font-size: 14px; word-break: break-all;">
          ${safeUrl}
        </p>
        <hr style="border: none; border-top: 1px solid ${emailTheme.border}; margin: 32px 0;" />
        <p style="color: ${emailTheme.textMuted}; font-size: 12px;">
          Heads up: this issue is tracked publicly on GitHub. Reply to this email if you'd rather reach us directly.
          You got this because you asked us to follow up on your report.
        </p>
      </div>
    `,
    text: `Thanks for the report\n\nWe turned your bug report into issue #${args.issueNumber} so we can track it to a fix.\n\nFollow along or add detail here:\n${args.issueUrl}\n\nHeads up: this issue is tracked publicly on GitHub. Reply to this email if you'd rather reach us directly. You got this because you asked us to follow up on your report.`,
  };
}

/**
 * Email a reporter the GitHub issue we opened from their bug report. Safe to
 * call without `await` from a fire-and-forget side effect:
 *  - no-ops (no send) when SMTP credentials are unset (e.g. local dev),
 *  - never throws — transport/validation failures are logged and swallowed.
 */
export async function sendBugReportIssueEmail(args: {
  to: string;
  issueUrl: string;
  issueNumber: number;
}): Promise<void> {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) return;

  try {
    const { subject, html, text } = buildBugReportIssueEmail(args);
    await sendEmail({ to: args.to, subject, html, text });
  } catch (error) {
    console.error('[email] Failed to send bug-report issue email:', error);
  }
}
