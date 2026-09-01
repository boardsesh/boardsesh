import { NextResponse } from 'next/server';

// Railway's healthcheck (see railway.web.toml) hits this on every deploy and
// periodically thereafter. It MUST stay dependency-free: no database, no
// backend/GraphQL calls, no Aurora proxying. A transient DB blip must not
// fail the deploy healthcheck or trigger a restart loop on an otherwise
// healthy web process.
export const dynamic = 'force-dynamic';

export type HealthResponse = {
  status: 'ok';
};

export async function GET() {
  const response: HealthResponse = { status: 'ok' };

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
