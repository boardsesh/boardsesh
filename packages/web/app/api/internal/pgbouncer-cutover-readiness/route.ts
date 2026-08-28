import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getDb, rowsFromResult } from '@/app/lib/db/db';
import { withReadDeadline } from '@/app/lib/db/read-deadline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0;

const TOKEN_ENV = 'PGBOUNCER_CUTOVER_SMOKE_TOKEN';
const PROBE_DB_TIMEOUT_MS = 5_000;
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Vary: 'Authorization',
};

function isAuthorized(request: Request): boolean {
  const configuredToken = process.env[TOKEN_ENV] ?? '';
  const expectedDigest = createHash('sha256').update(`Bearer ${configuredToken}`).digest();
  const presentedDigest = createHash('sha256')
    .update(request.headers.get('authorization') ?? '')
    .digest();
  const digestsMatch = timingSafeEqual(expectedDigest, presentedDigest);

  // Always do the same fixed-length comparison, including when the token is
  // unset. An empty configured token can never authorize `Bearer `.
  return configuredToken.length > 0 && digestsMatch;
}

/** An authenticated, uncached round trip through the web runtime's primary database pool. */
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false }, { status: 401, headers: NO_STORE_HEADERS });
  }

  try {
    const database = getDb();
    const queryResult = await withReadDeadline(
      'pgbouncer-cutover-readiness',
      database.execute(sql`select 1 as ready`),
      PROBE_DB_TIMEOUT_MS,
    );
    const [row] = rowsFromResult<{ ready: number }>(queryResult);
    if (Number(row?.ready) !== 1) throw new Error('unexpected readiness result');
    return NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
  } catch {
    // Never log the driver error object: it can carry host/user connection data.
    console.error('[pgbouncer-cutover-readiness] database probe failed');
    return NextResponse.json({ ok: false }, { status: 503, headers: NO_STORE_HEADERS });
  }
}
