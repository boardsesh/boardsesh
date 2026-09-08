import { useSyncExternalStore } from 'react';
import { MEMORY_PROFILING_ENABLED } from './memory-profile';
export type MemoryBrowseControl = {
  commandId: string;
  action: 'scroll' | 'open';
  targetUuid: string;
  targetIndex: number;
};
// Only the current scalar command/result lives outside the real list. React owns
// the subscription callback; the store never stores an action closure or climb.
let command: MemoryBrowseControl | null = null;
let lastCommandId = '';
let result: 'complete' | 'waiting' | 'mismatch' = 'waiting';
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  if (!MEMORY_PROFILING_ENABLED) return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function snapshot() {
  return command;
}
export function useMemoryBrowseControl() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function applyMemoryBrowseControl(next: MemoryBrowseControl) {
  if (lastCommandId !== next.commandId) {
    lastCommandId = next.commandId;
    command = {
      commandId: next.commandId,
      action: next.action,
      targetUuid: next.targetUuid,
      targetIndex: next.targetIndex,
    };
    result = 'waiting';
    for (const listener of listeners) listener();
  }
  return result;
}
export function acknowledgeMemoryBrowseControl(commandId: string, next: 'complete' | 'mismatch') {
  if (command?.commandId !== commandId) return;
  result = next;
  command = null;
  for (const listener of listeners) listener();
}
