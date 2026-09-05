export type NetworkPolicy = 'online' | 'account-offline' | 'local-catalog-only';
export type NetworkRequestKind = 'backend' | 'catalog' | 'telemetry' | 'ota';

export class NetworkPolicyBlockedError extends Error {
  readonly kind: NetworkRequestKind;
  readonly policy: NetworkPolicy;

  constructor(kind: NetworkRequestKind, policy: NetworkPolicy) {
    super(`${kind} network access is disabled by ${policy} mode`);
    this.name = 'NetworkPolicyBlockedError';
    this.kind = kind;
    this.policy = policy;
  }
}

// Start closed. AuthProvider applies the persisted access/settings state before
// rendering its children, so import-time work cannot race the selected mode.
let currentPolicy: NetworkPolicy = 'account-offline';
const listeners = new Set<() => void>();

export function getNetworkPolicy(): NetworkPolicy {
  return currentPolicy;
}

export function setNetworkPolicy(policy: NetworkPolicy): void {
  if (policy === currentPolicy) return;
  currentPolicy = policy;
  for (const listener of listeners) listener();
}

export function subscribeNetworkPolicy(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isNetworkAllowed(kind: NetworkRequestKind): boolean {
  if (currentPolicy === 'online') return true;
  return currentPolicy === 'local-catalog-only' && kind === 'catalog';
}

export function assertNetworkAllowed(kind: NetworkRequestKind): void {
  if (!isNetworkAllowed(kind)) throw new NetworkPolicyBlockedError(kind, currentPolicy);
}

export function applyAccessNetworkPolicy(accessMode: 'account' | 'local', workOffline = false): void {
  setNetworkPolicy(accessMode === 'local' ? 'local-catalog-only' : workOffline ? 'account-offline' : 'online');
}

export function setAccountWorkOffline(enabled: boolean): void {
  setNetworkPolicy(enabled ? 'account-offline' : 'online');
}
