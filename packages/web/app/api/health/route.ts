import { NextResponse } from 'next/server';
import { BUILD_RELEASE } from './build-release';

// Railway's healthcheck (see railway.web.toml) hits this on every deploy and
// periodically thereafter. It MUST stay dependency-free: no database, no
// backend/GraphQL calls, no Aurora proxying. A transient DB blip must not
// fail the deploy healthcheck or trigger a restart loop on an otherwise
// healthy web process.
export const dynamic = 'force-dynamic';

export type HealthResponse = {
  status: 'ok';
  deploymentId: string;
  release: string;
};

export async function GET() {
  // The Railway post-deploy smoke compares this immutable build identity with
  // the commit it just published. That keeps a healthy but unrelated origin —
  // or the previous container after a no-op redeploy — from satisfying the
  // cutover gate. The fallback keeps local and Vercel development useful.
  const response: HealthResponse = {
    status: 'ok',
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID?.trim() || 'unknown',
    release: BUILD_RELEASE,
  };

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
