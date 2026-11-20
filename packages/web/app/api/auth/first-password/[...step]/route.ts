import type { NextRequest } from 'next/server';
import { routeFirstPassword } from '@/app/lib/auth/first-password-route.server';

/**
 * First password for accounts without one (a Google or Apple identity) under `AUTH_BROWSER_SESSION_MODE=better-auth`
 * (#7596 B5e2). 404 with the mode unset. See `first-password-route.server.ts`
 * and docs/auth/better-auth-browser-session.md.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ step: string[] }> };

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  return routeFirstPassword(request, (await context.params).step);
}
