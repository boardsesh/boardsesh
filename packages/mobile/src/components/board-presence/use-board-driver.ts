import { useContext, useEffect, useState } from 'react';
import { BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';

/** Holder is "idle" once nothing has changed on the wall for this long. */
const IDLE_THRESHOLD_MS = 15 * 60 * 1000;
/** Re-evaluate the idle threshold about once a minute — no ticking seconds. */
const IDLE_RECHECK_MS = 60 * 1000;

export type BoardDriver = {
  /** Null for an anonymous sender (renders a non-pressable "?" avatar). */
  userId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** True once the wall hasn't changed for IDLE_THRESHOLD_MS. */
  isIdle: boolean;
  /**
   * True when an active connection holder is on the board (someone's BLE-writing
   * now), vs identity recovered only from the last lit climb. The lightbulb pip
   * gates on this; the on-wall banner shows the lit climb's sender regardless.
   */
  isHeld: boolean;
  /** Epoch ms of the last send (current climb, else holder), or null if unknown. */
  lastSentAtMs: number | null;
};

/**
 * Resolves who lit the board from board presence. Identity comes from the
 * freshest current climb, falling back to the connection-holder record. Returns
 * null only when the wall is genuinely free (no current climb AND no holder).
 *
 * Note it does NOT require a holder: a climb stays lit ("on the wall") after its
 * sender stops being the active BLE writer, so on-wall surfaces still attribute
 * it to the sender via `currentClimb`. Callers that specifically mean "who's
 * connected right now" gate on `isHeld`.
 *
 * Reads the context directly (non-throwing) rather than via
 * `useBoardPresenceCurrent()`, which throws with no provider in scope — gorhom
 * portals the play drawer to a modal host, so a consumer can render outside the
 * provider subtree; degrade to "no driver" instead of crashing.
 */
export function useBoardDriver(): BoardDriver | null {
  const current = useContext(BoardPresenceCurrentContext);
  const holder = current?.holder ?? null;
  const currentClimb = current?.currentClimb ?? null;
  const [now, setNow] = useState(() => Date.now());

  const present = holder !== null || currentClimb !== null;
  useEffect(() => {
    if (!present) return;
    const interval = setInterval(() => setNow(Date.now()), IDLE_RECHECK_MS);
    return () => clearInterval(interval);
  }, [present]);

  if (!present) return null;

  const lastSentAtIso = currentClimb?.sentAt ?? holder?.lastSentAt ?? null;
  const lastSentAtMs = lastSentAtIso ? Date.parse(lastSentAtIso) : NaN;
  const isIdle = Number.isFinite(lastSentAtMs) && now - lastSentAtMs > IDLE_THRESHOLD_MS;

  return {
    userId: currentClimb?.sentByUserId ?? holder?.userId ?? null,
    displayName: currentClimb?.sentByDisplayName ?? holder?.displayName ?? null,
    avatarUrl: currentClimb?.sentByAvatarUrl ?? holder?.avatarUrl ?? null,
    isIdle,
    isHeld: holder !== null,
    lastSentAtMs: Number.isFinite(lastSentAtMs) ? lastSentAtMs : null,
  };
}
