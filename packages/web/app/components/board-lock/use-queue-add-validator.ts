'use client';

import type { Climb } from '@/app/lib/types';

/**
 * Historical single-board validator. In multi-board queues, cross-board and
 * cross-layout adds are handled by the `QueueAddConfirmProvider` gate (see
 * `packages/web/app/components/queue-control/queue-add-confirm-context.tsx`),
 * which surfaces a confirmation dialog instead of silently rejecting.
 *
 * This hook is kept as a stable export so existing call sites continue to
 * compile, and to leave a hook shape we can tighten later if we decide to
 * re-introduce hard rejects for truly unrenderable climbs. The hold-ID
 * subset check still lives on in `canAddClimbToBoard` and is now only used
 * by the Bluetooth send path.
 */
export function useQueueAddValidator(): (climb: Climb) => boolean {
  return (_climb: Climb) => true;
}
