import { useSyncExternalStore } from 'react';
import type { TFunction } from 'i18next';
import type { ClimbQueueItem } from '@boardsesh/queue';

/**
 * "Sam put up Crimp Ladder" (#7113): while this phone drives the wall, a
 * crewmate's Put on the wall goes up on it (this phone's auto-sender lights the
 * session's current climb), and the player follows. This line says who, for 4 s,
 * where "Only you see this" sits. In memory only, like the drive itself.
 */
export const CREW_PUT_UP_NOTICE_MS = 4_000;

export type CrewPutUpNotice = {
  /** The crewmate who put it up, or null when the queue can't say (then "Someone"). */
  holderName: string | null;
  climbName: string;
  /** The queue item it made current: the line belongs to that climb. */
  queueItemUuid: string;
};

/**
 * Who put the climb up, read the way the busy-wall question reads it: the
 * queue item's picker, never this climber (a step onto a climb this climber
 * queued earlier says "Someone"), and never an unknown viewer.
 */
export function resolveCrewPutUp({
  item,
  viewerUserId,
}: {
  item: ClimbQueueItem | null;
  viewerUserId: string | null;
}): CrewPutUpNotice | null {
  if (!item?.climb) return null;
  const picker = item.addedByUser ?? null;
  const holderName = picker !== null && viewerUserId !== null && picker.id !== viewerUserId ? picker.username : null;
  return { holderName, climbName: item.climb.name, queueItemUuid: item.uuid };
}

export function formatCrewPutUp(notice: CrewPutUpNotice, t: TFunction<'session'>): string {
  return notice.holderName
    ? t('playView.wallControl.crewPutUp', { name: notice.holderName, climb: notice.climbName })
    : t('playView.wallControl.crewPutUpSomeone', { climb: notice.climbName });
}

let notice: CrewPutUpNotice | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Show the line for `CREW_PUT_UP_NOTICE_MS`; a newer one replaces it and restarts the clock. */
export function showCrewPutUp(next: CrewPutUpNotice): void {
  if (clearTimer) clearTimeout(clearTimer);
  notice = next;
  emit();
  clearTimer = setTimeout(() => {
    clearTimer = null;
    notice = null;
    emit();
  }, CREW_PUT_UP_NOTICE_MS);
}

/** Drop the line now: the drive ended. */
export function clearCrewPutUp(): void {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
  if (!notice) return;
  notice = null;
  emit();
}

export function getCrewPutUp(): CrewPutUpNotice | null {
  return notice;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = (): CrewPutUpNotice | null => notice;

/** The line on screen, or null. */
export function useCrewPutUp(): CrewPutUpNotice | null {
  return useSyncExternalStore(subscribe, read, read);
}
