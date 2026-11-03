import { useSyncExternalStore } from 'react';
import type { TFunction } from 'i18next';
import { shortCaptionName } from './track-label-text';

/**
 * Relay mode (#7220): the relay path to the holder's phone was lost while
 * this phone drove or relayed through it. The #7234 "board let go" treatment
 * (`board-lets-go-store.ts`): one warning buzz, one screen-reader line, and
 * this caption on the player's top bar, beside the board art and never over
 * it (`use-relayed-drive.ts` says it).
 *
 * - `holder_left` — the holder's phone let go, dropped or left, or another
 *   phone took the board: "Sam's phone let go of the board · Put on board
 *   connects you". The next Put on board connects this phone.
 * - `unconfirmed` — a relayed climb didn't light in time, or the relay was
 *   refused: "Didn't reach the board through Sam's phone · Try again". The
 *   climb on screen stays a preview; nothing is retried.
 *
 * `name` is the holder under the board-holder privacy rule, or null for
 * "Someone on this board".
 */
export type RelayLostNotice = { kind: 'holder_left' | 'unconfirmed'; name: string | null };

/** How long the caption stays up. A relay that lands, a new drive or a link takes it down sooner. */
export const RELAY_LOST_NOTICE_MS = 10_000;

/** The notice's words. `short` cuts a long name for the one-line caption; the screen reader hears it whole. */
export function formatRelayLost(notice: RelayLostNotice, t: TFunction<'session'>, { short = false } = {}): string {
  const name = notice.name === null ? null : short ? shortCaptionName(notice.name) : notice.name;
  if (notice.kind === 'holder_left') {
    return name === null
      ? t('playView.wallControl.relayHolderLetGoAnonymous')
      : t('playView.wallControl.relayHolderLetGo', { name });
  }
  return name === null
    ? t('playView.wallControl.relayUnconfirmedAnonymous')
    : t('playView.wallControl.relayUnconfirmed', { name });
}

let shown: RelayLostNotice | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Show the caption for {@link RELAY_LOST_NOTICE_MS}. */
export function showRelayLost(next: RelayLostNotice): void {
  if (clearTimer) clearTimeout(clearTimer);
  shown = next;
  emit();
  clearTimer = setTimeout(() => {
    clearTimer = null;
    shown = null;
    emit();
  }, RELAY_LOST_NOTICE_MS);
}

/** Take the caption down now. */
export function clearRelayLost(): void {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
  if (!shown) return;
  shown = null;
  emit();
}

export function getRelayLost(): RelayLostNotice | null {
  return shown;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = (): RelayLostNotice | null => shown;

/** The caption on screen, or null. */
export function useRelayLost(): RelayLostNotice | null {
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Once per lost path: a path (board and holder) is said once until a relay
 * through it lights again. Not per pick, so a drive whose every pick fails
 * says it once.
 */
let saidForPath: string | null = null;

/** Whether the caller says the loss of `pathKey` now: true the first time until {@link markRelayPathBack}. */
export function claimRelayLostPath(pathKey: string): boolean {
  if (saidForPath === pathKey) return false;
  saidForPath = pathKey;
  return true;
}

/** A relay through `pathKey` lit: its next loss is said again. */
export function markRelayPathBack(pathKey: string): void {
  if (saidForPath === pathKey) saidForPath = null;
}

/** Tests only. */
export function resetRelayLostForTests(): void {
  clearRelayLost();
  saidForPath = null;
}
