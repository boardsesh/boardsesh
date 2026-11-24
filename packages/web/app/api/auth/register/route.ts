import { type NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/app/lib/auth/rate-limiter';
import {
  passwordCommandUnavailableResponse,
  registerWithPasswordCommand,
} from '@/app/lib/auth/register-password-command.server';
import { trustedClientRateLimitKey } from '@/app/lib/auth/trusted-client-ip.server';

export async function POST(request: NextRequest) {
  try {
    const clientIp = trustedClientRateLimitKey(request);
    const rateLimitResult = checkRateLimit(`register:${clientIp}`, 10, 60_000);
    if (rateLimitResult.limited) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(rateLimitResult.retryAfterSeconds) },
        },
      );
    }
    return await registerWithPasswordCommand(request);
  } catch {
    return passwordCommandUnavailableResponse();
  }
}
