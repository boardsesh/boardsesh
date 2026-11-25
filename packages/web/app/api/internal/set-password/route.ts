import { setPasswordMode } from '@boardsesh/auth-protocol';
import { delegateSetPassword } from '@/app/lib/auth/set-password-command.server';
import { AuthBackendUnavailableError } from '@/app/lib/auth/password-command-client.server';
import { CredentialAuthorityUnavailable } from '@/app/lib/auth/credential-admission.server';
import { unavailableCredentialResponse } from '@/app/lib/auth/credential-admission-response.server';
import { getAdmittedServerSessionSnapshot } from '@/app/lib/auth/admitted-session.server';
import { requireExpectedViewer } from '@/app/lib/auth/expected-viewer.server';
import { type NextRequest, NextResponse } from 'next/server';
import { createPreEnforcementSetPasswordCommandClient } from '@/app/lib/auth/pre-enforcement-set-password-client.server';
import { cloudflareVouchedVisitorAddress } from '@/app/lib/auth/trusted-client-ip.server';
import { VIEWER_CHANGED_CODE, VIEWER_CHANGED_ERROR } from '@/app/lib/auth/expected-viewer';
import { z } from 'zod';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';

const setPasswordSchema = z
  .object({
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128, 'Password must be less than 128 characters'),
    confirmPassword: z.string(),
    expectedUserId: z.string().min(1).optional(),
    expectedAuthSessionId: z.string().min(1).max(1024).optional(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export async function POST(request: NextRequest) {
  try {
    // Validate mode before any legacy credential write; mirror-on cannot fall back.
    try {
      setPasswordMode(process.env);
    } catch {
      throw new AuthBackendUnavailableError();
    }
    const { session, legacyCredential } = await getAdmittedServerSessionSnapshot({ method: request.method });
    // In `legacy` mode nothing below compares the body's expected identity with
    // the cookie, so this is the only thing that stops a stale tab writing a
    // password to the account the cookie names now. The settings card, through
    // the www guard, is the one caller, so a missing header is refused.
    const viewerChanged = requireExpectedViewer(request, session, {
      route: '/api/internal/set-password',
      missing: 'reject',
    });
    if (viewerChanged) return viewerChanged;

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Rate limiting - 5 requests per minute per IP
    const clientIp = getClientIp(request);
    const ipRateLimit = checkRateLimit(`set-password:${clientIp}`, 5, 60_000);
    if (ipRateLimit.limited) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(ipRateLimit.retryAfterSeconds) },
        },
      );
    }

    // Also rate limit by user ID
    const userRateLimit = checkRateLimit(`set-password:user:${session.user.id}`, 5, 60_000);
    if (userRateLimit.limited) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(userRateLimit.retryAfterSeconds) },
        },
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // Validate input
    const validationResult = setPasswordSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json({ error: validationResult.error.issues[0].message }, { status: 400 });
    }

    const { password, confirmPassword, expectedUserId, expectedAuthSessionId } = validationResult.data;
    const delegated = await delegateSetPassword(
      request,
      password,
      confirmPassword,
      expectedUserId && expectedAuthSessionId
        ? { userId: expectedUserId, authSessionId: expectedAuthSessionId }
        : undefined,
    );
    if (delegated) return delegated;
    if (!legacyCredential) throw new AuthBackendUnavailableError();
    const reply = await createPreEnforcementSetPasswordCommandClient().setPassword(
      {
        credential: legacyCredential.credential,
        password,
        confirmPassword,
        viewer: {
          userId: session.user.id,
          authSessionId:
            typeof session.authSessionId === 'string' && session.authSessionId ? session.authSessionId : null,
        },
      },
      cloudflareVouchedVisitorAddress(request) ?? undefined,
    );
    if (reply.outcome === 'set')
      return NextResponse.json({
        message: 'Password set successfully. You can now log in with your email and password.',
      });
    if (reply.outcome === 'already_set') return NextResponse.json({ error: 'Password already set.' }, { status: 409 });
    if (reply.outcome === 'unauthenticated') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (reply.outcome === 'identity_changed')
      return NextResponse.json(
        { code: VIEWER_CHANGED_CODE, error: VIEWER_CHANGED_ERROR },
        { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
      );
    if (reply.outcome !== 'error') throw new AuthBackendUnavailableError();
    if (reply.code === 'rate_limited')
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(reply.retryAfterSeconds) } },
      );
    if (reply.code === 'rolled_back')
      return NextResponse.json({ error: 'An error occurred while setting the password' }, { status: 500 });
    throw new AuthBackendUnavailableError();
  } catch (error) {
    if (error instanceof AuthBackendUnavailableError)
      return NextResponse.json(
        { error: 'Service temporarily unavailable' },
        { status: 503, headers: { 'Retry-After': '1' } },
      );
    if (error instanceof CredentialAuthorityUnavailable) return unavailableCredentialResponse();
    console.error('Set password error:', error);
    return NextResponse.json({ error: 'An error occurred while setting the password' }, { status: 500 });
  }
}
