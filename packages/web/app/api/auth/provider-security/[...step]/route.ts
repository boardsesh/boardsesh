import type { NextRequest } from 'next/server';
import { routeProviderSecurity } from '@/app/lib/auth/provider-security-route.server';

/**
 * Provider link, unlink and reauthentication under
 * `AUTH_BROWSER_SESSION_MODE=better-auth` (#7596 B5e1). 404 with the mode
 * unset. See `provider-security-route.server.ts` and
 * docs/auth/better-auth-browser-session.md.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ step: string[] }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  return routeProviderSecurity(request, (await context.params).step);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  return routeProviderSecurity(request, (await context.params).step);
}
