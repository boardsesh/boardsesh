import type { SessionUser } from '@boardsesh/shared-schema';
import type { SessionUser as GeneratedSessionUser } from '@boardsesh/shared-schema/generated';
import { upsertRuntimeSessionUser } from '@boardsesh/queue-runtime';

// Re-export pure queue utilities from the shared package — the web app used to
// have its own copies; now it delegates to the single implementation.
export { insertQueueItemIdempotent, evaluateQueueEventSequence } from '@boardsesh/queue';
export type { QueueSequenceDecision } from '@boardsesh/queue';

/**
 * Normalize a SessionUser coming off the wire (generated GraphQL type, where
 * nullable fields are `Maybe<T>` = `T | null | undefined`) into the local
 * SessionUser shape (where `avatarUrl?: string` and `userId?: string | null`).
 * Used by reducers that ingest subscription events.
 */
export function coerceSessionUser(user: GeneratedSessionUser): SessionUser {
  return {
    id: user.id,
    username: user.username,
    isLeader: user.isLeader,
    avatarUrl: user.avatarUrl ?? undefined,
    userId: user.userId ?? null,
    connectionState: user.connectionState,
  };
}

export function upsertSessionUser(users: SessionUser[], user: SessionUser): SessionUser[] {
  return upsertRuntimeSessionUser(users, user);
}
