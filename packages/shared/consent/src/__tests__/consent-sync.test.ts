import { describe, it, expect, vi } from 'vitest';
import {
  createConsentSyncCoordinator,
  parsePendingConsentDecision,
  type ConsentSyncInput,
  type PendingConsentDecision,
} from '../consent-sync';
import type { ConsentRecord } from '../consent-record';
const grant: ConsentRecord = { analytics: 'granted', version: 1, source: 'web', decidedAt: '2026-10-08T10:00:00.123Z' };
const denial: ConsentRecord = { ...grant, analytics: 'denied' };
function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function setup(record: ConsentRecord | null = null) {
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
  it('lets a shared-cookie withdrawal beat an older in-flight grant', async () => {
    const { coordinator, writeAccountConsent } = setup();
    const first = deferred<ConsentRecord>();
    writeAccountConsent.mockReturnValueOnce(first.promise).mockResolvedValueOnce(denial);
    const operation = coordinator.decide('granted', 'web');
    await vi.waitFor(() => expect(writeAccountConsent).toHaveBeenCalledTimes(1));
    coordinator.replaceLocalRecord(denial);
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
    ['newer withdrawal', { ...denial, decidedAt: '2026-10-08T10:00:01.000Z' }],
    ['same-second cookie withdrawal', { ...denial, decidedAt: '2026-10-08T10:00:00.000Z' }],
    ['newer consent version', { ...denial, version: 2, decidedAt: '2026-10-08T09:00:00.000Z' }],
  ])('preserves a %s against a restored pending grant', async (_description, localDenial) => {
    const writeAccountConsent = vi.fn(async () => localDenial);
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
    expect(writeAccountConsent).toHaveBeenCalledOnce();
    expect(writeAccountConsent).toHaveBeenCalledWith('account-a', expect.objectContaining({ analytics: 'denied' }));
    expect(persistLocalConsent.mock.calls.every(([record]) => record?.analytics === 'denied')).toBe(true);
    expect(persistPendingDecision).toHaveBeenCalledWith('account-a', {
      record: localDenial,
      basedOnDecidedAt: null,
    });
    expect(coordinator.getSnapshot()).toMatchObject({ record: localDenial, pending: false, accountResolved: true });
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
    const localDenial = { ...denial, decidedAt: '2026-10-08T11:00:00.000Z' };
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
      basedOnDecidedAt: null,
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
    expect(coordinator.getSnapshot().record).toEqual(externalDenial);
  });
  it('drops a rebased grant withdrawn while its durable write is pending', async () => {
    const withdrawal = deferred<ConsentRecord>();
    const rebasedStorageWrite = deferred<void>();
    const completedDenial = { ...denial, decidedAt: '2026-10-08T11:00:00.456Z' };
    const externalDenial = { ...denial, decidedAt: '2026-10-08T11:00:01.000Z' };
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
    expect(coordinator.getSnapshot()).toMatchObject({ record: externalDenial, pending: false });
  });
  it('does not restore an older grant after a withdrawal during the pending-decision read', async () => {
    const pendingRead = deferred<PendingConsentDecision | null>();
    const localDenial = { ...denial, decidedAt: '2026-10-08T11:00:00.000Z' };
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
    expect(coordinator.getSnapshot().record).toEqual(localDenial);
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
  it('rejects malformed persisted pending decisions', () => {
    expect(
      parsePendingConsentDecision({ record: { ...grant, analytics: 'maybe' }, basedOnDecidedAt: null }),
    ).toBeNull();
    expect(parsePendingConsentDecision({ record: { ...grant, version: 0 }, basedOnDecidedAt: null })).toBeNull();
  });
});
