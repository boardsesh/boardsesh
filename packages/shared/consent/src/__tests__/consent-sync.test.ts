import { describe, it, expect, vi } from 'vitest';
import {
  createConsentSyncCoordinator,
  mergeAccountConsent,
  parsePendingConsentDecision,
  type ConsentSyncInput,
  type PendingConsentDecision,
} from '../consent-sync';
import { needsPrompt, type ConsentRecord, type DeviceConsentRecord } from '../consent-record';
const grant: ConsentRecord = { analytics: 'granted', version: 1, source: 'web', decidedAt: '2026-10-08T10:00:00.123Z' };
const denial: ConsentRecord = { ...grant, analytics: 'denied' };
/** A device answer bound to `account-a` (given there, or adopted from it). */
function ownedByA(record: ConsentRecord): DeviceConsentRecord {
  return { ...record, ownerAccountId: 'account-a' };
}
/** The account's copy of a record once the account has confirmed it: bound to `account-a`, no token. */
function confirmedByA({ analytics, version, decidedAt, source }: ConsentRecord): DeviceConsentRecord {
  return { analytics, version, decidedAt, source, ownerAccountId: 'account-a' };
}
/** A decision this device made under `account-a` that the account has not confirmed. */
function unconfirmedByA(record: ConsentRecord, basedOnDecidedAt: string | null): DeviceConsentRecord {
  return { ...record, ownerAccountId: 'account-a', basedOnDecidedAt };
}
function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function setup(record: DeviceConsentRecord | null = null) {
  const readAccountConsent = vi.fn(async (_accountId: string): Promise<ConsentRecord | null> => null);
  const writeAccountConsent = vi.fn(async (_accountId: string, _input: unknown): Promise<ConsentRecord> => grant);
  const persistLocalConsent = vi.fn();
  const persistPendingDecision = vi.fn(async () => {});
  const onError = vi.fn();
  const coordinator = createConsentSyncCoordinator({
    initialRecord: record,
    readAccountConsent,
    writeAccountConsent,
    persistLocalConsent,
    persistPendingDecision,
    onError,
  });
  coordinator.setAccount('account-a');
  return { coordinator, readAccountConsent, writeAccountConsent, persistLocalConsent, persistPendingDecision, onError };
}
describe('account consent synchronization', () => {
  it('does not append an unchanged grant on repeated launches', async () => {
    const { coordinator, readAccountConsent, writeAccountConsent } = setup(grant);
    readAccountConsent.mockResolvedValue(grant);
    await coordinator.sync();
    await coordinator.sync();
    expect(writeAccountConsent).not.toHaveBeenCalled();
  });
  it('rechecks this account before accepting a grant from a shared cookie', async () => {
    const { coordinator, readAccountConsent, writeAccountConsent } = setup(denial);
    readAccountConsent.mockResolvedValueOnce(denial);
    await coordinator.sync();
    const accountAnswer = deferred<ConsentRecord | null>();
    readAccountConsent.mockReturnValueOnce(accountAnswer.promise);
    coordinator.replaceLocalRecord(grant);
    expect(coordinator.getSnapshot().accountResolved).toBe(false);
    const synchronization = coordinator.sync();
    accountAnswer.resolve(denial);
    await synchronization;
    expect(coordinator.getSnapshot().record?.analytics).toBe('denied');
    expect(coordinator.getSnapshot().accountResolved).toBe(true);
    expect(writeAccountConsent).not.toHaveBeenCalled();
  });
  it('allows a shared-cookie grant once this account confirms the grant', async () => {
    const { coordinator, readAccountConsent } = setup(denial);
    readAccountConsent.mockResolvedValueOnce(denial);
    await coordinator.sync();
    const accountAnswer = deferred<ConsentRecord | null>();
    readAccountConsent.mockReturnValueOnce(accountAnswer.promise);
    coordinator.replaceLocalRecord(grant);
    expect(coordinator.getSnapshot().accountResolved).toBe(false);
    const synchronization = coordinator.sync();
    accountAnswer.resolve(grant);
    await synchronization;
    expect(coordinator.getSnapshot().record?.analytics).toBe('granted');
    expect(coordinator.getSnapshot().accountResolved).toBe(true);
  });
  it('echoes the exact server timestamp when re-granting after denial', async () => {
    const { coordinator, readAccountConsent, writeAccountConsent } = setup(denial);
    readAccountConsent.mockResolvedValue(denial);
    await coordinator.sync();
    await coordinator.decide('granted', 'web');
    expect(writeAccountConsent).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({ analytics: 'granted', basedOnDecidedAt: '2026-10-08T10:00:00.123Z' }),
    );
    expect(coordinator.getSnapshot().record?.analytics).toBe('granted');
  });
  it('publishes an offline denial immediately and retains its account-bound pending write', async () => {
    const { coordinator, writeAccountConsent, persistPendingDecision, onError } = setup(grant);
    writeAccountConsent.mockRejectedValue(new Error('offline'));
    const operation = coordinator.decide('denied', 'ios');
    expect(coordinator.getSnapshot().record?.analytics).toBe('denied');
    await operation;
    expect(coordinator.getSnapshot().pending).toBe(true);
    expect(persistPendingDecision).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({ record: expect.objectContaining({ analytics: 'denied' }) }),
    );
    expect(onError).toHaveBeenCalledOnce();
  });
  it('ignores a response for the previous signed-in account', async () => {
    const { coordinator, readAccountConsent } = setup();
    const previous = deferred<ConsentRecord | null>();
    readAccountConsent.mockReturnValueOnce(previous.promise);
    const operation = coordinator.sync();
    await Promise.resolve();
    coordinator.setAccount('account-b');
    previous.resolve(denial);
    await operation;
    expect(coordinator.getSnapshot().record).toBeNull();
    expect(coordinator.getSnapshot().accountResolved).toBe(false);
  });
  it('does not let an in-flight grant overwrite a newer withdrawal', async () => {
    const { coordinator, writeAccountConsent } = setup();
    const first = deferred<ConsentRecord>();
    writeAccountConsent.mockReturnValueOnce(first.promise).mockResolvedValueOnce(denial);
    const granted = coordinator.decide('granted', 'web');
    await vi.waitFor(() => expect(writeAccountConsent).toHaveBeenCalledTimes(1));
    const denied = coordinator.decide('denied', 'web');
    first.resolve(grant);
    await Promise.all([granted, denied]);
    expect(coordinator.getSnapshot().record?.analytics).toBe('denied');
    expect(writeAccountConsent).toHaveBeenLastCalledWith('account-a', expect.objectContaining({ analytics: 'denied' }));
  });
  it('lets a shared-cookie withdrawal beat an older in-flight grant without writing it to the account', async () => {
    const { coordinator, readAccountConsent, writeAccountConsent, persistPendingDecision } = setup();
    readAccountConsent.mockResolvedValue(grant);
    const first = deferred<ConsentRecord>();
    writeAccountConsent.mockReturnValueOnce(first.promise);
    const operation = coordinator.decide('granted', 'web');
    await vi.waitFor(() => expect(writeAccountConsent).toHaveBeenCalledTimes(1));
    // The cookie carries no account: it may come from a signed-out tab on the other origin.
    coordinator.replaceLocalRecord(denial);
    expect(coordinator.getSnapshot().record?.analytics).toBe('denied');
    first.resolve(grant);
    await operation;
    expect(coordinator.getSnapshot()).toMatchObject({ record: denial, pending: false });
    expect(writeAccountConsent).toHaveBeenCalledOnce();
    expect(persistPendingDecision).toHaveBeenLastCalledWith('account-a', null);
  });
  it("writes this account's own withdrawal over an older in-flight grant", async () => {
    const { coordinator, writeAccountConsent } = setup();
    const first = deferred<ConsentRecord>();
    writeAccountConsent.mockReturnValueOnce(first.promise).mockResolvedValueOnce(denial);
    const operation = coordinator.decide('granted', 'web');
    await vi.waitFor(() => expect(writeAccountConsent).toHaveBeenCalledTimes(1));
    coordinator.replaceLocalRecord(unconfirmedByA(denial, null));
    expect(coordinator.getSnapshot().record?.analytics).toBe('denied');
    first.resolve(grant);
    await operation;
    expect(coordinator.getSnapshot().record?.analytics).toBe('denied');
    expect(writeAccountConsent).toHaveBeenLastCalledWith('account-a', expect.objectContaining({ analytics: 'denied' }));
  });
  it('pushes durable decisions before merging the old account denial', async () => {
    const write = vi.fn(async () => grant);
    const read = vi.fn(async () => denial);
    const coordinator = createConsentSyncCoordinator({
      initialRecord: grant,
      readAccountConsent: read,
      writeAccountConsent: write,
      persistLocalConsent: vi.fn(),
      loadPendingDecision: async () => ({ record: grant, basedOnDecidedAt: denial.decidedAt }),
    });
    coordinator.setAccount('account-a');
    await coordinator.sync();
    expect(write).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().record?.analytics).toBe('granted');
  });
  it.each([
    ['newer withdrawal', unconfirmedByA({ ...denial, decidedAt: '2026-10-08T10:00:01.000Z' }, grant.decidedAt)],
    [
      'newer consent version',
      unconfirmedByA({ ...denial, version: 2, decidedAt: '2026-10-08T09:00:00.000Z' }, grant.decidedAt),
    ],
  ])(
    "drops a restored pending grant for this account's unconfirmed %s and writes the denial after the account read",
    async (_description, localDenial) => {
      const writeAccountConsent = vi.fn(async () => localDenial);
      const readAccountConsent = vi.fn(async () => grant);
      const persistLocalConsent = vi.fn();
      const persistPendingDecision = vi.fn(async () => {});
      const coordinator = createConsentSyncCoordinator({
        initialRecord: localDenial,
        readAccountConsent,
        writeAccountConsent,
        persistLocalConsent,
        persistPendingDecision,
        loadPendingDecision: async () => ({ record: grant, basedOnDecidedAt: grant.decidedAt }),
      });
      coordinator.setAccount('account-a');
      await coordinator.sync();
      expect(readAccountConsent).toHaveBeenCalledOnce();
      expect(readAccountConsent.mock.invocationCallOrder[0]).toBeLessThan(
        writeAccountConsent.mock.invocationCallOrder[0],
      );
      expect(writeAccountConsent).toHaveBeenCalledExactlyOnceWith(
        'account-a',
        expect.objectContaining({ analytics: 'denied', basedOnDecidedAt: grant.decidedAt, conditional: true }),
      );
      expect(persistLocalConsent.mock.calls.every(([record]) => record?.analytics === 'denied')).toBe(true);
      expect(persistPendingDecision).toHaveBeenNthCalledWith(1, 'account-a', null);
      expect(persistPendingDecision).toHaveBeenCalledWith('account-a', {
        record: localDenial,
        basedOnDecidedAt: grant.decidedAt,
        conditional: true,
      });
      expect(coordinator.getSnapshot()).toMatchObject({ record: confirmedByA(localDenial), pending: false });
    },
  );
  it('never writes an adopted older denial over a newer account grant after a restored pending grant', async () => {
    // Phone P's pending grant (10:00:00) lost compare-and-set, so P adopted the
    // account denial (10:00:05), but clearing the stored grant failed. Later
    // phone Q said Allow (12:00). P relaunches.
    const storedGrant = { ...grant, source: 'ios' as const, decidedAt: '2026-10-08T10:00:00.000Z' };
    const adoptedDenial = ownedByA({ ...denial, source: 'android', decidedAt: '2026-10-08T10:00:05.000Z' });
    const accountGrantFromQ = { ...grant, source: 'android' as const, decidedAt: '2026-10-08T12:00:00.000Z' };
    const writeAccountConsent = vi.fn(async (_accountId: string, _input: ConsentSyncInput) => grant);
    const persistPendingDecision = vi.fn(async () => {});
    const coordinator = createConsentSyncCoordinator({
      initialRecord: adoptedDenial,
      readAccountConsent: async () => accountGrantFromQ,
      writeAccountConsent,
      persistLocalConsent: vi.fn(),
      persistPendingDecision,
      loadPendingDecision: async () => ({ record: storedGrant, basedOnDecidedAt: null }),
    });
    coordinator.setAccount('account-a');
    await coordinator.sync();
    expect(writeAccountConsent).not.toHaveBeenCalled();
    expect(persistPendingDecision).toHaveBeenCalledExactlyOnceWith('account-a', null);
    // P keeps its own No (merge rule 3); the account keeps Q's newer Allow.
    expect(coordinator.getSnapshot()).toMatchObject({ record: adoptedDenial, pending: false, accountResolved: true });
  });
  it.each([
    ['signed out', null, '2026-10-08T10:00:01.000Z'],
    ['under another account', 'account-b', '2026-10-08T10:00:01.000Z'],
    ['before device answers carried an account', undefined, '2026-10-08T10:00:01.000Z'],
    ['on the shared cookie in the same second', undefined, '2026-10-08T10:00:00.000Z'],
  ])(
    'keeps a newer denial given %s against a restored pending grant without writing either',
    async (_description, ownerAccountId, decidedAt) => {
      const localDenial: DeviceConsentRecord = { ...denial, decidedAt, ownerAccountId };
      const writeAccountConsent = vi.fn(async () => grant);
      const persistLocalConsent = vi.fn();
      const persistPendingDecision = vi.fn(async () => {});
      const coordinator = createConsentSyncCoordinator({
        initialRecord: localDenial,
        readAccountConsent: vi.fn(async () => grant),
        writeAccountConsent,
        persistLocalConsent,
        persistPendingDecision,
        loadPendingDecision: async () => ({ record: grant, basedOnDecidedAt: grant.decidedAt }),
      });
      coordinator.setAccount('account-a');
      await coordinator.sync();
      expect(writeAccountConsent).not.toHaveBeenCalled();
      expect(persistPendingDecision).toHaveBeenCalledExactlyOnceWith('account-a', null);
      expect(persistLocalConsent.mock.calls.every(([record]) => record?.analytics === 'denied')).toBe(true);
      expect(coordinator.getSnapshot()).toMatchObject({ record: localDenial, pending: false, accountResolved: true });
    },
  );
  it('drops a pending grant on an offline restart when the shared cookie holds a newer withdrawal', async () => {
    // The app was killed after a cookie withdrawal superseded an in-flight grant
    // but before the pending grant was cleared from storage. The restored grant
    // carries no owner (pending records are keyed by account, not stamped), and
    // the cookie denial has none either, so neither may be written.
    const cookieDenial = { ...denial, decidedAt: '2026-10-08T10:00:05.000Z' };
    const writeAccountConsent = vi.fn(async () => grant);
    const persistPendingDecision = vi.fn(async () => {});
    const onError = vi.fn();
    const coordinator = createConsentSyncCoordinator({
      initialRecord: cookieDenial,
      readAccountConsent: vi.fn(async () => {
        throw new Error('offline');
      }),
      writeAccountConsent,
      persistLocalConsent: vi.fn(),
      persistPendingDecision,
      loadPendingDecision: async () => ({ record: grant, basedOnDecidedAt: null }),
      onError,
    });
    coordinator.setAccount('account-a');
    await coordinator.sync();
    expect(writeAccountConsent).not.toHaveBeenCalled();
    expect(persistPendingDecision).toHaveBeenCalledExactlyOnceWith('account-a', null);
    expect(onError).toHaveBeenCalledOnce();
    // Tracking stays off and nothing asks yet: the account read has not answered.
    expect(coordinator.getSnapshot()).toMatchObject({ record: cookieDenial, pending: false, accountResolved: false });
  });
  it('restores a pending grant from a later second than the local denial', async () => {
    const earlierDenial = { ...denial, decidedAt: '2026-10-08T09:59:59.999Z' };
    const writeAccountConsent = vi.fn(async () => grant);
    const coordinator = createConsentSyncCoordinator({
      initialRecord: earlierDenial,
      readAccountConsent: vi.fn(async () => earlierDenial),
      writeAccountConsent,
      persistLocalConsent: vi.fn(),
      loadPendingDecision: async () => ({ record: grant, basedOnDecidedAt: earlierDenial.decidedAt }),
    });
    coordinator.setAccount('account-a');
    await coordinator.sync();
    expect(writeAccountConsent).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({ analytics: 'granted', basedOnDecidedAt: earlierDenial.decidedAt }),
    );
    expect(coordinator.getSnapshot().record?.analytics).toBe('granted');
  });
  it('retains the replacement denial when its account write fails', async () => {
    const localDenial = unconfirmedByA({ ...denial, decidedAt: '2026-10-08T11:00:00.000Z' }, grant.decidedAt);
    const persistPendingDecision = vi.fn(async () => {});
    const coordinator = createConsentSyncCoordinator({
      initialRecord: localDenial,
      readAccountConsent: vi.fn(async () => grant),
      writeAccountConsent: vi.fn(async () => {
        throw new Error('offline');
      }),
      persistLocalConsent: vi.fn(),
      persistPendingDecision,
      loadPendingDecision: async () => ({ record: grant, basedOnDecidedAt: grant.decidedAt }),
    });
    coordinator.setAccount('account-a');
    await coordinator.sync();
    expect(coordinator.getSnapshot()).toMatchObject({ record: localDenial, pending: true });
    expect(persistPendingDecision).toHaveBeenLastCalledWith('account-a', {
      record: localDenial,
      basedOnDecidedAt: grant.decidedAt,
      conditional: true,
    });
  });
  it('rebases a newer explicit Allow onto its own completed in-flight withdrawal', async () => {
    const { coordinator, readAccountConsent, writeAccountConsent, persistPendingDecision } = setup(grant);
    readAccountConsent.mockResolvedValue(grant);
    await coordinator.sync();
    const withdrawal = deferred<ConsentRecord>();
    const completedDenial = { ...denial, decidedAt: '2026-10-08T11:00:00.456Z' };
    writeAccountConsent.mockReturnValueOnce(withdrawal.promise).mockResolvedValueOnce(grant);
    const denying = coordinator.decide('denied', 'web');
    await vi.waitFor(() => expect(writeAccountConsent).toHaveBeenCalledOnce());
    const allowing = coordinator.decide('granted', 'web');
    withdrawal.resolve(completedDenial);
    await Promise.all([denying, allowing]);
    expect(writeAccountConsent).toHaveBeenLastCalledWith(
      'account-a',
      expect.objectContaining({ analytics: 'granted', basedOnDecidedAt: completedDenial.decidedAt }),
    );
    expect(persistPendingDecision).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({
        record: expect.objectContaining({ analytics: 'granted' }),
        basedOnDecidedAt: completedDenial.decidedAt,
      }),
    );
    expect(coordinator.getSnapshot()).toMatchObject({ record: grant, pending: false });
  });
  it('keeps a later external denial when the rebased explicit grant loses CAS', async () => {
    const { coordinator, readAccountConsent, writeAccountConsent } = setup(grant);
    readAccountConsent.mockResolvedValue(grant);
    await coordinator.sync();
    const withdrawal = deferred<ConsentRecord>();
    const completedDenial = { ...denial, decidedAt: '2026-10-08T11:00:00.456Z' };
    const externalDenial = { ...denial, decidedAt: '2026-10-08T11:00:00.457Z' };
    writeAccountConsent.mockReturnValueOnce(withdrawal.promise).mockResolvedValueOnce(externalDenial);
    const denying = coordinator.decide('denied', 'web');
    await vi.waitFor(() => expect(writeAccountConsent).toHaveBeenCalledOnce());
    const allowing = coordinator.decide('granted', 'web');
    withdrawal.resolve(completedDenial);
    await Promise.all([denying, allowing]);
    expect(writeAccountConsent).toHaveBeenCalledTimes(2);
    expect(writeAccountConsent).toHaveBeenLastCalledWith(
      'account-a',
      expect.objectContaining({ analytics: 'granted', basedOnDecidedAt: completedDenial.decidedAt }),
    );
    expect(coordinator.getSnapshot()).toMatchObject({ record: externalDenial, pending: false });
  });
  it('never rebases a newer explicit grant onto a denial returned by a rejected grant', async () => {
    const { coordinator, readAccountConsent, writeAccountConsent } = setup(grant);
    readAccountConsent.mockResolvedValue(grant);
    await coordinator.sync();
    const staleGrant = deferred<ConsentRecord>();
    const externalDenial = { ...denial, decidedAt: '2026-10-08T11:00:00.456Z' };
    writeAccountConsent.mockReturnValueOnce(staleGrant.promise).mockResolvedValueOnce(externalDenial);
    const firstAllow = coordinator.decide('granted', 'web');
    await vi.waitFor(() => expect(writeAccountConsent).toHaveBeenCalledOnce());
    const secondAllow = coordinator.decide('granted', 'web');
    staleGrant.resolve(externalDenial);
    await Promise.all([firstAllow, secondAllow]);
    expect(writeAccountConsent).toHaveBeenLastCalledWith(
      'account-a',
      expect.objectContaining({ analytics: 'granted', basedOnDecidedAt: grant.decidedAt }),
    );
    expect(coordinator.getSnapshot().record).toEqual(ownedByA(externalDenial));
  });
  it('drops a rebased grant withdrawn while its durable write is pending', async () => {
    const withdrawal = deferred<ConsentRecord>();
    const rebasedStorageWrite = deferred<void>();
    const completedDenial = { ...denial, decidedAt: '2026-10-08T11:00:00.456Z' };
    const externalDenial = unconfirmedByA({ ...denial, decidedAt: '2026-10-08T11:00:01.000Z' }, null);
    const writeAccountConsent = vi.fn(async (_accountId: string, _input: ConsentSyncInput) => grant);
    writeAccountConsent.mockReturnValueOnce(withdrawal.promise).mockResolvedValueOnce(externalDenial);
    const persistPendingDecision = vi.fn(async (_accountId: string, decision: PendingConsentDecision | null) => {
      if (decision?.record.analytics === 'granted' && decision.basedOnDecidedAt === completedDenial.decidedAt)
        await rebasedStorageWrite.promise;
    });
    const coordinator = createConsentSyncCoordinator({
      initialRecord: grant,
      readAccountConsent: async () => grant,
      writeAccountConsent,
      persistLocalConsent: vi.fn(),
      persistPendingDecision,
    });
    coordinator.setAccount('account-a');
    await coordinator.sync();
    const denying = coordinator.decide('denied', 'web');
    await vi.waitFor(() => expect(writeAccountConsent).toHaveBeenCalledOnce());
    const allowing = coordinator.decide('granted', 'web');
    withdrawal.resolve(completedDenial);
    await vi.waitFor(() =>
      expect(persistPendingDecision).toHaveBeenCalledWith(
        'account-a',
        expect.objectContaining({
          record: expect.objectContaining({ analytics: 'granted' }),
          basedOnDecidedAt: completedDenial.decidedAt,
        }),
      ),
    );
    coordinator.replaceLocalRecord(externalDenial);
    rebasedStorageWrite.resolve();
    await Promise.all([denying, allowing]);
    expect(writeAccountConsent).toHaveBeenCalledTimes(2);
    expect(writeAccountConsent.mock.calls.every(([_accountId, input]) => input.analytics === 'denied')).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({ record: confirmedByA(externalDenial), pending: false });
  });
  it('does not restore an older grant after a withdrawal during the pending-decision read', async () => {
    const pendingRead = deferred<PendingConsentDecision | null>();
    const localDenial = unconfirmedByA({ ...denial, decidedAt: '2026-10-08T11:00:00.000Z' }, grant.decidedAt);
    const writeAccountConsent = vi.fn(async () => localDenial);
    const coordinator = createConsentSyncCoordinator({
      initialRecord: grant,
      readAccountConsent: async () => grant,
      writeAccountConsent,
      persistLocalConsent: vi.fn(),
      loadPendingDecision: () => pendingRead.promise,
    });
    coordinator.setAccount('account-a');
    const synchronization = coordinator.sync();
    coordinator.replaceLocalRecord(localDenial);
    pendingRead.resolve({ record: grant, basedOnDecidedAt: grant.decidedAt });
    await synchronization;
    expect(writeAccountConsent).toHaveBeenCalledWith('account-a', expect.objectContaining({ analytics: 'denied' }));
    expect(coordinator.getSnapshot().record).toEqual(ownedByA({ ...denial, decidedAt: '2026-10-08T11:00:00.000Z' }));
  });
  it('ignores a completed denial from the previous account while a new account grants', async () => {
    const { coordinator, writeAccountConsent } = setup();
    const previousWithdrawal = deferred<ConsentRecord>();
    const currentGrant = deferred<ConsentRecord>();
    writeAccountConsent.mockReturnValueOnce(previousWithdrawal.promise).mockReturnValueOnce(currentGrant.promise);
    const denying = coordinator.decide('denied', 'web');
    await vi.waitFor(() => expect(writeAccountConsent).toHaveBeenCalledOnce());
    coordinator.setAccount('account-b');
    const allowing = coordinator.decide('granted', 'web');
    await vi.waitFor(() => expect(writeAccountConsent).toHaveBeenCalledTimes(2));
    previousWithdrawal.resolve(denial);
    await denying;
    expect(coordinator.getSnapshot().record?.analytics).toBe('granted');
    expect(writeAccountConsent).toHaveBeenLastCalledWith(
      'account-b',
      expect.objectContaining({ analytics: 'granted', basedOnDecidedAt: null }),
    );
    currentGrant.resolve(grant);
    await allowing;
    expect(coordinator.getSnapshot()).toMatchObject({ record: grant, accountResolved: true });
  });
  it('two devices: an older stored denial never re-denies a newer account grant', async () => {
    // Phone A said No (its write landed, so it holds the server copy). Later the
    // climber said Allow on phone B. Phone A now comes to the foreground.
    const phoneADenial = ownedByA({ ...denial, decidedAt: '2026-10-08T09:00:00.000Z' });
    const phoneBGrant = { ...grant, source: 'ios' as const, decidedAt: '2026-10-08T12:00:00.000Z' };
    const { coordinator, readAccountConsent, writeAccountConsent, persistPendingDecision } = setup(phoneADenial);
    readAccountConsent.mockResolvedValue(phoneBGrant);
    await coordinator.sync();
    await coordinator.sync();
    expect(writeAccountConsent).not.toHaveBeenCalled();
    expect(persistPendingDecision).not.toHaveBeenCalled();
    // This device keeps its own No (merge rule 3); the account keeps the newer Allow.
    expect(coordinator.getSnapshot()).toMatchObject({ record: phoneADenial, pending: false, accountResolved: true });
  });
  it('two devices: a pre-upgrade stored denial never re-denies a newer account grant', async () => {
    const legacyDenial = { ...denial, decidedAt: '2026-10-08T09:00:00.000Z' };
    const { coordinator, readAccountConsent, writeAccountConsent } = setup(legacyDenial);
    readAccountConsent.mockResolvedValue({ ...grant, decidedAt: '2026-10-08T12:00:00.000Z' });
    await coordinator.sync();
    expect(writeAccountConsent).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().record?.analytics).toBe('denied');
  });
  it('shared device: a signed-out Allow is never written to an unanswered account and asks again', async () => {
    const readAccountConsent = vi.fn(async (_accountId: string): Promise<ConsentRecord | null> => null);
    const writeAccountConsent = vi.fn(async (_accountId: string, _input: ConsentSyncInput) => grant);
    const persistLocalConsent = vi.fn();
    const coordinator = createConsentSyncCoordinator({
      initialRecord: null,
      readAccountConsent,
      writeAccountConsent,
      persistLocalConsent,
    });
    await coordinator.decide('granted', 'ios');
    expect(coordinator.getSnapshot().record).toMatchObject({ analytics: 'granted', ownerAccountId: null });
    coordinator.setAccount('account-b');
    expect(coordinator.getSnapshot().accountResolved).toBe(false);
    await coordinator.sync();
    expect(readAccountConsent).toHaveBeenCalledWith('account-b');
    expect(writeAccountConsent).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({ record: null, pending: false, accountResolved: true });
    expect(needsPrompt(coordinator.getSnapshot().record)).toBe(true);
    expect(persistLocalConsent).toHaveBeenLastCalledWith(null);
  });
  it('shared device: an answer given under another account does not answer for this one', async () => {
    const { coordinator, readAccountConsent, writeAccountConsent } = setup({ ...grant, ownerAccountId: 'account-b' });
    readAccountConsent.mockResolvedValue(null);
    await coordinator.sync();
    expect(writeAccountConsent).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().record).toBeNull();
  });
  it('binds an explicit signed-in decision to the account and writes it', async () => {
    const { coordinator, writeAccountConsent, persistLocalConsent } = setup();
    writeAccountConsent.mockResolvedValue({ ...grant, __typename: 'AnalyticsConsent' } as ConsentRecord);
    await coordinator.decide('granted', 'android');
    expect(writeAccountConsent).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({ analytics: 'granted', source: 'android', basedOnDecidedAt: null }),
    );
    expect(coordinator.getSnapshot().record).toEqual(ownedByA(grant));
    expect(persistLocalConsent).toHaveBeenLastCalledWith(ownedByA(grant));
  });
  it('a later signed-in answer from a lost pending write is written back with the account stamp', async () => {
    const lostDenial = unconfirmedByA(
      { ...denial, source: 'ios', decidedAt: '2026-10-08T13:00:00.000Z' },
      grant.decidedAt,
    );
    const { coordinator, readAccountConsent, writeAccountConsent } = setup(lostDenial);
    readAccountConsent.mockResolvedValue(grant);
    writeAccountConsent.mockResolvedValue({ ...denial, decidedAt: '2026-10-08T13:00:01.000Z' });
    await coordinator.sync();
    expect(writeAccountConsent).toHaveBeenCalledExactlyOnceWith('account-a', {
      analytics: 'denied',
      version: 1,
      source: 'ios',
      basedOnDecidedAt: grant.decidedAt,
      conditional: true,
    });
  });
  it('drops a lost decision once the account has moved on, whatever the device clock says', async () => {
    // Decided against an older answer, stamped by a clock running far ahead.
    const lostDenial = unconfirmedByA({ ...denial, decidedAt: '2027-01-01T00:00:00.000Z' }, '2026-10-01T00:00:00.000Z');
    const { coordinator, readAccountConsent, writeAccountConsent } = setup(lostDenial);
    readAccountConsent.mockResolvedValue(grant);
    await coordinator.sync();
    expect(writeAccountConsent).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().record?.analytics).toBe('denied');
  });
  it("writes a lost re-grant made against the account's current denial, guarded by compare-and-set", async () => {
    const lostGrant = unconfirmedByA({ ...grant, decidedAt: '2026-10-08T13:00:00.000Z' }, denial.decidedAt);
    const { coordinator, readAccountConsent, writeAccountConsent } = setup(lostGrant);
    readAccountConsent.mockResolvedValue(denial);
    await coordinator.sync();
    expect(writeAccountConsent).toHaveBeenCalledExactlyOnceWith(
      'account-a',
      expect.objectContaining({ analytics: 'granted', basedOnDecidedAt: denial.decidedAt, conditional: true }),
    );
  });
  it("fills an unanswered account with this account's own stored answer", async () => {
    const { coordinator, readAccountConsent, writeAccountConsent } = setup(unconfirmedByA(grant, null));
    readAccountConsent.mockResolvedValue(null);
    await coordinator.sync();
    expect(writeAccountConsent).toHaveBeenCalledExactlyOnceWith(
      'account-a',
      expect.objectContaining({ analytics: 'granted', basedOnDecidedAt: null, conditional: true }),
    );
  });
  it('adopts the account copy, bound to the account, when a signed-out grant matches it', async () => {
    const { coordinator, readAccountConsent, writeAccountConsent } = setup(grant);
    const accountGrant = { ...grant, source: 'ios' as const, decidedAt: '2026-10-07T08:00:00.000Z' };
    readAccountConsent.mockResolvedValue(accountGrant);
    await coordinator.sync();
    expect(writeAccountConsent).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().record).toEqual(ownedByA(accountGrant));
  });
  it('rechecks the account when the device answer matches except for its owner', async () => {
    const { coordinator, readAccountConsent } = setup();
    readAccountConsent.mockResolvedValue(grant);
    await coordinator.sync();
    expect(coordinator.getSnapshot().record).toEqual(ownedByA(grant));
    coordinator.replaceLocalRecord(ownedByA(grant));
    expect(readAccountConsent).toHaveBeenCalledOnce();
    coordinator.replaceLocalRecord(grant);
    expect(coordinator.getSnapshot().accountResolved).toBe(false);
    await coordinator.sync();
    expect(coordinator.getSnapshot()).toMatchObject({ record: ownedByA(grant), accountResolved: true });
  });
  describe('a recovered write stays conditional', () => {
    /**
     * An in-memory account with the server's write rule (analytics-consent.ts):
     * a grant or a recovered (`conditional`) write lands only on the exact
     * answer it was based on, otherwise the current answer comes back; an
     * explicit denial always lands.
     */
    function fakeAccount(first: ConsentRecord) {
      const rows: ConsentRecord[] = [first];
      const latest = () => rows[rows.length - 1];
      let nextSecond = 0;
      const write = vi.fn(async (_accountId: string, input: ConsentSyncInput): Promise<ConsentRecord> => {
        const current = latest();
        const stale = input.conditional
          ? current.decidedAt !== input.basedOnDecidedAt
          : input.analytics === 'granted' &&
            (input.basedOnDecidedAt === null
              ? current.analytics !== 'granted'
              : current.decidedAt !== input.basedOnDecidedAt);
        if (stale) return current;
        nextSecond += 1;
        const { analytics, version, source } = input;
        rows.push({ analytics, version, source, decidedAt: `2026-10-08T13:00:0${nextSecond}.000Z` });
        return latest();
      });
      return { rows, latest, write, answerElsewhere: (record: ConsentRecord) => rows.push(record) };
    }
    // Phone A said No at 11:00 against the account's 10:00 Allow. Both its
    // write and its pending record were lost.
    const accountGrant: ConsentRecord = { ...grant, decidedAt: '2026-10-08T10:00:00.000Z' };
    const lostDenial = unconfirmedByA(
      { ...denial, source: 'ios', decidedAt: '2026-10-08T11:00:00.000Z' },
      accountGrant.decidedAt,
    );
    const phoneBGrant: ConsentRecord = { ...grant, source: 'android', decidedAt: '2026-10-08T12:00:00.000Z' };
    function phoneA(account: ReturnType<typeof fakeAccount>, stored: Map<string, PendingConsentDecision | null>) {
      const readAccountConsent = vi.fn(async (_accountId: string): Promise<ConsentRecord | null> => account.latest());
      const coordinator = createConsentSyncCoordinator({
        initialRecord: lostDenial,
        readAccountConsent,
        writeAccountConsent: account.write,
        persistLocalConsent: vi.fn(),
        loadPendingDecision: async (accountId) => stored.get(accountId) ?? null,
        persistPendingDecision: async (accountId, decision) => {
          stored.set(accountId, decision);
        },
        onError: vi.fn(),
      });
      coordinator.setAccount('account-a');
      return { coordinator, readAccountConsent };
    }
    it.each(['a retry', 'a restart'])(
      "never overwrites another device's newer Allow on %s after the first write failed",
      async (resumedBy) => {
        const account = fakeAccount(accountGrant);
        const stored = new Map<string, PendingConsentDecision | null>();
        const firstRun = phoneA(account, stored);
        account.write.mockRejectedValueOnce(new Error('offline'));
        await firstRun.coordinator.sync();
        // The account read recovered the denial; it is stored with its guard.
        expect(stored.get('account-a')).toEqual({
          record: lostDenial,
          basedOnDecidedAt: accountGrant.decidedAt,
          conditional: true,
        });
        account.answerElsewhere(phoneBGrant);

        const resumed = resumedBy === 'a retry' ? firstRun : phoneA(account, stored);
        await resumed.coordinator.sync();

        // The retry wrote without reading the account again; the guard held.
        expect(resumed.readAccountConsent).toHaveBeenCalledTimes(resumedBy === 'a retry' ? 1 : 0);
        expect(account.write).toHaveBeenLastCalledWith('account-a', {
          analytics: 'denied',
          version: 1,
          source: 'ios',
          basedOnDecidedAt: accountGrant.decidedAt,
          conditional: true,
        });
        expect(account.rows).toEqual([accountGrant, phoneBGrant]);
        // Phone A ends where reading B's Allow first would have left it: its
        // own No stays on this device (rule 3), nothing is pending.
        expect(resumed.coordinator.getSnapshot()).toMatchObject({ record: lostDenial, pending: false });
        expect(stored.get('account-a')).toBeNull();
        await resumed.coordinator.sync();
        expect(account.write).toHaveBeenCalledTimes(2);
        expect(account.latest()).toEqual(phoneBGrant);
      },
    );
    it('keeps a stored denial conditional when it replaces a newer pending Allow during recovery', async () => {
      const account = fakeAccount(accountGrant);
      const stored = new Map<string, PendingConsentDecision | null>();
      const { coordinator } = phoneA(account, stored);
      const recovered = deferred<ConsentRecord>();
      account.write.mockReturnValueOnce(recovered.promise);

      const syncing = coordinator.sync();
      await vi.waitFor(() => expect(account.write).toHaveBeenCalledOnce());
      const allowing = coordinator.decide('granted', 'ios');
      // A foreground storage read started before Allow returns the old denial.
      coordinator.replaceLocalRecord(lostDenial);
      account.answerElsewhere(phoneBGrant);
      recovered.resolve(phoneBGrant);
      await Promise.all([syncing, allowing]);

      expect(account.write).toHaveBeenCalledTimes(2);
      expect(account.write).toHaveBeenLastCalledWith('account-a', {
        analytics: 'denied',
        version: 1,
        source: 'ios',
        basedOnDecidedAt: accountGrant.decidedAt,
        conditional: true,
      });
      expect(account.rows).toEqual([accountGrant, phoneBGrant]);
      expect(coordinator.getSnapshot()).toMatchObject({ record: lostDenial, pending: false });
      expect(stored.get('account-a')).toBeNull();
    });
    it('lands while the account still holds the answer it was made against', async () => {
      const account = fakeAccount(accountGrant);
      const stored = new Map<string, PendingConsentDecision | null>();
      const { coordinator } = phoneA(account, stored);
      account.write.mockRejectedValueOnce(new Error('offline'));
      await coordinator.sync();
      await coordinator.sync();
      expect(account.latest()).toMatchObject({ analytics: 'denied', source: 'ios' });
      expect(coordinator.getSnapshot()).toMatchObject({ record: confirmedByA(account.latest()), pending: false });
    });
    it("keeps an explicit No thanks and its retries unconditional, so the climber's own withdrawal lands", async () => {
      const account = fakeAccount(accountGrant);
      const stored = new Map<string, PendingConsentDecision | null>();
      const coordinator = createConsentSyncCoordinator({
        initialRecord: null,
        readAccountConsent: async () => account.latest(),
        writeAccountConsent: account.write,
        persistLocalConsent: vi.fn(),
        persistPendingDecision: async (accountId, decision) => {
          stored.set(accountId, decision);
        },
        onError: vi.fn(),
      });
      coordinator.setAccount('account-a');
      await coordinator.sync();
      account.write.mockRejectedValueOnce(new Error('offline'));
      await coordinator.decide('denied', 'ios');
      // The stored retry keeps the answer it was made against, without the guard.
      expect(stored.get('account-a')).toEqual({
        record: expect.objectContaining({ analytics: 'denied' }),
        basedOnDecidedAt: accountGrant.decidedAt,
      });
      account.answerElsewhere(phoneBGrant);
      await coordinator.sync();
      expect(account.write).toHaveBeenLastCalledWith('account-a', {
        analytics: 'denied',
        version: 1,
        source: 'ios',
        basedOnDecidedAt: null,
      });
      expect(account.latest()).toMatchObject({ analytics: 'denied', source: 'ios' });
      expect(coordinator.getSnapshot()).toMatchObject({ record: { analytics: 'denied' }, pending: false });
    });
    it('never rebases a newer explicit Allow onto a denial a recovered write brought back', async () => {
      const { coordinator, readAccountConsent, writeAccountConsent } = setup(lostDenial);
      readAccountConsent.mockResolvedValue(accountGrant);
      const recovered = deferred<ConsentRecord>();
      const phoneBDenial: ConsentRecord = { ...denial, source: 'android', decidedAt: '2026-10-08T12:00:00.000Z' };
      writeAccountConsent.mockReturnValueOnce(recovered.promise).mockResolvedValueOnce(phoneBDenial);
      const syncing = coordinator.sync();
      await vi.waitFor(() => expect(writeAccountConsent).toHaveBeenCalledOnce());
      const allowing = coordinator.decide('granted', 'ios');
      // Refused: the account holds phone B's newer denial, which this Allow never saw.
      recovered.resolve(phoneBDenial);
      await Promise.all([syncing, allowing]);
      expect(writeAccountConsent).toHaveBeenLastCalledWith(
        'account-a',
        expect.objectContaining({ analytics: 'granted', basedOnDecidedAt: accountGrant.decidedAt }),
      );
      expect(coordinator.getSnapshot().record).toEqual(ownedByA(phoneBDenial));
    });
  });
  describe('mergeAccountConsent', () => {
    const later = (record: ConsentRecord, decidedAt: string) => ({ ...record, decidedAt });
    const decidedLater = (record: ConsentRecord) => later(record, '2026-10-09T00:00:00.000Z');
    it.each([
      ['no device answer, no account answer', null, null, null, null],
      ['signed-out grant, no account answer', grant, null, null, null],
      ['signed-out denial, no account answer', denial, null, null, null],
      ['signed-out grant, account grant', grant, grant, ownedByA(grant), null],
      ['signed-out grant, account denial', grant, denial, ownedByA(denial), null],
      ['signed-out denial, account grant', denial, grant, denial, null],
      ['signed-out denial, account denial', denial, denial, ownedByA(denial), null],
      ['adopted denial, newer account grant', ownedByA(denial), decidedLater(grant), ownedByA(denial), null],
      ['adopted denial, account grant at the same moment', ownedByA(denial), grant, ownedByA(denial), null],
      ['adopted grant, account denial at the same moment', ownedByA(grant), denial, ownedByA(denial), null],
      [
        'adopted denial stamped later than an account grant (never written)',
        ownedByA(decidedLater(denial)),
        grant,
        ownedByA(decidedLater(denial)),
        null,
      ],
      [
        'unconfirmed denial made against the current account grant',
        unconfirmedByA(decidedLater(denial), grant.decidedAt),
        grant,
        unconfirmedByA(decidedLater(denial), grant.decidedAt),
        unconfirmedByA(decidedLater(denial), grant.decidedAt),
      ],
      [
        'unconfirmed denial made against an older answer',
        unconfirmedByA(decidedLater(denial), '2026-10-01T00:00:00.000Z'),
        grant,
        unconfirmedByA(decidedLater(denial), '2026-10-01T00:00:00.000Z'),
        null,
      ],
      [
        'unconfirmed grant made against the current account denial',
        unconfirmedByA(decidedLater(grant), denial.decidedAt),
        denial,
        unconfirmedByA(decidedLater(grant), denial.decidedAt),
        unconfirmedByA(decidedLater(grant), denial.decidedAt),
      ],
      [
        'unconfirmed grant made against an older answer, account now denied',
        unconfirmedByA(decidedLater(grant), '2026-10-01T00:00:00.000Z'),
        denial,
        ownedByA(denial),
        null,
      ],
      [
        'unconfirmed answer that matches the account',
        unconfirmedByA(decidedLater(grant), null),
        grant,
        ownedByA(grant),
        null,
      ],
      [
        'unconfirmed grant, no account answer',
        unconfirmedByA(grant, null),
        null,
        unconfirmedByA(grant, null),
        unconfirmedByA(grant, null),
      ],
      ['adopted grant, no account answer', ownedByA(grant), null, ownedByA(grant), null],
      [
        'unconfirmed denial, first answer this account ever gives',
        unconfirmedByA(denial, null),
        null,
        unconfirmedByA(denial, null),
        unconfirmedByA(denial, null),
      ],
      [
        'unconfirmed grant, account answer under an old version',
        unconfirmedByA(grant, denial.decidedAt),
        { ...denial, version: 0 },
        unconfirmedByA(grant, denial.decidedAt),
        unconfirmedByA(grant, denial.decidedAt),
      ],
    ] as const)('%s', (_description, local, server, record, push) => {
      expect(mergeAccountConsent(local, server, 'account-a')).toEqual({ record, push });
    });
  });
  it('rejects malformed persisted pending decisions', () => {
    expect(
      parsePendingConsentDecision({ record: { ...grant, analytics: 'maybe' }, basedOnDecidedAt: null }),
    ).toBeNull();
    expect(parsePendingConsentDecision({ record: { ...grant, version: 0 }, basedOnDecidedAt: null })).toBeNull();
    expect(
      parsePendingConsentDecision({ record: denial, basedOnDecidedAt: grant.decidedAt, conditional: 'yes' }),
    ).toBeNull();
  });
  it('keeps the recovered-write marker through pending storage', () => {
    expect(
      parsePendingConsentDecision({ record: denial, basedOnDecidedAt: grant.decidedAt, conditional: true }),
    ).toEqual({ record: denial, basedOnDecidedAt: grant.decidedAt, conditional: true });
    expect(parsePendingConsentDecision({ record: denial, basedOnDecidedAt: null })).toEqual({
      record: denial,
      basedOnDecidedAt: null,
    });
  });
});
