import { NextResponse } from 'next/server';
import { gql } from 'graphql-request';
import { parseNamedBoardPath } from '@boardsesh/board-config';
import { dbz } from '@/app/lib/db/db';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { boardSessions, userBoards } from '@/app/lib/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
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

const SESSION_BOARD_PATH = gql`
  query JoinRedirectSessionBoardPath($sessionId: ID!) {
    session(sessionId: $sessionId) {
      boardPath
    }
  }
`;

/**
 * The stored path as this visitor may see it. A named path (`/b/<slug>`) names
 * its wall, and a session can sit on a wall the visitor may not see, so it goes
 * through the backend's `session` read, which projects it per viewer exactly as
 * `joinSession` and the app's join screen get it: the wall's geometry for
 * someone the wall is not named to. Redirecting to the raw row handed any
 * holder of a session id the slug of a private wall (#7013). A positional path
 * names no wall and is used as stored.
 *
 * When the backend gives nothing back (a dormant session with an empty live
 * roster, which `session` answers with null, or an unreachable backend), the
 * visitor still lands on the wall: by its geometry, built here the same way the
 * backend projects it, so the slug never leaves. Null only when no live board
 * holds the slug; the caller then sends them home.
 */
async function visibleBoardPath(sessionId: string, storedPath: string): Promise<string | null> {
  const named = parseNamedBoardPath(storedPath);
  if (!named) return storedPath;
  try {
    const response = await executeAuthenticatedGraphQL<{ session: { boardPath: string } | null }>(
      SESSION_BOARD_PATH,
      { sessionId },
      await getServerAuthToken(),
    );
    if (response.session?.boardPath) return response.session.boardPath;
  } catch (error) {
    console.error(`[/api/internal/join] could not read session ${sessionId}'s board path:`, error);
  }
  const [board] = await dbz
    .select({
      boardType: userBoards.boardType,
      layoutId: userBoards.layoutId,
      sizeId: userBoards.sizeId,
      setIds: userBoards.setIds,
      angle: userBoards.angle,
    })
    .from(userBoards)
    .where(and(eq(userBoards.slug, named.slug), isNull(userBoards.deletedAt)))
    .limit(1);
  if (!board) return null;
  return `/${board.boardType}/${board.layoutId}/${board.sizeId}/${board.setIds}/${named.angle ?? board.angle}`;
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

  // A null boardPath means an inferred session — reconstructed from tick timing
  // rather than started by anyone (see docs/inferred-sessions.md). There is no wall
  // to join and no board to land on, so it is "not found" as far as joining goes.
  if (session.length === 0 || session[0].boardPath === null) {
    return new NextResponse('Session not found', { status: 404 });
  }

  const boardPath = await visibleBoardPath(validatedSessionId, session[0].boardPath);
  const cleanPath = boardPath?.replace(/^\/+/, '') ?? '';
  const redirectPath = boardPath ? ensureViewSegment(cleanPath) : null;

  if (!redirectPath) {
    // Either the named wall's path could not be read for this visitor (logged
    // above), or the stored boardPath doesn't carry an angle segment — almost
    // certainly a malformed row. Don't fabricate /40/ as we did before (that
    // silently landed every joiner on 40° regardless of what the session was
    // actually running at). Bail to the home page so the user can at least
    // browse and rejoin via a healthier link.
    if (boardPath) {
      console.error(
        `[/api/internal/join] session ${validatedSessionId} has malformed boardPath (no angle): ${boardPath}`,
      );
    }
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
