import {
  CONSENT_VERSION,
  isAnalyticsConsentChoice,
  isConsentSource,
  isCurrentConsentRecord,
  resolveConsent,
  type AnalyticsConsentChoice,
  type ConsentRecord,
  type ConsentSource,
} from './consent-record';

export type ConsentSyncInput = {
  analytics: AnalyticsConsentChoice;
  version: number;
  source: ConsentSource;
  basedOnDecidedAt: string | null;
};
export type PendingConsentDecision = { record: ConsentRecord; basedOnDecidedAt: string | null };
export function parsePendingConsentDecision(candidate: unknown): PendingConsentDecision | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const pendingDecision = candidate as Record<string, unknown>;
  if (typeof pendingDecision.record !== 'object' || pendingDecision.record === null) return null;
  const record = pendingDecision.record as Record<string, unknown>;
  if (
    !isAnalyticsConsentChoice(record.analytics) ||
    !isConsentSource(record.source) ||
    typeof record.version !== 'number' ||
    !Number.isInteger(record.version) ||
    record.version < CONSENT_VERSION ||
    typeof record.decidedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.decidedAt))
  )
    return null;
  const stamp = pendingDecision.basedOnDecidedAt;
  if (stamp !== null && (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp)))) return null;
  return {
    record: {
      analytics: record.analytics,
      source: record.source,
      version: record.version,
      decidedAt: record.decidedAt,
    },
    basedOnDecidedAt: stamp,
  };
}
export type ConsentSyncSnapshot = {
  record: ConsentRecord | null;
  ready: true;
  syncing: boolean;
  accountResolved: boolean;
  pending: boolean;
};
export type ConsentSyncOptions = {
  initialRecord: ConsentRecord | null;
  readAccountConsent: (accountId: string) => Promise<ConsentRecord | null>;
  writeAccountConsent: (accountId: string, input: ConsentSyncInput) => Promise<ConsentRecord>;
  persistLocalConsent: (record: ConsentRecord | null) => void | Promise<void>;
  loadPendingDecision?: (accountId: string) => Promise<PendingConsentDecision | null>;
  persistPendingDecision?: (accountId: string, pending: PendingConsentDecision | null) => Promise<void>;
  onError?: (error: unknown) => void;
};

/** Device decisions are immediate; account writes are serialized and bound to an account epoch. */
export function createConsentSyncCoordinator(options: ConsentSyncOptions) {
  let accountId: string | null = null;
  let epoch = 0;
  let revision = 0;
  let serverRecord: ConsentRecord | null = null;
  let pending: PendingConsentDecision | null = null;
  let pendingLoaded = false;
  let running: Promise<void> | null = null;
  let snapshot: ConsentSyncSnapshot = {
    record: options.initialRecord,
    ready: true,
    syncing: false,
    accountResolved: true,
    pending: false,
  };
  const listeners = new Set<() => void>();
  const persistenceByAccount = new Map<string, Promise<void>>();
  const publish = (update: Partial<ConsentSyncSnapshot>) => {
    snapshot = { ...snapshot, ...update };
    listeners.forEach((listener) => listener());
  };
  const report = (error: unknown) => options.onError?.(error);
  function persistPending(identity: string, decision: PendingConsentDecision | null): Promise<void> {
    const previous = persistenceByAccount.get(identity) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => options.persistPendingDecision?.(identity, decision));
    persistenceByAccount.set(identity, next);
    return next;
  }
  function persistRecord(record: ConsentRecord | null): void {
    try {
      void Promise.resolve(options.persistLocalConsent(record)).catch(report);
    } catch (error) {
      report(error);
    }
  }
  async function synchronize(identity: string, requestEpoch: number): Promise<void> {
    const isCurrent = () => identity === accountId && requestEpoch === epoch;
    try {
      if (!pendingLoaded) {
        const loadRevision = revision;
        const stored = parsePendingConsentDecision(await options.loadPendingDecision?.(identity));
        if (!isCurrent()) return;
        if (loadRevision === revision && !pending && stored) {
          pending = stored;
          publish({ record: stored.record, pending: true });
          persistRecord(stored.record);
        }
        pendingLoaded = true;
      }
      while (isCurrent()) {
        const decision = pending;
        const readRevision = revision;
        if (decision) {
          await persistPending(identity, decision);
          if (!isCurrent()) return;
          const result = await options.writeAccountConsent(identity, {
            analytics: decision.record.analytics,
            version: decision.record.version,
            source: decision.record.source,
            basedOnDecidedAt: decision.basedOnDecidedAt,
          });
          if (!isCurrent()) return;
          serverRecord = result;
          if (pending !== decision) continue;
          // Do not clear a newer decision that was made while the request was in flight.
          pending = null;
          publish({ record: result, pending: false, accountResolved: true });
          persistRecord(result);
          await persistPending(identity, null);
          if (pending) continue;
          return;
        }
        const result = await options.readAccountConsent(identity);
        if (!isCurrent()) return;
        serverRecord = result;
        if (readRevision !== revision || pending) continue;
        const resolved = resolveConsent(snapshot.record, result);
        publish({ record: resolved, accountResolved: true });
        persistRecord(resolved);
        // Fill an empty account, or propagate a device denial. Do not append on every launch.
        if (
          isCurrentConsentRecord(resolved) &&
          (result === null || resolved.analytics !== result.analytics || resolved.version > result.version)
        ) {
          pending = { record: resolved, basedOnDecidedAt: result?.decidedAt ?? null };
          publish({ pending: true });
          continue;
        }
        return;
      }
    } catch (error) {
      if (isCurrent()) report(error);
    }
  }
  function sync(): Promise<void> {
    if (!accountId) return Promise.resolve();
    if (running) return running;
    const identity = accountId;
    const requestEpoch = epoch;
    publish({ syncing: true });
    const operation = synchronize(identity, requestEpoch).finally(() => {
      if (requestEpoch !== epoch) return;
      running = null;
      publish({ syncing: false });
    });
    running = operation;
    return operation;
  }
  return {
    getSnapshot: () => snapshot,
    getAccountId: () => accountId,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setAccount(identity: string | null) {
      if (identity === accountId) return;
      accountId = identity;
      epoch += 1;
      revision += 1;
      running = null;
      pending = null;
      pendingLoaded = false;
      serverRecord = null;
      publish({ syncing: false, pending: false, accountResolved: identity === null });
    },
    sync,
    async decide(analytics: AnalyticsConsentChoice, source: ConsentSource): Promise<void> {
      revision += 1;
      const record: ConsentRecord = {
        analytics,
        source,
        version: CONSENT_VERSION,
        decidedAt: new Date().toISOString(),
      };
      pending = accountId ? { record, basedOnDecidedAt: serverRecord?.decidedAt ?? null } : null;
      publish({ record, pending: pending !== null });
      persistRecord(record);
      if (!accountId) return;
      const identity = accountId;
      const decision = pending;
      // Persist before attempting the network so an offline withdrawal survives restart.
      try {
        await persistPending(identity, decision);
      } catch (error) {
        report(error);
      }
      await sync();
    },
    replaceLocalRecord(record: ConsentRecord | null) {
      // A denial from the shared browser cookie beats an older in-flight grant too.
      if (pending) {
        if (!isCurrentConsentRecord(record) || record.analytics !== 'denied' || pending.record.analytics === 'denied')
          return;
        revision += 1;
        pending = accountId ? { record, basedOnDecidedAt: serverRecord?.decidedAt ?? null } : null;
        publish({ record, pending: pending !== null });
        if (accountId) {
          void persistPending(accountId, pending).catch(report);
          void sync();
        }
        return;
      }
      if (JSON.stringify(snapshot.record) === JSON.stringify(record)) return;
      revision += 1;
      // The device cookie is shared across accounts and carries no account id.
      // Only a fresh account read can authorize an external grant for this user.
      const requiresAccountRead =
        accountId !== null && isCurrentConsentRecord(record) && record.analytics === 'granted';
      publish({ record, accountResolved: requiresAccountRead ? false : snapshot.accountResolved });
      if (requiresAccountRead) void sync();
    },
  };
}
export type ConsentSyncCoordinator = ReturnType<typeof createConsentSyncCoordinator>;
