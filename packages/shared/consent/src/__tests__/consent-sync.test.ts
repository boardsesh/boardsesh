import { describe, it, expect, vi } from 'vitest';
import { createConsentSyncCoordinator, parsePendingConsentDecision } from '../consent-sync';
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
  it('rejects malformed persisted pending decisions', () => {
    expect(
      parsePendingConsentDecision({ record: { ...grant, analytics: 'maybe' }, basedOnDecidedAt: null }),
    ).toBeNull();
    expect(parsePendingConsentDecision({ record: { ...grant, version: 0 }, basedOnDecidedAt: null })).toBeNull();
  });
});
