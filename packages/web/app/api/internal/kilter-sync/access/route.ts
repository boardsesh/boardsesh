import { getServerSession } from 'next-auth/next';
import { NextResponse } from 'next/server';
import { authOptions } from '@/app/lib/auth/auth-options';
import { isKilterSyncAllowed } from '@/app/lib/kilter-sync/access';

/**
 * GET /api/internal/kilter-sync/access — tiny endpoint the Settings card
 * hits to decide whether to render the "Connect Kilter account" button.
 * Returns `{ allowed: false }` for any unauthenticated request or any
 * user not on the env-var allowlist.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ allowed: false });
  }
  const allowed = await isKilterSyncAllowed(session.user.id);
  return NextResponse.json({ allowed });
}
