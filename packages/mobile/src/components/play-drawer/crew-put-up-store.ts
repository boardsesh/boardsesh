import { useSyncExternalStore } from 'react';
import type { TFunction } from 'i18next';
import type { ClimbQueueItem } from '@boardsesh/queue';

/**
 * "Your crew put up Crimp Ladder" (#7113): while this phone drives the wall, a
 * crewmate's Put on the wall goes up on it (this phone's auto-sender lights the
 * session's current climb), and the player follows. This line says so, for 4 s,
 * where "Only you see this" sits. In memory only, like the drive itself.
 */
export const CREW_PUT_UP_NOTICE_MS = 4_000;

export type CrewPutUpNotice = {
  climbName: string;
  /** Privacy-projected mover name, or null when their identity cannot be resolved. */
  personName: string | null;
  /** The queue item it made current: the line belongs to that climb. */
  queueItemUuid: string;
};

/**
 * The line for the climb a crewmate made current. The caller resolves the
 * server-stamped mover through the session roster; queue authorship never names
 * the person who put it up.
 */
export function resolveCrewPutUp(
  item: ClimbQueueItem | null,
  personName: string | null = null,
): CrewPutUpNotice | null {
  if (!item?.climb) return null;
  return { climbName: item.climb.name, queueItemUuid: item.uuid, personName: personName?.trim() || null };
}

export function formatCrewPutUp(notice: CrewPutUpNotice, t: TFunction<'session'>): string {
  if (notice.personName) {
    return t('playView.wallControl.crewPutUpNamed', { person: notice.personName, climb: notice.climbName });
  }
  return t('playView.wallControl.crewPutUp', { climb: notice.climbName });
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
