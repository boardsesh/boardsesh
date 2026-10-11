import {
  CONSENT_VERSION,
  isAnalyticsConsentChoice,
  isConsentRecordOwnedBy,
  isConsentSource,
  isCurrentConsentRecord,
  isSameConsentRecord,
  resolveConsent,
  type AnalyticsConsentChoice,
  type ConsentRecord,
  type ConsentSource,
  type DeviceConsentRecord,
} from './consent-record';

export type ConsentSyncInput = {
  analytics: AnalyticsConsentChoice;
  version: number;
  source: ConsentSource;
  basedOnDecidedAt: string | null;
};
export type PendingConsentDecision = { record: ConsentRecord; basedOnDecidedAt: string | null };
/**
 * Validate a stored pending decision. The record carries no owner on purpose:
 * pending decisions are stored per account, and a restored one is bound to the
 * account it was loaded for. A newer local denial that is not that account's
 * (signed out, or the shared cookie) still wins on this device and drops the
 * restored grant without writing either; see the restore step in
 * {@link createConsentSyncCoordinator} and "Whose answer is it" in
 * docs/analytics-consent.md.
 */
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
  record: DeviceConsentRecord | null;
  ready: true;
  syncing: boolean;
  accountResolved: boolean;
  pending: boolean;
};
export type ConsentSyncOptions = {
  initialRecord: DeviceConsentRecord | null;
  readAccountConsent: (accountId: string) => Promise<ConsentRecord | null>;
  writeAccountConsent: (accountId: string, input: ConsentSyncInput) => Promise<ConsentRecord>;
  persistLocalConsent: (record: DeviceConsentRecord | null) => void | Promise<void>;
  loadPendingDecision?: (accountId: string) => Promise<PendingConsentDecision | null>;
  persistPendingDecision?: (accountId: string, pending: PendingConsentDecision | null) => Promise<void>;
  onError?: (error: unknown) => void;
};

/** The account's answer as this device's copy, bound to that account. Drops wire-only fields such as `__typename`. */
function accountCopy(record: ConsentRecord, accountId: string): DeviceConsentRecord {
  return {
    analytics: record.analytics,
    version: record.version,
    decidedAt: record.decidedAt,
    source: record.source,
    ownerAccountId: accountId,
  };
}

/**
 * True when a device answer is strictly newer than the account's: a later
 * consent version, or the same version decided later. An account answer under
 * an older version counts as no answer.
 */
function isNewerThanAccount(local: ConsentRecord, server: ConsentRecord | null): boolean {
  if (!isCurrentConsentRecord(server)) return true;
  if (local.version !== server.version) return local.version > server.version;
  return Date.parse(local.decidedAt) > Date.parse(server.decidedAt);
}

export type AccountConsentMerge = {
  /** What this device holds afterwards. Null means ask again. */
  record: DeviceConsentRecord | null;
  /** The device answer to write to the account, or null to write nothing. */
  push: DeviceConsentRecord | null;
};

/**
 * Merge a stored device answer with the account answer just read.
 *
 * A device answer given while signed in to this account follows
 * {@link resolveConsent}, and is written back only when it is strictly newer
 * than the account's (its pending write was lost). A stored answer never
 * overwrites a newer account answer, and never resurrects a grant over an
 * account denial: only an explicit decision, with its compare-and-set token,
 * can do that.
 *
 * A device answer given signed out or under another account is not this
 * account's answer and is never written. Its denial still stops tracking on
 * this device (merge rule 3). When the account has no current answer, the
 * device holds none either: the prompt comes back and nothing is tracked until
 * the climber answers for this account.
 */
export function mergeAccountConsent(
  local: DeviceConsentRecord | null,
  server: ConsentRecord | null,
  accountId: string,
): AccountConsentMerge {
  const currentLocal = isCurrentConsentRecord(local) ? local : null;
  const currentServer = isCurrentConsentRecord(server) ? server : null;
  if (currentLocal !== null && isConsentRecordOwnedBy(currentLocal, accountId)) {
    const resolved = resolveConsent(currentLocal, currentServer);
    // Account denial wins (merge rule 2).
    if (resolved !== currentLocal && resolved !== null) return { record: accountCopy(resolved, accountId), push: null };
    // Same answer: hold the account's copy, so later comparisons use server stamps.
    if (
      currentServer !== null &&
      currentServer.analytics === currentLocal.analytics &&
      currentLocal.version <= currentServer.version
    ) {
      return { record: accountCopy(currentServer, accountId), push: null };
    }
    return { record: currentLocal, push: isNewerThanAccount(currentLocal, server) ? currentLocal : null };
  }
  if (currentServer === null) return { record: null, push: null };
  if (currentServer.analytics === 'granted' && currentLocal?.analytics === 'denied') {
    return { record: currentLocal, push: null };
  }
  return { record: accountCopy(currentServer, accountId), push: null };
}

/** Device decisions are immediate; account writes are serialized and bound to an account epoch. */
export function createConsentSyncCoordinator(options: ConsentSyncOptions) {
  let accountId: string | null = null;
  let epoch = 0;
  let revision = 0;
  let serverRecord: ConsentRecord | null = null;
  let pending: PendingConsentDecision | null = null;
  let explicitPendingGrant: PendingConsentDecision | null = null;
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
          const local = snapshot.record;
          // Browser cookies round to seconds. A denial in the same second is
          // indistinguishable from a newer withdrawal, so restoration fails closed.
          const localDenialWins =
            stored.record.analytics === 'granted' &&
            isCurrentConsentRecord(local) &&
            local.analytics === 'denied' &&
            (local.version > stored.record.version ||
              !Number.isFinite(Date.parse(local.decidedAt)) ||
              Math.floor(Date.parse(local.decidedAt) / 1000) >= Math.floor(Date.parse(stored.record.decidedAt) / 1000));
          if (localDenialWins && !isConsentRecordOwnedBy(local, identity)) {
            // A newer denial given signed out or under another account (or
            // read from the shared cookie) supersedes this account's older
            // grant on this device. It is not this account's answer, so it is
            // kept here and never written; the superseded grant is dropped.
            await persistPending(identity, null);
            if (!isCurrent()) return;
          } else {
            pending = localDenialWins ? { record: local, basedOnDecidedAt: null } : stored;
            const record = accountCopy(pending.record, identity);
            publish({ record, pending: true });
            persistRecord(record);
          }
        }
        pendingLoaded = true;
      }
      while (isCurrent()) {
        const decision = pending;
        const readRevision = revision;
        if (decision) {
          await persistPending(identity, decision);
          if (!isCurrent()) return;
          if (pending !== decision) continue;
          const result = await options.writeAccountConsent(identity, {
            analytics: decision.record.analytics,
            version: decision.record.version,
            source: decision.record.source,
            basedOnDecidedAt: decision.basedOnDecidedAt,
          });
          if (!isCurrent()) return;
          serverRecord = result;
          if (pending !== decision) {
            // A newer explicit Allow follows our own in-flight withdrawal.
            // Rebase only that grant onto the denial we just wrote, never onto
            // a denial returned by a rejected grant or a later account read.
            if (
              decision.record.analytics === 'denied' &&
              result.analytics === 'denied' &&
              pending !== null &&
              pending === explicitPendingGrant
            ) {
              pending = { ...pending, basedOnDecidedAt: result.decidedAt };
              explicitPendingGrant = pending;
              await persistPending(identity, pending);
            }
            continue;
          }
          // Do not clear a newer decision that was made while the request was in flight.
          pending = null;
          explicitPendingGrant = null;
          const record = accountCopy(result, identity);
          publish({ record, pending: false, accountResolved: true });
          persistRecord(record);
          await persistPending(identity, null);
          if (pending) continue;
          return;
        }
        const result = await options.readAccountConsent(identity);
        if (!isCurrent()) return;
        serverRecord = result;
        if (readRevision !== revision || pending) continue;
        const merged = mergeAccountConsent(snapshot.record, result, identity);
        publish({ record: merged.record, accountResolved: true });
        persistRecord(merged.record);
        // Write only this account's own newer answer. Reads that agree append nothing.
        if (merged.push) {
          pending = { record: merged.push, basedOnDecidedAt: result?.decidedAt ?? null };
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
      explicitPendingGrant = null;
      pendingLoaded = false;
      serverRecord = null;
      publish({ syncing: false, pending: false, accountResolved: identity === null });
    },
    sync,
    async decide(analytics: AnalyticsConsentChoice, source: ConsentSource): Promise<void> {
      revision += 1;
      // A decision made signed out stays on this device; one made signed in belongs to that account.
      const record: DeviceConsentRecord = {
        analytics,
        source,
        version: CONSENT_VERSION,
        decidedAt: new Date().toISOString(),
        ownerAccountId: accountId,
      };
      pending = accountId ? { record, basedOnDecidedAt: serverRecord?.decidedAt ?? null } : null;
      explicitPendingGrant = analytics === 'granted' ? pending : null;
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
    replaceLocalRecord(record: DeviceConsentRecord | null) {
      // A denial from the shared browser cookie beats an older in-flight grant too.
      if (pending) {
        if (!isCurrentConsentRecord(record) || record.analytics !== 'denied' || pending.record.analytics === 'denied')
          return;
        revision += 1;
        // Only an answer given under this account is written to it. A denial
        // from the shared cookie or another sign-in stops tracking here and
        // drops the superseded grant without touching the account.
        pending =
          accountId && isConsentRecordOwnedBy(record, accountId)
            ? { record, basedOnDecidedAt: serverRecord?.decidedAt ?? null }
            : null;
        explicitPendingGrant = null;
        publish({ record, pending: pending !== null });
        if (accountId) {
          void persistPending(accountId, pending).catch(report);
          void sync();
        }
        return;
      }
      if (isSameConsentRecord(snapshot.record, record)) return;
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
