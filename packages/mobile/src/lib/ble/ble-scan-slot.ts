/**
 * Who holds ble-plx's one scan slot right now.
 *
 * react-native-ble-plx runs one scan at a time: `startDeviceScan` replaces a
 * running scan and `stopDeviceScan` stops whichever scan is running. Callers
 * that share the manager away from the board pickers (the Rogue timer, the
 * Spraywall LED controller) note their scan here, so one never stops the
 * other's scan and a Spraywall scan never starts over a running one.
 *
 * The board pickers and the quickstart scan do not register: they run on their
 * own screens and own the radio while open.
 */
let owner: symbol | null = null;

export function currentBleScanOwner(): symbol | null {
  return owner;
}

/** Record that `token` just started a scan (it replaced whatever ran before). */
export function noteBleScanStarted(token: symbol): void {
  owner = token;
}

/** True when `token` still holds the slot, so stopping the running scan is its call. Releases it. */
export function releaseBleScan(token: symbol): boolean {
  if (owner !== token) return false;
  owner = null;
  return true;
}
