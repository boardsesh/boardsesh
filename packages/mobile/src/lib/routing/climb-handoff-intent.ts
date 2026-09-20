import { randomUUID } from 'expo-crypto';
import { toBoardPath, type BoardRouteTarget } from './board-route-target';

const INTENT_LIFETIME_MS = 60_000;
let pendingIntent: { id: string; targetKey: string; expiresAt: number } | null = null;

function climbTargetKey(target: BoardRouteTarget | null): string | null {
  return target?.kind === 'climb' ? `${toBoardPath(target)}#${target.climbUuid}` : null;
}

/** Only a frames-less tick tap can create this short-lived, in-memory handoff. */
export function createClimbHandoffIntent(target: BoardRouteTarget): string | undefined {
  const targetKey = climbTargetKey(target);
  if (!targetKey) return undefined;
  const id = randomUUID();
  pendingIntent = { id, targetKey, expiresAt: Date.now() + INTENT_LIFETIME_MS };
  return id;
}

/** A query parameter alone never grants activation; consume only at the drawer handoff. */
export function consumeClimbHandoffIntent(id: unknown, target: BoardRouteTarget | null): boolean {
  if (!pendingIntent) return false;
  if (Date.now() >= pendingIntent.expiresAt) {
    pendingIntent = null;
    return false;
  }
  if (typeof id !== 'string' || id !== pendingIntent.id) return false;
  const intent = pendingIntent;
  pendingIntent = null;
  return intent.targetKey === climbTargetKey(target);
}
