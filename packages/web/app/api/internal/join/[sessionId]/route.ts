import { NextResponse } from 'next/server';
import { dbz } from '@/app/lib/db/db';
import { boardSessions } from '@/app/lib/db/schema';
import { eq } from 'drizzle-orm';
import { SessionIdSchema } from '@/app/lib/validation/session';
import { CLIMB_SESSION_COOKIE } from '@/app/lib/climb-session-cookie';

/**
 * Add a view segment (/list, /play/{uuid}, /view/{uuid}, /create) to a
 * stored boardPath when it doesn't already carry one. Returns `null`
 * when the stored boardPath has no angle segment — every modern session
 * is created with a pathname that includes /{angle}/, so a missing angle
 * means the row is malformed and we'd rather fail loudly than fabricate
 * a default that lights the wrong stats view for the joining user
 * (group-session feedback fix — removed the silent `/40/list` pad).
 */
function ensureViewSegment(path: string): string | null {
  if (/\/(list|create)$/.test(path) || /\/(play|view)\/[^/]+$/.test(path)) {
    return path;
  }
  if (/\/-?\d+$/.test(path)) {
    return `${path}/list`;
  }
  return null;
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

  if (!redirectPath) {
    // The stored boardPath doesn't carry an angle segment — almost certainly
    // a malformed row. Don't fabricate /40/ as we did before (that silently
    // landed every joiner on 40° regardless of what the session was actually
    // running at). Log and bail to the home page so the user can at least
    // browse and rejoin via a healthier link.
    console.error(
      `[/api/internal/join] session ${validatedSessionId} has malformed boardPath (no angle): ${boardPath}`,
    );
    const response = NextResponse.redirect(`${baseUrl}/`, 307);
    response.cookies.set(CLIMB_SESSION_COOKIE, validatedSessionId, {
      path: '/',
      sameSite: 'lax',
      maxAge: 86400,
    });
    return response;
  }

  const response = NextResponse.redirect(`${baseUrl}/${redirectPath}`, 307);
  response.cookies.set(CLIMB_SESSION_COOKIE, validatedSessionId, {
    path: '/',
    sameSite: 'lax',
    maxAge: 86400,
  });

  return response;
}
