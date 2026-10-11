import {
  CONSENT_VERSION,
  isAnalyticsConsentChoice,
  isConsentRecordOwnedBy,
  isConsentSource,
  isCurrentConsentRecord,
  isRegionDefaultConsent,
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
  /**
   * Sent only for a recovered decision (see {@link PendingConsentDecision}): the
   * server writes it, grant or denial, only while the account still holds
   * exactly `basedOnDecidedAt` (no answer when null), and otherwise returns the
   * account's answer without writing.
   */
  conditional?: true;
};
/**
 * A decision waiting to reach the account, with the account answer it was made
 * against. `conditional` marks one this device recovered after an account read
 * (a lost write of its own, found still based on the account's current answer)
 * rather than one the climber just made. It keeps that guard on every retry and
 * after a restart, because a retry does not read the account again and another
 * device may have answered in between. An explicit decision has no marker: its
 * denial is always written, so a climber's own "No thanks" always lands.
 */
export type PendingConsentDecision = { record: ConsentRecord; basedOnDecidedAt: string | null; conditional?: true };
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
    !Number.isFinite(Date.parse(record.decidedAt)) ||
    // Only an explicit answer is ever pending; a region default must never reach the account.
    (record.basis !== undefined && record.basis !== 'explicit')
  )
    return null;
  const stamp = pendingDecision.basedOnDecidedAt;
  if (stamp !== null && (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp)))) return null;
  // A garbled marker could turn a recovered write unconditional: reject it.
  if (pendingDecision.conditional !== undefined && pendingDecision.conditional !== true) return null;
  return {
    record: {
      analytics: record.analytics,
      source: record.source,
      version: record.version,
      decidedAt: record.decidedAt,
    },
    basedOnDecidedAt: stamp,
    ...(pendingDecision.conditional === true ? { conditional: true } : {}),
  };
}

/**
 * The wire input for a pending decision. A recovered decision asks the server
 * to compare-and-set on its token whatever its answer. An explicit withdrawal
 * carries no token and is always written. An explicit grant keeps its token,
 * which the server checks for every grant.
 */
function syncInput(decision: PendingConsentDecision): ConsentSyncInput {
  const { analytics, version, source } = decision.record;
  if (decision.conditional) {
    return { analytics, version, source, basedOnDecidedAt: decision.basedOnDecidedAt, conditional: true };
  }
  return { analytics, version, source, basedOnDecidedAt: analytics === 'denied' ? null : decision.basedOnDecidedAt };
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

/**
 * The account's answer as this device's copy, bound to that account. Drops
 * wire-only fields such as `__typename`, and never copies `basis`: an account
 * answer is always explicit.
 */
function accountCopy(record: ConsentRecord, accountId: string): DeviceConsentRecord {
  return {
    analytics: record.analytics,
    version: record.version,
    decidedAt: record.decidedAt,
    source: record.source,
    ownerAccountId: accountId,
  };
}

/** This device's unconfirmed decision, recorded with the account answer it was made against. */
function unconfirmedDecision(
  record: ConsentRecord,
  accountId: string,
  basedOnDecidedAt: string | null,
): DeviceConsentRecord {
  return { ...accountCopy(record, accountId), basedOnDecidedAt };
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
 * A device answer bound to this account follows {@link resolveConsent}. It is
 * written back only when it is a decision this device made that never reached
 * the account (its pending write was lost) AND the account still holds exactly
 * the answer that decision was made against (`basedOnDecidedAt`). That is a
 * causal test, not a clock comparison, and it is the same token the server's
 * compare-and-set checks. A copy adopted from the account is never written, so
 * a stored answer never overwrites a newer account answer.
 *
 * A device answer given signed out or under another account is not this
 * account's answer and is never written. Its denial still stops tracking on
 * this device (merge rule 3). When the account has no current answer, the
 * device holds none either: the prompt comes back and nothing is tracked until
 * the climber answers for this account.
 *
 * A region default is checked first. It is nobody's answer, so it is never
 * written, and it is not this account's answer to clear either: with no account
 * answer the device keeps it (asking again would only re-apply it, one account
 * read per turn), and any account answer, grant or denial, replaces it.
 */
export function mergeAccountConsent(
  local: DeviceConsentRecord | null,
  server: ConsentRecord | null,
  accountId: string,
): AccountConsentMerge {
  const currentLocal = isCurrentConsentRecord(local) ? local : null;
  const currentServer = isCurrentConsentRecord(server) ? server : null;
  if (isRegionDefaultConsent(currentLocal)) {
    return currentServer === null
      ? { record: currentLocal, push: null }
      : { record: accountCopy(currentServer, accountId), push: null };
  }
  if (currentLocal !== null && isConsentRecordOwnedBy(currentLocal, accountId)) {
    // Same answer: hold the account's copy. Nothing to write.
    if (
      currentServer !== null &&
      currentServer.analytics === currentLocal.analytics &&
      currentLocal.version <= currentServer.version
    ) {
      return { record: accountCopy(currentServer, accountId), push: null };
    }
    // A lost write of a decision made against the account's current answer is
    // this account's newest word: write it again, with that answer as its token.
    if (currentLocal.basedOnDecidedAt !== undefined && currentLocal.basedOnDecidedAt === (server?.decidedAt ?? null)) {
      return { record: currentLocal, push: currentLocal };
    }
    const resolved = resolveConsent(currentLocal, currentServer);
    // Account denial wins (merge rule 2); otherwise the device keeps its own answer.
    if (resolved !== currentLocal && resolved !== null) return { record: accountCopy(resolved, accountId), push: null };
    return { record: currentLocal, push: null };
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
          if (localDenialWins) {
            // A newer denial on this device supersedes the stored grant, which
            // is dropped. The denial is not written here: after the account
            // read, mergeAccountConsent writes it only if it is this account's
            // unconfirmed decision and the account has not moved on since.
            await persistPending(identity, null);
            if (!isCurrent()) return;
          } else {
            pending = stored;
            // unconfirmedDecision rebuilds the record field by field and binds it
            // to this account, so the stored record's own fields (which
            // parsePendingConsentDecision already strips of any owner) can never
            // carry another owner or token onto the device.
            const record = unconfirmedDecision(stored.record, identity, stored.basedOnDecidedAt);
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
          const result = await options.writeAccountConsent(identity, syncInput(decision));
          if (!isCurrent()) return;
          serverRecord = result;
          if (pending !== decision) {
            // A newer explicit Allow follows our own in-flight withdrawal.
            // Rebase only that grant onto the denial we just wrote, never onto
            // a denial returned by a rejected grant, a refused recovered
            // denial (another device's) or a later account read.
            if (
              decision.record.analytics === 'denied' &&
              !decision.conditional &&
              result.analytics === 'denied' &&
              pending !== null &&
              pending === explicitPendingGrant
            ) {
              const record = { ...pending.record, basedOnDecidedAt: result.decidedAt };
              pending = { record, basedOnDecidedAt: result.decidedAt };
              explicitPendingGrant = pending;
              if (snapshot.record?.analytics === 'granted') {
                publish({ record });
                persistRecord(record);
              }
              await persistPending(identity, pending);
            }
            continue;
          }
          // Do not clear a newer decision that was made while the request was in flight.
          pending = null;
          explicitPendingGrant = null;
          // A refused recovered write returns the account's newer answer:
          // merge it like a fresh read, so this device keeps its own No thanks
          // against a newer Allow (rule 3) and takes a newer denial (rule 2).
          const record = decision.conditional
            ? mergeAccountConsent(snapshot.record, result, identity).record
            : accountCopy(result, identity);
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
        // Write only this account's own newer answer. Reads that agree append
        // nothing. The write stays conditional through retries and restarts.
        if (merged.push) {
          pending = { record: merged.push, basedOnDecidedAt: result?.decidedAt ?? null, conditional: true };
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
      // A decision made signed out stays on this device. One made signed in
      // belongs to that account and remembers the account answer it was made
      // against until the account confirms it.
      const basedOnDecidedAt = serverRecord?.decidedAt ?? null;
      const record: DeviceConsentRecord = accountId
        ? {
            analytics,
            source,
            version: CONSENT_VERSION,
            decidedAt: new Date().toISOString(),
            ownerAccountId: accountId,
            basedOnDecidedAt,
          }
        : { analytics, source, version: CONSENT_VERSION, decidedAt: new Date().toISOString(), ownerAccountId: null };
      pending = accountId ? { record, basedOnDecidedAt } : null;
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
        // Only this account's own unconfirmed decision is written to it. A
        // denial from the shared cookie, another sign-in, or a copy adopted
        // from the account stops tracking here and drops the superseded grant
        // without touching the account. An owned denial restored from storage
        // is recovered too: retain its compare-and-set token rather than
        // turning a delayed foreground read into a fresh explicit withdrawal.
        pending =
          accountId && isConsentRecordOwnedBy(record, accountId) && record.basedOnDecidedAt !== undefined
            ? { record, basedOnDecidedAt: record.basedOnDecidedAt, conditional: true }
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
