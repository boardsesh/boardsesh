// "Saved to Your boards · Undo" after climbing on a friend's board. The bind
// closes the boards modal, so the snackbar can't live on the screen that saved
// the board: the save is published here and the app chrome (drawer host)
// shows it on whatever tab the climber lands on.

import { useSyncExternalStore } from 'react';

export type SavedFriendBoard = {
  boardUuid: string;
  boardName: string;
  /** Changes on each save so the snackbar's timer resets and its entrance replays. */
  nonce: number;
};

let current: SavedFriendBoard | null = null;
let nextNonce = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** A friend's board just landed in Your boards: offer to take it back out. */
export function announceSavedFriendBoard(board: { uuid: string; name: string }): void {
  nextNonce += 1;
  current = { boardUuid: board.uuid, boardName: board.name, nonce: nextNonce };
  emit();
}

/** The snackbar timed out, was undone, or the account changed. */
export function clearSavedFriendBoard(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function getSavedFriendBoard(): SavedFriendBoard | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSavedFriendBoard(): SavedFriendBoard | null {
  return useSyncExternalStore(subscribe, getSavedFriendBoard, getSavedFriendBoard);
}
