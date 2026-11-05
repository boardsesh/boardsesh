import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { sendVerificationEmail } from '@boardsesh/email';
import { createPasswordCommandClient, registrationMailOrigin } from './password-command-client.server';
import { passwordCommandUnavailableResponse } from './register-password-command.server';
import { emailVerificationRedirect, emailVerificationUnavailableResponse } from './email-verification-response.server';

export async function verifyEmailWithCommand(
  request: NextRequest,
  token: string,
  legacyEmail?: string,
): Promise<NextResponse> {
  try {
    const reply = await createPasswordCommandClient().verifyEmail(token, legacyEmail);
    if (reply.outcome === 'verified') return emailVerificationRedirect(request, '/auth/login?verified=true');
    if (reply.outcome === 'invalid_token')
      return emailVerificationRedirect(request, '/auth/verify-request?error=InvalidToken');
    if (reply.outcome === 'expired')
      return emailVerificationRedirect(request, '/auth/verify-request?error=TokenExpired');
    if (reply.outcome === 'error' && reply.code === 'rate_limited') {
      const response = emailVerificationRedirect(request, '/auth/verify-request?error=TooManyAttempts');
      response.headers.set('Retry-After', String(reply.retryAfterSeconds));
      return response;
    }
  } catch {
    // Unknown commit state, service rejection, and protocol failures are not
    // evidence that a submitted verification link is invalid.
  }
  return emailVerificationUnavailableResponse(request);
}

export const GENERIC_RESEND_VERIFICATION_MESSAGE =
  'If an account exists and needs verification, a verification email will be sent';

export async function resendVerificationWithCommand(request: NextRequest): Promise<NextResponse> {
  try {
    const mailOrigin = registrationMailOrigin(request.nextUrl.origin);
    const reply = await createPasswordCommandClient().resendVerification(await request.json());
    if (reply.outcome === 'error') {
      if (reply.code === 'validation_error') return NextResponse.json({ error: reply.message }, { status: 400 });
      if (reply.code === 'rate_limited')
        return NextResponse.json(
          { error: 'Too many requests. Please try again later.' },
          {
            status: 429,
            headers: { 'Retry-After': String(reply.retryAfterSeconds) },
          },
        );
      return passwordCommandUnavailableResponse();
    }
    if (reply.mailPlan) {
      try {
        await sendVerificationEmail(reply.mailPlan.recipient, reply.mailPlan.token, mailOrigin);
      } catch {
        Sentry.captureException(new Error('Verification email delivery failed'), {
          tags: { area: 'auth', flow: 'resend-verification', phase: 'send-email' },
        });
      }
    }
    // The same public reply covers absent, verified, ambiguous and delivery
    // failure cases. SMTP is still unbounded; this does not prove equal timing.
    return NextResponse.json(
      { message: GENERIC_RESEND_VERIFICATION_MESSAGE },
      {
        status: 200,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  } catch {
    return passwordCommandUnavailableResponse();
  }
}
