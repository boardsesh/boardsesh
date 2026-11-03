import type { MoonboardLinkMode } from '@boardsesh/board-config';
import type { BoardConnectionHolder } from '@boardsesh/shared-schema';

/**
 * Relay mode (#7220): who this phone lights the wall through, if anyone.
 *
 * An original MoonBoard controller takes one phone and stops advertising
 * while it is connected. A second phone that tried to connect would scan for
 * 15 s and find nothing, so on a Relay mode board every phone that isn't the
 * holder sends its climbs to the holder's phone over the backend instead.
 * This is the one rule that decides it, shared by the bulb, the wall button,
 * the drive and the lost-path notices. Mobile only: www has no Bluetooth.
 */

/**
 * A holder whose last send is older than this is idle (the board-presence
 * display rule, `docs/board-connection-holder.md`): its phone is probably in a
 * pocket or gone, so Put on board connects as it does today instead of
 * relaying into silence.
 */
export const RELAY_HOLDER_IDLE_MS = 15 * 60_000;

export type RelayHolderInput = {
  /** The `moonboard-relay-mode` flag (`useMoonboardRelayModeEnabled`). */
  flagEnabled: boolean;
  /** The bound board's type ('moonboard', 'kilter', ...). */
  boardType: string | null;
  /** The board's effective link mode (`resolveMoonboardLinkMode`), null off a MoonBoard. */
  linkMode: MoonboardLinkMode | null;
  /** Board presence's holder. */
  holder: BoardConnectionHolder | null;
  /** This phone's own Bluetooth link is up. */
  localConnected: boolean;
  /** The party session, or null solo. */
  sessionId: string | null;
  /** Members of that session. */
  sessionMemberUserIds: ReadonlySet<string>;
  /**
   * The relay path to this holder was lost and presence hasn't moved since
   * (`relay-path-store.ts`): the server said no one holds the board while
   * presence still names someone. Put on board connects then.
   */
  suppressed: boolean;
  now: number;
};

/** Whether presence's holder is idle at `now` (no send for {@link RELAY_HOLDER_IDLE_MS}). */
export function isRelayHolderIdle(holder: BoardConnectionHolder, now: number): boolean {
  if (!holder.lastSentAt) return false;
  const lastSentAt = Date.parse(holder.lastSentAt);
  if (Number.isNaN(lastSentAt)) return false;
  return now - lastSentAt > RELAY_HOLDER_IDLE_MS;
}

/**
 * The holder this phone relays through, or null to keep today's behaviour.
 * First match wins:
 *
 * 1. The flag is off, the board isn't a MoonBoard in Relay mode, or this
 *    phone's own link is up: null.
 * 2. No holder: null. Any holder while this phone has no link is another
 *    phone, the climber's own second device included: the server keys a hold
 *    on the connection, not the account. A stale hold of this phone's own
 *    answers `SELF_HOLDER`, and the path is suppressed.
 * 3. The holder is a member of this phone's crew session: null. The crew's
 *    shared queue stays the channel there (`holderIsAuthoritative`).
 * 4. The path to this holder was lost, or the holder is idle: null.
 * 5. Otherwise that holder.
 */
export function relayHolderFor(input: RelayHolderInput): BoardConnectionHolder | null {
  if (!input.flagEnabled) return null;
  if (input.boardType !== 'moonboard' || input.linkMode !== 'relay') return null;
  if (input.localConnected) return null;
  const holder = input.holder;
  if (!holder) return null;
  const holderUserId = holder.userId ?? null;
  if (input.sessionId !== null && holderUserId !== null && input.sessionMemberUserIds.has(holderUserId)) return null;
  if (input.suppressed) return null;
  if (isRelayHolderIdle(holder, input.now)) return null;
  return holder;
}

/**
 * A holder's identity for "is it still the same phone": the account, or
 * `anon` for an anonymous holder. Two anonymous holders read as the same, as
 * presence's own holder-change rule reads them.
 */
export function relayHolderKeyOf(holder: BoardConnectionHolder | null): string | null {
  if (!holder) return null;
  return holder.userId ? `user:${holder.userId}` : 'anon';
}

/**
 * The holder's name for a notice, under the board-holder privacy rule: the
 * server sends a name only for a holder whose profile isn't anonymous. Null
 * means "Someone on this board".
 */
export function relayHolderNameOf(holder: BoardConnectionHolder | null): string | null {
  if (!holder?.userId) return null;
  const name = holder.displayName?.trim();
  return name ? name : null;
}

/**
 * Why a relayed drive ends because of the holder, or null while it holds.
 * A change of holder counts only if presence saw it after the drive started
 * (`holderChangeSeq` past `startSeq`, presence's `lastHolderChangeSeq`): the
 * #7234 rule, so a change older than the drive (a late catch-up of it) ends
 * nothing.
 *
 * - `holder_left`: no one holds the board now.
 * - `holder_changed`: a different phone holds it.
 */
export function resolveRelayedDriveHolderExit({
  startHolderKey,
  startSeq,
  holder,
  holderChangeSeq,
}: {
  /** `relayHolderKeyOf` the holder the drive started on. */
  startHolderKey: string;
  /** Presence's `lastHolderChangeSeq` when the drive started. */
  startSeq: number;
  holder: BoardConnectionHolder | null;
  holderChangeSeq: number;
}): 'holder_left' | 'holder_changed' | null {
  if (holderChangeSeq <= startSeq) return null;
  const key = relayHolderKeyOf(holder);
  if (key === null) return 'holder_left';
  return key === startHolderKey ? null : 'holder_changed';
}
