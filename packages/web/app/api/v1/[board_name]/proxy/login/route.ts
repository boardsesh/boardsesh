import { dbz } from '@/app/lib/db/db';
import { boardUsers } from '@/app/lib/db/schema';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import AuroraClimbingClient from '@/app/lib/api-wrappers/aurora-rest-client/aurora-rest-client';
import type { BoardOnlyRouteParameters } from '@/app/lib/types';
import { syncUserData } from '@/app/lib/data-sync/aurora/user-sync';
import type { Session } from '@/app/lib/api-wrappers/aurora-rest-client/types';
import type { AuroraBoardName } from '@/app/lib/api-wrappers/aurora/types';
import { getSession } from '@/app/lib/session';
import { isAuroraBoardName } from '@/app/lib/board-constants';
import { flushServerAnalytics, resolveRequestAttribution, trackServer } from '@/app/lib/analytics.server';

// Input validation schema
const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * Performs login for a specific climbing board
 * @param board - The name of the climbing board
 * @param username - User's username
 * @param password - User's password
 * @returns Login response from the board's API
 */
async function login(boardName: AuroraBoardName, username: string, password: string): Promise<Session> {
  const auroraClient = new AuroraClimbingClient({ boardName: boardName });
  const loginResponse = await auroraClient.signIn(username, password);

  if (!loginResponse.token || !loginResponse.user_id) {
    throw new Error('Invalid login response: missing token or user_id');
  }

  if (loginResponse.user_id) {
    // Insert/update user in our database - handle missing user object
    const createdAt = loginResponse.user?.created_at
      ? new Date(loginResponse.user.created_at).toISOString()
      : new Date().toISOString();

    await dbz
      .insert(boardUsers)
      .values({
        boardType: boardName,
        id: loginResponse.user_id,
        username: loginResponse.username || username,
        createdAt,
      })
      .onConflictDoUpdate({
        target: [boardUsers.boardType, boardUsers.id],
        set: { username: loginResponse.username || username },
      });

    // If it's a new user, perform full sync
    try {
      await syncUserData(boardName, loginResponse.token, loginResponse.user_id);
    } catch (error) {
      console.error('Initial sync error:', error);
      // We don't throw here as login was successful
    }
  }

  // Convert LoginResponse to Session
  return {
    token: loginResponse.token,
    user_id: loginResponse.user_id,
  };
}

/**
 * Route handler for login POST requests
 * @param request - Incoming HTTP request
 * @param props - Route parameters
 * @returns NextResponse with login results or error
 */
export async function POST(request: Request, props: { params: Promise<BoardOnlyRouteParameters> }) {
  const params = await props.params;

  // Only kilter and tension use Aurora APIs
  if (!isAuroraBoardName(params.board_name)) {
    return NextResponse.json({ error: 'Unsupported board for this endpoint' }, { status: 400 });
  }

  const board_name = params.board_name as AuroraBoardName;
  const attribution = await resolveRequestAttribution(request);

  try {
    // Parse and validate request body
    const body = await request.json();
    const validatedData = loginSchema.parse(body);

    // Call the board API
    const loginResponse = await login(board_name, validatedData.username, validatedData.password);

    const response = NextResponse.json(loginResponse);

    const session = await getSession(response.cookies, board_name);
    session.token = loginResponse.token;
    session.username = validatedData.username;
    session.userId = loginResponse.user_id;
    await session.save();

    trackServer('Aurora Login Succeeded', {
      distinctId: attribution.distinctId,
      properties: { boardName: board_name },
    });
    await flushServerAnalytics();

    return response;
  } catch (error) {
    // Compute response + errorKind without awaiting analytics, then track and
    // flush exactly once before returning so an already-failing request
    // doesn't pay multiple analytics round-trips.
    let response: NextResponse;
    let errorKind: string;

    if (error instanceof z.ZodError) {
      console.error('Login validation error:', error.issues);
      errorKind = 'validation';
      response = NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    } else if (error instanceof Error && error.message.includes('401')) {
      errorKind = 'invalid_credentials';
      response = NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    } else if (error instanceof Error && error.message.includes('403')) {
      errorKind = 'forbidden';
      response = NextResponse.json({ error: 'Access forbidden' }, { status: 403 });
    } else if (error instanceof Error && error.message.startsWith('HTTP error!')) {
      errorKind = 'service_unavailable';
      response = NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
    } else {
      console.error('Login error:', error);
      errorKind = 'unknown';
      response = NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    trackServer('Aurora Login Failed', {
      distinctId: attribution.distinctId,
      properties: { boardName: board_name, errorKind },
    });
    await flushServerAnalytics();
    return response;
  }
}
