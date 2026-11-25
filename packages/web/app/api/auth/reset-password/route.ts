import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';
import { consistentDelay } from '@/app/lib/auth/password-reset';
import { isVersionedPasswordRecoveryToken, passwordRecoveryTokenSchema } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError, webPasswordMode } from '@/app/lib/auth/password-command-client.server';
import {
  INVALID_PASSWORD_RESET_MESSAGE,
  passwordRecoveryUnavailableResponse,
  resetPasswordWithCommand,
} from '@/app/lib/auth/password-recovery-command.server';
import { withEmailVerificationPrivacy } from '@/app/lib/auth/email-verification-response.server';
import { stagedPasswordClientKey } from '@/app/lib/auth/trusted-client-ip.server';

const MIN_RESPONSE_TIME_MS = 1500;
export async function POST(request: NextRequest) {
  return withEmailVerificationPrivacy(await handleResetPassword(request));
}
async function handleResetPassword(request: NextRequest) {
  const startTime = Date.now();
  let usingBackend = false;
  try {
    const clientIp = stagedPasswordClientKey(request) ?? getClientIp(request);
    // Preserve the existing independent, per-instance public request limit.
    const rateLimitResult = checkRateLimit(`reset-password:${clientIp}`, 5, 60_000);
    if (rateLimitResult.limited) {
      await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(rateLimitResult.retryAfterSeconds) },
        },
      );
    }
    const mode = webPasswordMode();
    usingBackend = mode === 'backend-staging';
    const body: unknown = await request.json();
    usingBackend = true;
    const token: unknown = typeof body === 'object' && body !== null && 'token' in body ? body.token : undefined;
    // Reserve future capabilities before legacy UUID validation or any RPC/SQL.
    if (isVersionedPasswordRecoveryToken(token)) {
      if (typeof token !== 'string' || !/^pr1_/i.test(token)) {
        await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
        return passwordRecoveryUnavailableResponse();
      }
      if (!passwordRecoveryTokenSchema.safeParse(token).success) {
        await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
        return NextResponse.json({ error: INVALID_PASSWORD_RESET_MESSAGE }, { status: 400 });
      }
    }
    const response = await resetPasswordWithCommand(body, request, mode);
    await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
    return response;
  } catch (error) {
    await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
    if (usingBackend || error instanceof AuthBackendUnavailableError) return passwordRecoveryUnavailableResponse();
    // Malformed JSON retains its released 500 contract without echoing the body.
    console.error('Password reset request failed');
    return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 });
  }
}
