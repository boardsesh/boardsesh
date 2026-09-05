export type NetworkPolicy = 'online';
export type NetworkRequestKind = 'backend' | 'catalog' | 'telemetry' | 'ota';

export class NetworkPolicyBlockedError extends Error {}

export function getNetworkPolicy(): NetworkPolicy {
  return 'online';
}

export function setNetworkPolicy(_policy: NetworkPolicy): void {}
export function subscribeNetworkPolicy(_listener: () => void): () => void {
  return () => {};
}
export function isNetworkAllowed(_kind: NetworkRequestKind): boolean {
  return true;
}
export function assertNetworkAllowed(_kind: NetworkRequestKind): void {}
export function applyAccessNetworkPolicy(_accessMode: 'account' | 'local', _workOffline = false): void {}
export function setAccountWorkOffline(_enabled: boolean): void {}
