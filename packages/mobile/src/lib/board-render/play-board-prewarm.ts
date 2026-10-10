/**
 * Lets the climbs list start a climb's play-size board render at the tap.
 *
 * The play drawer cannot ask for its overlay until it has mounted, measured its
 * board box and worked out a render width — about 110ms after the tap on an
 * iPhone 13 Pro — and only then does the 25–40ms native render begin. The width
 * is the one input the list does not have, so the carousel records what it
 * measured here and the next tap on the same board can ask straight away. By the
 * time the drawer mounts, the overlay is an index hit and paints with the photo.
 *
 * Module state, no React: the carousel writes the width, the list writes the
 * tapped climb, and `PlayBoardPrewarmHost` is the one subscriber.
 */
import type { BoardName } from '@boardsesh/shared-schema';

export type PlayBoardScope = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

export type PlayBoardPrewarmTarget = PlayBoardScope & {
  frames: string;
  renderWidth: number;
};

const overlayWidthByBoard = new Map<string, number>();
const listeners = new Set<() => void>();
let prewarmTarget: PlayBoardPrewarmTarget | null = null;

function scopeKey({ boardName, layoutId, sizeId, setIds }: PlayBoardScope): string {
  return `${boardName}:${layoutId}:${sizeId}:${setIds}`;
}

/** Called by the play carousel once its board box is measured. */
export function rememberPlayOverlayWidth(scope: PlayBoardScope, renderWidth: number): void {
  overlayWidthByBoard.set(scopeKey(scope), renderWidth);
}

/**
 * Ask for `frames` to be rendered at play size. A no-op until the play drawer
 * has been opened on this board once this session: without a measured width any
 * render would land under a cache key the drawer never looks up.
 */
export function requestPlayBoardPrewarm(scope: PlayBoardScope, frames: string): void {
  const renderWidth = overlayWidthByBoard.get(scopeKey(scope));
  if (renderWidth === undefined || !frames) return;
  if (
    prewarmTarget?.frames === frames &&
    prewarmTarget.renderWidth === renderWidth &&
    scopeKey(prewarmTarget) === scopeKey(scope)
  ) {
    return;
  }
  prewarmTarget = { ...scope, frames, renderWidth };
  for (const listener of listeners) listener();
}

/**
 * The play board is up and has asked for its own render: the warm-up has done
 * its job. Dropping the target unmounts the hidden render, so a later theme or
 * board-look change is not answered with a play-size render nobody is opening.
 */
export function clearPlayBoardPrewarm(): void {
  if (prewarmTarget === null) return;
  prewarmTarget = null;
  for (const listener of listeners) listener();
}

export function getPlayBoardPrewarmTarget(): PlayBoardPrewarmTarget | null {
  return prewarmTarget;
}

export function subscribeToPlayBoardPrewarm(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget the measured widths and the pending target. */
export function _resetPlayBoardPrewarmForTests(): void {
  overlayWidthByBoard.clear();
  prewarmTarget = null;
}
