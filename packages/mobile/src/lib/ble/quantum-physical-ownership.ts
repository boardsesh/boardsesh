/** ble-plx managers and browser GATT devices outlive individual adapters.
 * Keep ownership in process scope so a cancelled adapter cannot tear down a
 * replacement using the same physical resource. Cancelled owners remain as
 * tombstones: a late orphaned connect still needs cleanup unless superseded. */
export type QuantumPhysicalOwnership = {
  isCurrent(): boolean;
  detachSupersededListener(): void;
  waitForCleanup(): Promise<void>;
  cleanup(operation: () => Promise<unknown>): Promise<void>;
};

type ResourceOwner = { token: symbol; onSuperseded?: () => void; cleanupTail: Promise<void> };
const ownersByScope = new WeakMap<object, Map<string, ResourceOwner>>();
let transactionSequence = 0;

export function claimQuantumPhysicalOwnership(
  scope: object,
  resource: string,
  onSuperseded?: () => void,
): QuantumPhysicalOwnership {
  let owners = ownersByScope.get(scope);
  if (!owners) {
    owners = new Map();
    ownersByScope.set(scope, owners);
  }
  const previous = owners.get(resource);
  const owner: ResourceOwner = {
    token: Symbol(resource),
    onSuperseded,
    cleanupTail: previous?.cleanupTail ?? Promise.resolve(),
  };
  owners.set(resource, owner);
  previous?.onSuperseded?.();
  return {
    isCurrent: () => owners.get(resource)?.token === owner.token,
    detachSupersededListener: () => {
      owner.onSuperseded = undefined;
    },
    waitForCleanup: () => owner.cleanupTail,
    cleanup: (operation) => {
      // A replacement waits for cancellation already submitted to the native
      // bridge before it connects. A late completion cannot close its new link.
      const cleanup = owner.cleanupTail
        .then(async () => {
          if (owners.get(resource)?.token === owner.token) await operation();
        })
        .catch(() => {});
      owner.cleanupTail = cleanup;
      return cleanup;
    },
  };
}

/** ble-plx cancellation IDs are manager-global, including across adapters. */
export function nextQuantumTransactionId(operation: string): string {
  return `quantum-${operation.replaceAll(' ', '-')}-${++transactionSequence}`;
}
