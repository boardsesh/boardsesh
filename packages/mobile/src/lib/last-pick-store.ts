import { useSyncExternalStore } from 'react';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource, SetCurrentClimbOptions } from '@boardsesh/queue';
import type { BoardConfig } from '../components/play-drawer/play-drawer-types';
import { getCredentialGeneration } from './privacy/privacy-cache';

/**
 * The climber's last pick (owner decision A, 2026-11-02): the climb they most
 * recently opened in the player, a preview included, so the MiniPlayer (the
 * iOS bottom accessory, the JS queue bar, the tablet and Duo bar) can keep
 * showing it after the player closes, and reopen it as the same preview with
 * its list.
 *
 * The bar shows this pick, or the queue's current climb when THAT changes
 * after the pick (a Put on board, a crewmate's put-up, the Lock Screen's or the
 * notification's Next / Previous, the rest timer's auto-advance), whichever
 * happened last. So a pick carries the current climb it was made under, and
 * stops counting the moment the queue's current is another one
 * (`resolveBarPick`), before `LastPickWatcher` has even cleared it.
 *
 * The Lock Screen / Live Activity, the Climbs header's wall capsule and the
 * board history sheet never read this: they show the wall.
 *
 * In memory only, like the player's own preview: a relaunch starts from the
 * queue's current. Cleared on sign-out or an account change (the credential
 * generation, read here and by the watcher), on a change of board, and when
 * the queue's current changes (`LastPickWatcher`), except for the change the
 * cold-start queue restore makes: the pick is carried over that one. The one
 * writer is the player (`use-last-pick-writer.ts`); the bar's own Mirror flips it.
 */
export type LastPick = {
  /** The climb as the player showed it: a queue slot, a list's peek, or a fresh item. */
  item: ClimbQueueItem;
  /** The list it was walking, so Next and Previous (the player's or the bar's) go on along it. */
  suggestionSource: PlaylistSuggestionSource | null;
  /** The slot's deferred commit (Replay from here, a History row), applied only by Put on board. */
  commitOptions: SetCurrentClimbOptions | undefined;
  /** The player's own mirror flip on the preview. */
  mirrored: boolean;
  /**
   * The board the player drew it on, when that wasn't the stored active board
   * (a logbook, session or profile row opens on its own board and angle), so
   * the bar reopens it there. Absent or null on the active board.
   */
  boardConfig?: BoardConfig | null;
  /** The queue's current item (its uuid) when the pick was made: another one ends the pick. */
  currentAtPick: string | null;
  /**
   * The climb lit on the wall when the climber started looking, for the
   * busy-wall question when the bar's bulb puts the pick up later.
   */
  wallAtPick: string | null;
  /** When the climber started looking (this phone's clock), for the same question. */
  pickedAt: number;
  /** The signed-in account it belongs to (`getCredentialGeneration`). */
  generation: number;
};

export type LastPickInput = Omit<LastPick, 'generation'>;

let pick: LastPick | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function sameBoard(left: BoardConfig | null | undefined, right: BoardConfig | null | undefined): boolean {
  if (!left || !right) return !left && !right;
  return (
    left.boardName === right.boardName &&
    left.layoutId === right.layoutId &&
    left.sizeId === right.sizeId &&
    left.setIds === right.setIds &&
    left.angle === right.angle
  );
}

function samePick(left: LastPick | null, right: LastPick | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.item === right.item &&
    left.suggestionSource === right.suggestionSource &&
    left.commitOptions === right.commitOptions &&
    left.mirrored === right.mirrored &&
    sameBoard(left.boardConfig, right.boardConfig) &&
    left.currentAtPick === right.currentAtPick &&
    left.wallAtPick === right.wallAtPick &&
    left.pickedAt === right.pickedAt &&
    left.generation === right.generation
  );
}

/** Record the climber's latest pick. The same pick again changes nothing, so the bar doesn't re-render. */
export function setLastPick(input: LastPickInput): void {
  const next: LastPick = { ...input, generation: getCredentialGeneration() };
  if (samePick(pick, next)) return;
  pick = next;
  emit();
}

/** The bar's Mirror on a pick: the flip the player shows when it reopens. */
export function setLastPickMirrored(mirrored: boolean): void {
  if (!pick || pick.mirrored === mirrored) return;
  pick = { ...pick, mirrored };
  emit();
}

/**
 * The queue's cold-start restore landed (`LastPickWatcher`). A pick made while
 * the saved queue was still loading (from a notification or a link) was made
 * under no current climb. The restore is not a change after the pick, so the
 * pick now counts as made under the restored current and the bar keeps it.
 * A pick made under any other current is left as it is.
 */
export function carryLastPickOverRestore(currentBefore: string | null, restoredCurrent: string | null): void {
  if (!pick || currentBefore === restoredCurrent || pick.currentAtPick !== currentBefore) return;
  pick = { ...pick, currentAtPick: restoredCurrent };
  emit();
}

/** The pick is over: the bar shows the queue's current climb. */
export function clearLastPick(): void {
  if (!pick) return;
  pick = null;
  emit();
}

/** The pick as stored, for a reader outside React. Null once another account signed in. */
export function getLastPick(): LastPick | null {
  return pick && pick.generation === getCredentialGeneration() ? pick : null;
}

/** Listen for any change of the stored pick (`useSyncExternalStore`'s subscribe). */
export function subscribeToLastPick(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const readPick = (): LastPick | null => pick;

/**
 * Whether a pick is stored at all, whoever's it is. The account watcher
 * (`LastPickWatcher`) clears another account's pick, so this is what tells a
 * cleared store from a hidden one.
 */
export function hasStoredLastPick(): boolean {
  return pick !== null;
}

/** The stored pick. Re-renders only when it changes (a new pick, its mirror, or its end). */
export function useLastPick(): LastPick | null {
  return useSyncExternalStore(subscribeToLastPick, readPick, readPick);
}

/** Presence only: flips when a pick starts or ends, never from one pick to the next. */
export function useHasLastPick(): boolean {
  return useSyncExternalStore(subscribeToLastPick, hasStoredLastPick, hasStoredLastPick);
}

/**
 * The pick the bar shows, or null when it shows the queue's current climb:
 * - no pick, or one from another account;
 * - the queue's current changed after the pick (`currentAtPick`), which the
 *   watcher clears a commit later;
 * - the pick IS the current slot (nothing to preview).
 */
export function resolveBarPick(
  stored: LastPick | null,
  currentItemUuid: string | null,
  generation: number = getCredentialGeneration(),
): LastPick | null {
  if (!stored || stored.generation !== generation) return null;
  if (stored.currentAtPick !== currentItemUuid) return null;
  if (stored.item.uuid === currentItemUuid) return null;
  return stored;
}

/**
 * What the player needs to reopen a pick as the same preview: its item, its
 * list, the slot's deferred commit, the mirror flip, the board it was drawn on
 * (when that wasn't the active board), and the wall as it was when the climber
 * started looking (for the busy-wall question).
 */
export function lastPickOpenOptions(stored: LastPick): {
  previewQueueItem: ClimbQueueItem;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  previewCommitOptions?: SetCurrentClimbOptions;
  previewMirrored: boolean;
  previewLatchStart: { wallClimbUuid: string | null; at: number };
  boardConfig?: BoardConfig;
} {
  return {
    previewQueueItem: stored.item,
    playlistSuggestionSource: stored.suggestionSource,
    ...(stored.commitOptions ? { previewCommitOptions: stored.commitOptions } : {}),
    ...(stored.boardConfig ? { boardConfig: stored.boardConfig } : {}),
    previewMirrored: stored.mirrored,
    previewLatchStart: { wallClimbUuid: stored.wallAtPick, at: stored.pickedAt },
  };
}

/** The pick's climb as the bar draws it: the player's mirror flip applied. */
export function lastPickClimb(stored: LastPick): Climb {
  const climb = stored.item.climb;
  return (climb.mirrored === true) === stored.mirrored ? climb : { ...climb, mirrored: stored.mirrored };
}

/** Tests only. */
export function resetLastPickForTests(): void {
  pick = null;
  listeners.clear();
}
