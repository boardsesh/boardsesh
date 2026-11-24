import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { sendVerificationEmail } from '@boardsesh/email';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol/client-errors';
import { webPasswordMode, registrationMailOrigin } from './password-command-client.server';
import { createRegistrationCommandClient } from './registration-command-client.server';
import { cloudflareVouchedVisitorAddress } from './trusted-client-ip.server';

export function passwordCommandUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: AUTH_BACKEND_UNAVAILABLE },
    {
      status: 503,
      headers: { 'Cache-Control': 'private, no-store' },
    },
  );
}

export async function registerWithPasswordCommand(request: NextRequest): Promise<NextResponse> {
  try {
    // Validate mail destination configuration even when backend policy currently
    // disables verification. A flag change must never turn Host into authority.
    const mailOrigin = registrationMailOrigin(request.nextUrl.origin);
    const client = createRegistrationCommandClient({ clientAddress: cloudflareVouchedVisitorAddress(request) });
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return webPasswordMode() === 'legacy'
        ? NextResponse.json({ error: 'An error occurred during registration' }, { status: 500 })
        : passwordCommandUnavailableResponse();
    }
    const reply = await client.register(payload);
    if (reply.outcome === 'error') {
      if (reply.code === 'validation_error') return NextResponse.json({ error: reply.message }, { status: 400 });
      if (reply.code === 'exists')
        return NextResponse.json(
          {
            error: 'An account with this email already exists. Please sign in with your existing account.',
          },
          { status: 409 },
        );
      if (reply.code === 'rate_limited')
        return NextResponse.json(
          {
            error: 'Too many requests. Please try again later.',
          },
          { status: 429, headers: { 'Retry-After': String(reply.retryAfterSeconds) } },
        );
      return passwordCommandUnavailableResponse();
    }
    if (!reply.requiresVerification) {
      return NextResponse.json(
        { message: 'Account created. You can now log in.', requiresVerification: false },
        { status: 201 },
      );
    }
    let emailSent = false;
    try {
      await sendVerificationEmail(reply.mailPlan.recipient, reply.mailPlan.token, mailOrigin);
      emailSent = true;
    } catch {
      // SMTP exceptions may include the recipient or verification URL. Record a
      // fixed error only; the committed account remains available for resend.
      Sentry.captureException(new Error('Registration verification email delivery failed'), {
        tags: { area: 'auth', flow: 'register', phase: 'send-email' },
      });
    }
    // Deliberately project public fields. The private reply contains a token.
    return NextResponse.json(
      {
        message: emailSent
          ? 'Account created. Please check your email to verify your account.'
          : 'Account created. Please request a new verification email.',
        requiresVerification: true,
        emailSent,
      },
      { status: 201 },
    );
  } catch {
    return passwordCommandUnavailableResponse();
  }
}
