import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { sendPasswordResetEmail } from '@boardsesh/email';
import type { ForgotPasswordReply, ResetPasswordReply } from '@boardsesh/auth-protocol';
import { createPasswordCommandClient, registrationMailOrigin } from './password-command-client.server';
import { passwordCommandUnavailableResponse } from './register-password-command.server';
import { withEmailVerificationPrivacy } from './email-verification-response.server';

export const GENERIC_PASSWORD_RECOVERY_MESSAGE = 'If an account exists for this email, a reset link will be sent.';
export const PASSWORD_RESET_SUCCESS_MESSAGE = 'Password reset successful. You can now sign in with your new password.';
export const INVALID_PASSWORD_RESET_MESSAGE = 'Invalid or expired reset link';

export function passwordRecoveryUnavailableResponse(): NextResponse {
  return withEmailVerificationPrivacy(passwordCommandUnavailableResponse());
}

function recoveryError(reply: ForgotPasswordReply | ResetPasswordReply): NextResponse {
  if (reply.outcome === 'error' && reply.code === 'validation_error')
    return withEmailVerificationPrivacy(NextResponse.json({ error: reply.message }, { status: 400 }));
  if (reply.outcome === 'error' && reply.code === 'rate_limited')
    return withEmailVerificationPrivacy(
      NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(reply.retryAfterSeconds) } },
      ),
    );
  return passwordRecoveryUnavailableResponse();
}

export async function forgotPasswordWithCommand(request: NextRequest, payload: unknown): Promise<NextResponse> {
  try {
    // Validate trusted mail configuration before a command can commit a receipt.
    const origin = registrationMailOrigin(request.nextUrl.origin);
    const reply = await createPasswordCommandClient().forgotPassword(payload);
    if (reply.outcome !== 'accepted') return recoveryError(reply);
    if (reply.mailPlan) {
      try {
        // Only the committed recipient and capability may reach the mail adapter.
        await sendPasswordResetEmail(reply.mailPlan.recipient, reply.mailPlan.token, origin);
      } catch {
        Sentry.captureException(new Error('Password recovery email delivery failed'), {
          tags: { area: 'auth', flow: 'forgot-password', phase: 'send-email' },
        });
      }
    }
    // SMTP failure, absence and ineligible identities share this public result.
    // The existing transport is unbounded; this is not a constant-time claim.
    return withEmailVerificationPrivacy(NextResponse.json({ message: GENERIC_PASSWORD_RECOVERY_MESSAGE }));
  } catch {
    return passwordRecoveryUnavailableResponse();
  }
}

export async function resetPasswordWithCommand(payload: unknown): Promise<NextResponse> {
  try {
    const reply = await createPasswordCommandClient().resetPassword(payload);
    if (reply.outcome === 'reset')
      return withEmailVerificationPrivacy(NextResponse.json({ message: PASSWORD_RESET_SUCCESS_MESSAGE }));
    if (reply.outcome === 'invalid_or_expired')
      return withEmailVerificationPrivacy(
        NextResponse.json({ error: INVALID_PASSWORD_RESET_MESSAGE }, { status: 400 }),
      );
    return recoveryError(reply);
  } catch {
    return passwordRecoveryUnavailableResponse();
  }
}
