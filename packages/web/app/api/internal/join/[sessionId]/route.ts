import { NextResponse } from 'next/server';
import { dbz } from '@/app/lib/db/db';
import { boardSessions } from '@/app/lib/db/schema';
import { eq } from 'drizzle-orm';
import { SessionIdSchema } from '@/app/lib/validation/session';
import { CLIMB_SESSION_COOKIE } from '@/app/lib/climb-session-cookie';
import { resolveRequestAttribution, trackServer } from '@/app/lib/analytics.server';

const DEFAULT_ANGLE = 40;

function ensureViewSegment(path: string): string {
  if (/\/(list|create)$/.test(path) || /\/(play|view)\/[^/]+$/.test(path)) {
    return path;
  }
  if (/\/\d+$/.test(path)) {
    return `${path}/list`;
  }
  return `${path}/${DEFAULT_ANGLE}/list`;
}

function getBaseUrl(request: Request): string {
  const headers = request.headers;
  const host = headers.get('host');

  if (process.env.NODE_ENV === 'development') {
    const forwardedHost = headers.get('x-forwarded-host');
    const forwardedProto = headers.get('x-forwarded-proto');
    if (forwardedHost) {
      const proto = forwardedProto?.split(',')[0].trim() ?? 'http';
      return `${proto}://${forwardedHost}`;
    }
  }

  if (host) {
    const url = new URL(request.url);
    return `${url.protocol}//${host}`;
  }

  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const baseUrl = getBaseUrl(request);

  const validationResult = SessionIdSchema.safeParse(sessionId);

  if (!validationResult.success) {
    return new NextResponse('Invalid session ID format', { status: 400 });
  }

  const validatedSessionId = validationResult.data;

  const session = await dbz
    .select({
      id: boardSessions.id,
      boardPath: boardSessions.boardPath,
    })
    .from(boardSessions)
    .where(eq(boardSessions.id, validatedSessionId))
    .limit(1);

  if (session.length === 0) {
    return new NextResponse('Session not found', { status: 404 });
  }

  const { boardPath } = session[0];
  const cleanPath = boardPath.replace(/^\/+/, '');
  const redirectPath = ensureViewSegment(cleanPath);

  const attribution = await resolveRequestAttribution(request);
  trackServer('Session Join Link Followed', {
    distinctId: attribution.distinctId,
    properties: {
      sessionId: validatedSessionId,
      boardPath,
      isAuthenticated: attribution.isAuthenticated,
    },
  });

  const response = NextResponse.redirect(`${baseUrl}/${redirectPath}`, 307);
  response.cookies.set(CLIMB_SESSION_COOKIE, validatedSessionId, {
    path: '/',
    sameSite: 'lax',
    maxAge: 86400,
  });

  return response;
}
