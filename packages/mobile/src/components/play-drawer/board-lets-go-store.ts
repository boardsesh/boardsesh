import { useSyncExternalStore } from 'react';
import type { TFunction } from 'i18next';
import type { DriveModeTakenBy } from '@boardsesh/analytics';
import type { BoardConnectionHolder } from '@boardsesh/shared-schema';
import { shortCaptionName } from './track-label-text';

/**
 * The board let go mid-drive (board plan item 8): this phone's link dropped on
 * its own while it drove the wall, or another phone took the board. Said once
 * per drive end, with a warning buzz, one screen-reader line and this caption
 * on the player's top bar, beside the board art and never over it
 * (`use-board-lets-go.ts`).
 *
 * - `taken_named` — board presence names who has the board now: "Sam took the
 *   board". Anyone who isn't anonymous is named, crewmate or not (owner's rule).
 * - `taken` — another phone has it and presence can't name them: "Another phone
 *   has the board".
 * - `dropped` — no one took it: "Board disconnected · Put on board reconnects".
 *   The wall button offers Put on board already.
 */
export type LetsGoNotice = { kind: 'taken_named'; name: string } | { kind: 'taken' } | { kind: 'dropped' };

/**
 * How long a drop waits to hear who has the board before it says the board
 * only disconnected. A takeover reaches presence once the other phone's first
 * climb lights and its report lands: its connect, a write and a round trip,
 * usually a second or three after the box let go of this phone.
 */
export const LETS_GO_TAKER_WAIT_MS = 5_000;

/** How long the caption stays up. The link coming back or a new drive takes it down sooner. */
export const LETS_GO_NOTICE_MS = 10_000;

/**
 * Past this since the drop, nothing is said: the wait's timer ran this late
 * only because the app was suspended, and a buzz minutes after the drop
 * would be about nothing the climber can see. Drive Mode Ended still goes.
 */
export const LETS_GO_STALE_MS = 15_000;

/**
 * Who has the board now, if not this phone's climber, from the board-presence
 * holder. Null: no one else does, or presence can't tell yet.
 *
 * A holder counts only if it changed during the drive (`holderChangeSeq` past
 * `driveStartSeq`): one left over from before (a crewmate's stale hold) never
 * took anything. Where it could be this phone itself (the climber is signed
 * out and the holder anonymous, or the climber's own id isn't known yet), only
 * a change after the drop counts (`dropSeq`), since this phone holds nothing
 * after it. A holder with an account while the climber is signed out is never
 * this phone: a signed-out phone holds the board anonymously. The climber's
 * own account is never a taker, even on another device: presence knows
 * accounts, not phones.
 *
 * Every sequence here is presence's `lastHolderChangeSeq`, never its
 * `lastConnectionSeq`: a catch-up (the app coming back to the foreground, a
 * reconnect) moves the latter past every stats and history event it repaired
 * through even when it reads back the same holder, which would name a holder
 * who took nothing. A catch-up that reads a different holder does count.
 */
export function resolveLetsGoTaker({
  holder,
  holderChangeSeq,
  driveStartSeq,
  dropSeq,
  viewerUserId,
  signedIn,
}: {
  holder: BoardConnectionHolder | null;
  /** Presence's `lastHolderChangeSeq` now. */
  holderChangeSeq: number;
  /** Presence's `lastHolderChangeSeq` when the drive started. */
  driveStartSeq: number;
  /** Presence's `lastHolderChangeSeq` when the link dropped. */
  dropSeq: number;
  /** The signed-in climber's id, or null when signed out or not known yet. */
  viewerUserId: string | null;
  signedIn: boolean;
}): LetsGoNotice | null {
  if (!holder) return null;
  const holderUserId = holder.userId ?? null;
  if (holderUserId !== null && holderUserId === viewerUserId) return null;
  const surelySomeoneElse = holderUserId !== null ? viewerUserId !== null || !signedIn : signedIn;
  if (holderChangeSeq <= (surelySomeoneElse ? driveStartSeq : dropSeq)) return null;
  const name = holderUserId !== null ? holder.displayName?.trim() : undefined;
  return name ? { kind: 'taken_named', name } : { kind: 'taken' };
}

/** The notice as Drive Mode Ended's `takenBy`: null when no one took the board. */
export function takenByOf(notice: LetsGoNotice | null): DriveModeTakenBy | null {
  if (notice?.kind === 'taken_named') return 'named';
  if (notice?.kind === 'taken') return 'anonymous';
  return null;
}

/**
 * The notice's words. `short` cuts a long name for the one-line caption; the
 * screen reader hears it whole.
 */
export function formatLetsGo(notice: LetsGoNotice, t: TFunction<'session'>, { short = false } = {}): string {
  switch (notice.kind) {
    case 'taken_named':
      return t('playView.wallControl.boardTakenBy', { name: short ? shortCaptionName(notice.name) : notice.name });
    case 'taken':
      return t('playView.wallControl.boardTakenOtherPhone');
    case 'dropped':
      return t('playView.wallControl.boardDropped');
  }
}

let shown: LetsGoNotice | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Show the caption for {@link LETS_GO_NOTICE_MS}. */
export function showLetsGo(next: LetsGoNotice): void {
  if (clearTimer) clearTimeout(clearTimer);
  shown = next;
  emit();
  clearTimer = setTimeout(() => {
    clearTimer = null;
    shown = null;
    emit();
  }, LETS_GO_NOTICE_MS);
}

/** Take the caption down now: the link is back, a drive started, or the board changed. */
export function clearLetsGo(): void {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
  if (!shown) return;
  shown = null;
  emit();
}

export function getLetsGo(): LetsGoNotice | null {
  return shown;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = (): LetsGoNotice | null => shown;

/** The caption on screen, or null. */
export function useLetsGo(): LetsGoNotice | null {
  return useSyncExternalStore(subscribe, read, read);
}
