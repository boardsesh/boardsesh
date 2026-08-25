import type { QueueItemUser } from '@boardsesh/queue';

/** What a queue row needs to draw the "who queued this" face. */
export type QueueRowAttribution = {
  name: string;
  avatarUrl: string | null;
};

export type QueueRowAttributionOptions = {
  /** False outside a party session — no faces at all. */
  showAddedBy: boolean;
  /** The viewer's own party-profile id; their own adds render nothing. */
  viewerUserId: string | null;
};

/**
 * Decide whether a queue row shows who put the climb up, and with what.
 *
 * `null` means render NO element at all — not an empty slot. An `Avatar` with
 * neither a uri nor a name draws a `?` glyph on a primary-coloured disc
 * (`components/Avatar.tsx`), which is exactly the broken-looking placeholder
 * this feature is meant to avoid.
 *
 * The result deliberately DROPS `addedByUser.id`. A queue row is a live
 * gesture arena (row tap, swipe-to-delete, drag handle, tick button), so a
 * nested navigating Pressable would need the same explicit
 * `blocksExternalGesture` wiring the tick button carries. v1 is decorative and
 * non-interactive; profile navigation is a follow-up.
 *
 * `avatarUrl` is normalised from `string | null | undefined` down to
 * `string | null` because `QueueItemUser.avatarUrl` is both optional and
 * nullable.
 */
export function resolveQueueRowAttribution(
  addedByUser: QueueItemUser | null | undefined,
  { showAddedBy, viewerUserId }: QueueRowAttributionOptions,
): QueueRowAttribution | null {
  if (!showAddedBy) return null;
  if (!addedByUser) return null;
  // Self-exclusion: the queue provider stamps SOLO adds with this device's own
  // identity too, so without this a one-person session would put the viewer's
  // own face on every row they queued.
  if (viewerUserId != null && addedByUser.id === viewerUserId) return null;
  // Defensive `typeof`, not a bare `.trim()`: the type says `string`, but the
  // value arrives straight off an unvalidated subscription payload.
  const name = typeof addedByUser.username === 'string' ? addedByUser.username.trim() : '';
  if (name === '') return null;
  return { name, avatarUrl: addedByUser.avatarUrl ?? null };
}
