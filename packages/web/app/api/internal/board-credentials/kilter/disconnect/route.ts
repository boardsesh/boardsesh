import { getServerSession } from 'next-auth/next';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import * as Sentry from '@sentry/nextjs';
import { decrypt } from '@boardsesh/crypto';
import { KILTER_BOARD_TYPE, revokeRefreshToken } from '@boardsesh/kilter-sync/api';
import { authOptions } from '@/app/lib/auth/auth-options';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';

const KILTER_OAUTH_CLIENT_ID = process.env.KILTER_OAUTH_CLIENT_ID;
const KILTER_OAUTH_CLIENT_SECRET = process.env.KILTER_OAUTH_CLIENT_SECRET;

/**
 * POST /api/internal/board-credentials/kilter/disconnect — delete the user's stored kilter
 * credential + board mapping. Leaves boardsesh_ticks and other downstream
 * rows in place (their kilter_id surrogate keys go stale but the natural
 * key on (user, climb, angle, climbed_at) still uniquely identifies them).
 *
 * We revoke the refresh_token at Keycloak BEFORE deleting the local row
 * so that even with a leaked encrypted token (pg_dump, backup, Sentry
 * payload, …) the attacker can't mint fresh access tokens after
 * disconnect. Revocation failure does not block local cleanup — a
 * Keycloak outage must not leave a dangling credential row in our DB.
 *
 * However: revocation failure IS surfaced to the caller. We return HTTP
 * 207 (Multi-Status) with `{ success: false, localCleared: true,
 * reason: 'revocation_failed' }` so the UI can warn the user that the
 * Keycloak side may still hold a live session. The user can then
 * manually expire it via the Kilter portal. Without this signal, a
 * disconnect that silently leaves a live refresh token at the IdP gives
 * the user a false sense of completeness.
 */
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();

  // 1. SELECT the existing encrypted refresh token before we delete it.
  const credentialRows = await db
    .select({ encryptedRefreshToken: schema.auroraCredentials.encryptedRefreshToken })
    .from(schema.auroraCredentials)
    .where(
      and(
        eq(schema.auroraCredentials.userId, session.user.id),
        eq(schema.auroraCredentials.boardType, KILTER_BOARD_TYPE),
      ),
    )
    .limit(1);

  // 2. Decrypt + revoke via Keycloak. Wrapped in try/catch so a
  // decrypt/network failure on Keycloak doesn't strand the local row.
  // `revocationFailed` flips to true on ANY failure path so the
  // response correctly signals "local cleanup happened, IdP side may
  // still be live."
  let revocationFailed = false;
  const encryptedRefreshToken = credentialRows[0]?.encryptedRefreshToken;
  if (encryptedRefreshToken && KILTER_OAUTH_CLIENT_ID) {
    try {
      const refreshToken = decrypt(encryptedRefreshToken);
      await revokeRefreshToken(
        refreshToken,
        {
          clientId: KILTER_OAUTH_CLIENT_ID,
          clientSecret: KILTER_OAUTH_CLIENT_SECRET,
        },
        {
          onError: (err) => {
            revocationFailed = true;
            Sentry.captureException(err, {
              tags: { route: 'auth/kilter/disconnect', step: 'revoke' },
              user: { id: session.user.id },
            });
          },
        },
      );
    } catch (err) {
      revocationFailed = true;
      Sentry.captureException(err, {
        tags: { route: 'auth/kilter/disconnect', step: 'decrypt-or-revoke' },
        user: { id: session.user.id },
      });
    }
  }

  // 3. Delete local rows regardless of revocation outcome — both
  // tables together in a single transaction so a transient failure on
  // the second delete cannot leave aurora_credentials gone but the
  // mapping row still around. An orphan user_board_mappings would
  // confuse any UI/query joining on it and the daemon wouldn't pick
  // it up to clean up (no credential row to drive a re-sync).
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.auroraCredentials)
      .where(
        and(
          eq(schema.auroraCredentials.userId, session.user.id),
          eq(schema.auroraCredentials.boardType, KILTER_BOARD_TYPE),
        ),
      );
    await tx
      .delete(schema.userBoardMappings)
      .where(
        and(
          eq(schema.userBoardMappings.userId, session.user.id),
          eq(schema.userBoardMappings.boardType, KILTER_BOARD_TYPE),
        ),
      );
  });

  if (revocationFailed) {
    return NextResponse.json({ success: false, localCleared: true, reason: 'revocation_failed' }, { status: 207 });
  }
  return NextResponse.json({ success: true });
}
