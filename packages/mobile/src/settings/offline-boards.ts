import { useMemo } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { offlineBoardKey, offlineBoardKeyForBoard, type OfflineBoardScope } from '@boardsesh/offline-sync';
import { getSetting, setSetting, useSetting } from './hooks';
import { isOfflineBoardCard, readOfflineBoardCards } from '../lib/boards/offline-board-card';

/**
 * Remembered board identities for the offline picker.
 *
 * `syncEnabledBoards` records WHICH SCOPES are downloaded, and that is all it can
 * record: a scope key is `"boardType:layoutId:sizeId"`, which is shared by every one
 * of the user's boards on that layout+size ("Marco's garage" and "Gym wall" on the
 * same Kilter Original 12x12 share ONE download — see `storage-board-label.ts`). It
 * carries no `uuid`, `name`, `setIds` or `angle`, so it cannot name a board, and
 * `uuid` in particular is server-issued: `setActiveBoard`, `BoardProvider`, the BLE
 * wrapper and the board-presence subscription all key on it, so it can never be
 * synthesised.
 *
 * So the board list is snapshotted at the moment offline is enabled — data the app
 * already holds in hand — and kept as a flat list deduped by `uuid`, not a
 * scope-keyed map (a map would silently hide one of two boards sharing a scope).
 *
 * Reads go through `isOfflineBoardCard`, so a card written by an older build with a
 * shape `UserBoard` no longer matches is dropped rather than rendered wrong.
 */

const SETTING_KEY = 'offlineBoardsV1';

/**
 * Plenty of headroom: the realistic maximum is a handful of boards (a home wall,
 * a couple of gyms). The cap only exists so a long-lived install can't grow the
 * MMKV value without bound.
 */
const MAX_REMEMBERED_BOARDS = 20;

export function getOfflineBoards(): UserBoard[] {
  return readOfflineBoardCards(getSetting(SETTING_KEY));
}

/** Reactive read. Re-renders when boards are remembered or forgotten. */
export function useOfflineBoards(): UserBoard[] {
  const [stored] = useSetting(SETTING_KEY);
  // `useSetting`'s snapshot is reference-stable between writes, so this memo only
  // re-filters when the stored value actually changed.
  return useMemo(() => readOfflineBoardCards(stored), [stored]);
}

/**
 * Snapshot `boards` so the offline picker can name them. Upserts by `uuid`,
 * most-recent-first.
 *
 * Skips the write when the result is byte-identical to what is already stored:
 * every settings write calls `emitChange()`, which clears the whole per-key
 * snapshot cache and re-renders every `useSetting` consumer app-wide. This runs on
 * each successful `myBoards` fetch, so a no-op refresh must stay a no-op.
 *
 * The comparison is `JSON.stringify`, so it is key-order sensitive. That is the safe
 * direction to be wrong in: reordered fields on the wire cost one redundant write
 * (and the stored bytes really did change), never a missed update.
 */
export function rememberOfflineBoards(boards: readonly UserBoard[]): void {
  const incoming = boards.filter(isOfflineBoardCard);
  // Nothing usable to add: this is an ADD-only call, so it never empties the list.
  // Forgetting is `forgetOfflineBoardScope` (per scope) or `clearOfflineBoards` (all),
  // which keeps a refetch that momentarily returns nothing from wiping the picker.
  if (incoming.length === 0) return;
  const current = getOfflineBoards();
  const incomingUuids = new Set(incoming.map((board) => board.uuid));
  const next = [...incoming, ...current.filter((card) => !incomingUuids.has(card.uuid))].slice(
    0,
    MAX_REMEMBERED_BOARDS,
  );
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  setSetting(SETTING_KEY, next);
}

/**
 * Forget every card in `scope`. Plural by design: a download is per scope, so
 * turning one off removes the data behind every board sharing it — leaving the
 * sibling card would offer a board whose climbs are gone.
 */
export function forgetOfflineBoardScope(scope: OfflineBoardScope): void {
  const key = offlineBoardKey(scope);
  const current = getOfflineBoards();
  const next = current.filter((card) => offlineBoardKeyForBoard(card) !== key);
  if (next.length === current.length) return;
  setSetting(SETTING_KEY, next);
}

/** Forget one board by `uuid`. Used when the server no longer has it (delete, unfollow). */
export function forgetOfflineBoard(uuid: string): void {
  const current = getOfflineBoards();
  const next = current.filter((card) => card.uuid !== uuid);
  if (next.length === current.length) return;
  setSetting(SETTING_KEY, next);
}

/**
 * Drop every card whose board is absent from `knownUuids`.
 *
 * Only ever called with a COMPLETE server board list (`myBoards` with `hasMore`
 * false). Without this, a board deleted or unfollowed on another device keeps its
 * card forever: nothing else clears it, because a plain toggle-off leaves the
 * downloaded rows in place and `forgetOfflineBoardScope` is keyed on the scope, not
 * the board. A dead card is worse than a stale row — activating it writes a `uuid`
 * the backend no longer knows into `active-board-store`, which is exactly the
 * board-presence poisoning this feature refuses to risk with synthetic uuids.
 */
export function pruneOfflineBoards(knownUuids: readonly string[]): void {
  const known = new Set(knownUuids);
  const current = getOfflineBoards();
  const next = current.filter((card) => known.has(card.uuid));
  if (next.length === current.length) return;
  setSetting(SETTING_KEY, next);
}

/**
 * Drop every card. Used at the sign-out boundary (see `auth-provider`).
 *
 * The early-out reads the RAW stored value, not `getOfflineBoards()`: a stored value
 * that is corrupt or fails the shape guard reads as empty but is still bytes on disk,
 * and sign-out has to clear those too.
 */
export function clearOfflineBoards(): void {
  const stored = getSetting(SETTING_KEY);
  if (Array.isArray(stored) && stored.length === 0) return;
  setSetting(SETTING_KEY, []);
}

// --- Download-trigger attribution (issue #4316) --------------------------------

const TRIGGER_SETTING_KEY = 'offlineDownloadTriggers';

/**
 * Why a board's download was started. The split that matters is DELIBERATE vs
 * AUTOMATIC — #4318's discovery nudges are measured against the deliberate taps,
 * and lumping a settings-driven re-enable in with a real tap under a name that
 * asserts a tap happened would make that measurement meaningless.
 *
 * - `toggle` — the My Boards per-row switch. A tap.
 * - `download-all` — the "download all my boards" switch in More. A tap.
 * - `auto-download-all` — the mount effect acting on the persisted
 *   `autoOfflineBoards` setting. NOT a tap.
 * - `adopt-auto` — a discovered board adopted because `autoOfflineBoards` is on.
 *   NOT a tap.
 * - `adopt-confirmed` — a discovered board the climber confirmed in the dialog.
 * - `retry` — a manual re-run of a failed download.
 * - `onboarding` — the download offered while the climber binds their board
 *   during first-run onboarding. A tap, but its own bucket: it is the only one
 *   taken before the climber has used the app at all, so folding it into
 *   `toggle` would hide whether the offer lands at the moment it is made.
 * - `unknown` — no attribution recorded: a scope enabled by a build that predates
 *   this, or one whose entry was already consumed. An explicit, expected value.
 */
export type OfflineDownloadTrigger =
  | 'toggle'
  | 'download-all'
  | 'auto-download-all'
  | 'adopt-auto'
  | 'adopt-confirmed'
  | 'retry'
  | 'onboarding'
  | 'unknown';

const KNOWN_TRIGGERS: readonly OfflineDownloadTrigger[] = [
  'toggle',
  'download-all',
  'auto-download-all',
  'adopt-auto',
  'adopt-confirmed',
  'retry',
  'onboarding',
  'unknown',
];

function readTriggers(): Record<string, string> {
  const stored = getSetting(TRIGGER_SETTING_KEY);
  // A value written by a build with a different shape reads as empty rather than
  // poisoning the event with garbage.
  return stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/**
 * Record why `scopeKey`'s download is starting. Overwrites any earlier
 * un-consumed entry: the most recent intent is the truthful one (a climber who
 * toggles a board off and back on chose it deliberately the second time too).
 */
export function rememberDownloadTrigger(scopeKey: string, trigger: OfflineDownloadTrigger): void {
  const current = readTriggers();
  if (current[scopeKey] === trigger) return;
  setSetting(TRIGGER_SETTING_KEY, { ...current, [scopeKey]: trigger });
}

/**
 * Read and PRUNE `scopeKey`'s trigger. Consuming it is what keeps the store
 * bounded — one entry lives from the enable until the download actually starts,
 * which is the whole span the attribution is for.
 *
 * Returns `'unknown'` when there is no entry, or when the stored string isn't a
 * trigger this build knows (a value written by a newer build after a downgrade).
 */
export function takeDownloadTrigger(scopeKey: string): OfflineDownloadTrigger {
  const current = readTriggers();
  const stored = current[scopeKey];
  if (stored === undefined) return 'unknown';
  const { [scopeKey]: _consumed, ...rest } = current;
  setSetting(TRIGGER_SETTING_KEY, rest);
  return KNOWN_TRIGGERS.includes(stored as OfflineDownloadTrigger) ? (stored as OfflineDownloadTrigger) : 'unknown';
}

/** Drop `scopeKey`'s pending attribution — the board was removed before it downloaded. */
export function forgetDownloadTrigger(scopeKey: string): void {
  const current = readTriggers();
  if (!(scopeKey in current)) return;
  const { [scopeKey]: _removed, ...rest } = current;
  setSetting(TRIGGER_SETTING_KEY, rest);
}

const DOWNLOAD_ALL_TAP_SETTING_KEY = 'offlineDownloadAllTapPending';

/**
 * Arm the "download all my boards" attribution. The tap flips a persisted
 * setting, but the enable it causes runs from a mount effect once `myBoards`
 * resolves — which can be a different mount, or a different app launch, if the
 * list is still in flight when the climber leaves the screen. Held in the same
 * store as the per-scope triggers for the same reason: an in-memory ref loses
 * exactly the case the split exists to measure, and every enable that ran
 * without it would be filed as automatic.
 */
export function rememberDownloadAllTap(): void {
  if (getSetting(DOWNLOAD_ALL_TAP_SETTING_KEY) === true) return;
  setSetting(DOWNLOAD_ALL_TAP_SETTING_KEY, true);
}

/**
 * Read and CLEAR the pending download-all tap. One tap attributes one batch:
 * leaving it armed would let the next automatic enable on that screen inherit a
 * tap that had already been spent.
 */
export function takeDownloadAllTap(): boolean {
  if (getSetting(DOWNLOAD_ALL_TAP_SETTING_KEY) !== true) return false;
  setSetting(DOWNLOAD_ALL_TAP_SETTING_KEY, false);
  return true;
}

/** Disarm without consuming — the climber turned the switch back off. */
export function forgetDownloadAllTap(): void {
  if (getSetting(DOWNLOAD_ALL_TAP_SETTING_KEY) !== true) return;
  setSetting(DOWNLOAD_ALL_TAP_SETTING_KEY, false);
}
