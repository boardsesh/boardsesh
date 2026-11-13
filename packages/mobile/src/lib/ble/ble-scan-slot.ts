/** ble-plx has one process-wide scan. Only its current owner may stop it. */
let owner: symbol | null = null;
export const currentBleScanOwner = (): symbol | null => owner;
export function noteBleScanStarted(token: symbol): void {
  owner = token;
}
export function claimBleScan(token: symbol): boolean {
  if (owner !== null && owner !== token) return false;
  owner = token;
  return true;
}
export function releaseBleScan(token: symbol): boolean {
  if (owner !== token) return false;
  owner = null;
  return true;
}
