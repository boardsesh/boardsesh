import { emailSchema, emailTheme, escapeHtml, sendEmail } from './transport';

export async function sendVerificationEmail(email: string, token: string, baseUrl: string): Promise<void> {
  // Validate email format before using in URL to prevent injection
  const validatedEmail = emailSchema.parse(email);

  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(validatedEmail)}`;
  const safeVerifyUrl = escapeHtml(verifyUrl);

  await sendEmail({
    to: validatedEmail,
    subject: 'Verify your Boardsesh email',
    html: `
      <div style="font-family: ${emailTheme.fontFamily}; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: ${emailTheme.primary}; margin-bottom: 24px;">Welcome to Boardsesh!</h1>
        <p style="color: ${emailTheme.textPrimary}; font-size: 16px; line-height: 1.5;">
          Please verify your email address by clicking the button below:
        </p>
        <a href="${safeVerifyUrl}" style="
          display: inline-block;
          background-color: ${emailTheme.primary};
          color: white;
          padding: 14px 28px;
          text-decoration: none;
          border-radius: ${emailTheme.borderRadiusMd}px;
          margin: 24px 0;
          font-weight: ${emailTheme.fontWeightSemibold};
          font-size: 16px;
        ">Verify Email</a>
        <p style="color: ${emailTheme.textSecondary}; font-size: 14px; margin-top: 24px;">
          Or copy and paste this link into your browser:
        </p>
        <p style="color: ${emailTheme.primary}; font-size: 14px; word-break: break-all;">
          ${safeVerifyUrl}
        </p>
        <hr style="border: none; border-top: 1px solid ${emailTheme.border}; margin: 32px 0;" />
        <p style="color: ${emailTheme.textMuted}; font-size: 12px;">
          This link expires in 24 hours. If you didn't create a Boardsesh account, you can safely ignore this email.
        </p>
      </div>
    `,
    text: `Welcome to Boardsesh!\n\nPlease verify your email address by clicking this link:\n\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you didn't create a Boardsesh account, you can safely ignore this email.`,
  });
}

export async function sendPasswordResetEmail(email: string, token: string, baseUrl: string): Promise<void> {
  const validatedEmail = emailSchema.parse(email);

  const resetUrl = `${baseUrl}/auth/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(validatedEmail)}`;
  const safeResetUrl = escapeHtml(resetUrl);

  await sendEmail({
    to: validatedEmail,
    subject: 'Reset your Boardsesh password',
    html: `
      <div style="font-family: ${emailTheme.fontFamily}; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: ${emailTheme.primary}; margin-bottom: 24px;">Password reset request</h1>
        <p style="color: ${emailTheme.textPrimary}; font-size: 16px; line-height: 1.5;">
          We received a request to reset your Boardsesh password.
        </p>
        <a href="${safeResetUrl}" style="
          display: inline-block;
          background-color: ${emailTheme.primary};
          color: white;
          padding: 14px 28px;
          text-decoration: none;
          border-radius: ${emailTheme.borderRadiusMd}px;
          margin: 24px 0;
          font-weight: ${emailTheme.fontWeightSemibold};
          font-size: 16px;
        ">Reset Password</a>
        <p style="color: ${emailTheme.textSecondary}; font-size: 14px; margin-top: 24px;">
          Or copy and paste this link into your browser:
        </p>
        <p style="color: ${emailTheme.primary}; font-size: 14px; word-break: break-all;">
          ${safeResetUrl}
        </p>
        <hr style="border: none; border-top: 1px solid ${emailTheme.border}; margin: 32px 0;" />
        <p style="color: ${emailTheme.textMuted}; font-size: 12px;">
          This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email.
        </p>
      </div>
    `,
    text: `Reset your Boardsesh password\n\nUse this link to reset your password:\n\n${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you did not request this, you can safely ignore this email.`,
  });
}
