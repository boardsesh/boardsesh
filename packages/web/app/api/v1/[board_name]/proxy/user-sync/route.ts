// app/api/[board]/sync/route.ts
import { syncUserData } from '@/app/lib/data-sync/aurora/user-sync';
import { getSession } from '@/app/lib/session';
import { cookies } from 'next/headers';
import { isAuroraBoardName } from '@/app/lib/board-constants';
import { resolveRequestAttribution, safeErrorKind, trackServer } from '@/app/lib/analytics.server';

export async function POST(request: Request) {
  const { board_name } = await request.json();

  const attribution = await resolveRequestAttribution(request);

  if (!isAuroraBoardName(board_name)) {
    trackServer('Aurora Sync Failed', {
      distinctId: attribution.distinctId,
      properties: { trigger: 'manual', errorKind: 'invalid_board' },
    });
    return new Response(JSON.stringify({ error: 'Unsupported board for this endpoint' }), { status: 400 });
  }

  const startedAt = performance.now();
  trackServer('Aurora Sync Started', {
    distinctId: attribution.distinctId,
    properties: { boardName: board_name, trigger: 'manual' },
  });

  try {
    const cookieStore = await cookies();
    const session = await getSession(cookieStore, board_name);
    if (!session) {
      throw new Error('401: Unauthorized');
    }
    const { token, userId } = session;
    await syncUserData(board_name, token, userId);
    trackServer('Aurora Sync Succeeded', {
      distinctId: attribution.distinctId,
      properties: {
        boardName: board_name,
        trigger: 'manual',
        latencyMs: Math.round(performance.now() - startedAt),
      },
    });
    return new Response(JSON.stringify({ success: true, message: 'All tables synced' }), {
      status: 200,
    });
  } catch (err) {
    console.error('Failed to sync with Aurora:', err);
    trackServer('Aurora Sync Failed', {
      distinctId: attribution.distinctId,
      properties: {
        boardName: board_name,
        trigger: 'manual',
        latencyMs: Math.round(performance.now() - startedAt),
        errorKind: safeErrorKind(err),
      },
    });
    //@ts-expect-error Eh cant be bothered fixing this now
    return new Response(JSON.stringify({ error: 'Sync failed', details: err.message }), {
      status: 500,
    });
  }
}
