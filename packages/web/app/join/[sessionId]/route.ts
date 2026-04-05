import { NextResponse } from 'next/server';
import { dbz } from '@/app/lib/db/db';
import { boardSessions } from '@/app/lib/db/schema';
import { eq } from 'drizzle-orm';
import { SessionIdSchema } from '@/app/lib/validation/session';
import { CLIMB_SESSION_COOKIE } from '@/app/lib/climb-session-cookie';

// Default angle to use when boardPath doesn't include one (for backward compatibility)
const DEFAULT_ANGLE = 40;

/**
 * Ensures the board path ends with a view segment (/list, /play/uuid, /view/slug, /create)
 * If not, appends /list to provide a good landing page for joined users.
 *
 * Handles three cases:
 * 1. Path already has view segment: /board/.../40/list → use as-is
 * 2. Path has angle but no view: /board/.../40 → append /list
 * 3. Old format without angle: /board/.../sets → append default angle and /list
 */
function ensureViewSegment(path: string): string {
  // Check if path already ends with a view segment
  if (/\/(list|create)$/.test(path) || /\/(play|view)\/[^/]+$/.test(path)) {
    return path;
  }

  // Check if path ends with an angle (a number)
  if (/\/\d+$/.test(path)) {
    // Has angle, just append /list
    return `${path}/list`;
  }

  // Old format without angle - append default angle and /list
  return `${path}/${DEFAULT_ANGLE}/list`;
}

function getBaseUrl(request: Request): string {
  const headers = request.headers;
  const forwardedHost = headers.get('x-forwarded-host');
  const forwardedProto = headers.get('x-forwarded-proto');
  const host = headers.get('host');

  if (forwardedHost) {
    const proto = forwardedProto?.split(',')[0].trim() ?? 'https';
    return `${proto}://${forwardedHost}`;
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

  // Validate session ID format using Zod
  const validationResult = SessionIdSchema.safeParse(sessionId);

  if (!validationResult.success) {
    // Redirect to an error page or return a simple error response
    return new NextResponse('Invalid session ID format', { status: 400 });
  }

  const validatedSessionId = validationResult.data;

  // Look up the session in the database
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

  // boardPath format: {board_name}/{layout_id}/{size_id}/{set_ids}[/{angle}][/list|/play/uuid]
  // Strip leading slashes to avoid creating protocol-relative URLs (//kilter/... → kilter as host)
  const cleanPath = boardPath.replace(/^\/+/, '');

  // Ensure the path ends with a view segment (/list) for a good user experience
  const redirectPath = ensureViewSegment(cleanPath);

  const response = NextResponse.redirect(`${baseUrl}/${redirectPath}`, 307);
  response.cookies.set(CLIMB_SESSION_COOKIE, validatedSessionId, {
    path: '/',
    sameSite: 'lax',
    maxAge: 86400,
  });

  return response;
}
