import type { NextRequest } from 'next/server';
import { routeReauthentication } from '@/app/lib/auth/reauthentication-route.server';

/** The two ends of the forced re-sign-in (#7596 B5e1); 404 with the mode unset. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ action: string }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  return routeReauthentication(request, (await context.params).action);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  return routeReauthentication(request, (await context.params).action);
}
