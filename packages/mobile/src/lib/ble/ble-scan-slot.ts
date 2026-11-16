/**
 * ble-plx has one process-wide scan. Only its current owner may stop it.
 *
 * A scan nobody asked for (the board picker's in-range slot, which scans by
 * itself on open) claims the slot as pre-emptible: any other claim or start
 * takes it straight away, so the rest timer's connect, a WLED scan or the
 * advertisement recon never fail as "busy" behind it. The pre-empted owner
 * hears about it through `onPreempted`, synchronously and before the new owner
 * starts its own scan.
 */
type BleScanOwner = { token: symbol; onPreempted: (() => void) | null };

let owner: BleScanOwner | null = null;

export const currentBleScanOwner = (): symbol | null => owner?.token ?? null;

export type PreemptibleBleScanClaim = {
  preemptible: true;
  /**
   * Another scan has taken the slot and is about to start. Stop this owner's
   * own ble-plx scan here (`getBleManager().stopDeviceScan()`): the slot is
   * already the new owner's, so `releaseBleScan` no longer stops it, and
   * ble-plx keeps an old scan's listener alive when a new scan starts over it.
   */
  onPreempted: () => void;
};

function takeSlot(token: symbol, onPreempted: (() => void) | null): void {
  const previous = owner;
  owner = { token, onPreempted };
  if (!previous || previous.token === token || !previous.onPreempted) return;
  try {
    previous.onPreempted();
  } catch {
    // The old owner's cleanup must never stop the new owner's scan.
  }
}

/** Take the slot unconditionally, for a scan the climber asked for. A pre-emptible owner is told. */
export function noteBleScanStarted(token: symbol): void {
  takeSlot(token, null);
}

/**
 * Take the slot if it is free or held by a pre-emptible owner (which is told).
 * A pre-emptible claim takes only a free slot: two scans nobody asked for never
 * take it from each other.
 */
export function claimBleScan(token: symbol, preemptible?: PreemptibleBleScanClaim): boolean {
  if (owner !== null && owner.token !== token && (!owner.onPreempted || preemptible)) return false;
  takeSlot(token, preemptible?.onPreempted ?? null);
  return true;
}

export function releaseBleScan(token: symbol): boolean {
  if (owner?.token !== token) return false;
  owner = null;
  return true;
}
