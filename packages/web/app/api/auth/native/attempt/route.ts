import { NextRequest, NextResponse } from 'next/server';
import { issueNativeOAuthAttempt, NATIVE_OAUTH_ATTEMPT_COOKIE } from '@/app/lib/auth/native-oauth-transfer';

export async function POST(request: NextRequest) {
  if (request.headers.get('origin') !== request.nextUrl.origin) return new NextResponse(null, { status: 403 });
  let body: unknown;
  try {
    const rawBody = await request.text();
    if (rawBody.length > 1024) return new NextResponse(null, { status: 413 });
    body = JSON.parse(rawBody);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return new NextResponse(null, { status: 400 });
  const { attemptId, provider } = body as Record<string, unknown>;
  if (
    typeof attemptId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(attemptId) ||
    (provider !== 'apple' && provider !== 'google')
  )
    return new NextResponse(null, { status: 400 });
  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(NATIVE_OAUTH_ATTEMPT_COOKIE, issueNativeOAuthAttempt({ attemptId, provider }), {
    httpOnly: true,
    secure: request.nextUrl.protocol === 'https:',
    sameSite: 'lax',
    path: '/api/auth/native',
    maxAge: 120,
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
