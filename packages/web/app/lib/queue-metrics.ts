import { track } from '@/app/lib/analytics';

export type QueueOperation =
  | 'setCurrentClimbQueueItem'
  | 'setCurrentClimb'
  | 'addToQueue'
  | 'removeFromQueue'
  | 'mirrorClimb'
  | 'setQueue'
  | 'replaceQueueItem'
  | 'setMyPick'
  | 'claimTurn'
  | 'yieldTurn';

export type QueueOperationMode = 'local' | 'party' | 'party-offline';

// Per-operation caps to ensure coverage of all operation types.
// With 6 operations, worst case is 30 events per session.
const MAX_EVENTS_PER_OPERATION = 5;
const operationEventCounts = new Map<QueueOperation, number>();

const MAX_ERROR_EVENTS = 10;
let errorEventCount = 0;

export function trackQueueOperation(operation: QueueOperation, durationMs: number, mode: QueueOperationMode) {
  const count = operationEventCounts.get(operation) ?? 0;
  if (count >= MAX_EVENTS_PER_OPERATION) return;
  operationEventCounts.set(operation, count + 1);

  track('Queue Operation', {
    operation,
    durationMs: Math.round(durationMs),
    mode,
  });
}

export function trackQueueOperationError(operation: QueueOperation, mode: QueueOperationMode) {
  if (errorEventCount >= MAX_ERROR_EVENTS) return;
  errorEventCount++;

  track('Queue Operation Error', {
    operation,
    mode,
  });
}
