import { type NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/app/lib/auth/rate-limiter';
import { resendVerificationWithCommand } from '@/app/lib/auth/email-verification-command.server';
import { passwordCommandUnavailableResponse } from '@/app/lib/auth/register-password-command.server';
import { trustedClientRateLimitKey } from '@/app/lib/auth/trusted-client-ip.server';

const MIN_RESPONSE_TIME_MS = 1500;

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  try {
    const clientIp = trustedClientRateLimitKey(request);
    const rateLimitResult = checkRateLimit(`resend-verification:${clientIp}`, 5, 60_000);
    if (rateLimitResult.limited) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(rateLimitResult.retryAfterSeconds) },
        },
      );
    }
    return await resendVerificationWithCommand(request);
  } catch {
    return passwordCommandUnavailableResponse();
  } finally {
    // Every response retains the released minimum, including RPC uncertainty.
    const remaining = MIN_RESPONSE_TIME_MS - (Date.now() - startTime);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}
