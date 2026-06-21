import { eq } from 'drizzle-orm';
import { activityPushTokens } from '@boardsesh/db/schema/app';
import { db } from '../db/client';

export type WidgetAuthResult =
  | { kind: 'ok'; userId: string | null }
  | { kind: 'missing' }
  | { kind: 'unknown' }
  | { kind: 'wrong-session'; boundSessionId: string; userId: string | null };

/**
 * Verify that the bearer token in the Authorization header is registered to
 * `sessionId` in `activity_push_tokens`. This is the auth contract the iOS
 * widget honors: the widget reads its APNs Live Activity push token and sends
 * it as a Bearer header.
 *
 * Distinguishes "token unknown" from "token bound to a different session" so
 * the widget can trigger push-token re-registration on 410 responses.
 */
export async function authenticateWidget(authHeader: string | undefined, sessionId: string): Promise<WidgetAuthResult> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return { kind: 'missing' };
  const bearer = authHeader.slice(7).trim();
  if (!bearer) return { kind: 'missing' };

  const rows = await db
    .select({ sessionId: activityPushTokens.sessionId, userId: activityPushTokens.userId })
    .from(activityPushTokens)
    .where(eq(activityPushTokens.token, bearer))
    .limit(1);

  if (rows.length === 0) return { kind: 'unknown' };
  const boundSessionId = rows[0].sessionId;
  const userId = rows[0].userId ?? null;
  if (boundSessionId !== sessionId) return { kind: 'wrong-session', boundSessionId, userId };
  return { kind: 'ok', userId };
}
