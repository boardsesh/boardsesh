// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQueueClimbWriteDelivery } from '../use-queue-climb-write-delivery';
import { publishMutationDeliveryEvent } from '../../../offline/mutation-delivery-store';

const mocks = vi.hoisted(() => ({
  generation: 1,
  getFirstAsync: vi.fn(),
  latestMutation: vi.fn(),
  reportHandledError: vi.fn(),
}));
vi.mock('../../../db', () => ({ getDatabaseHandle: () => ({ getFirstAsync: mocks.getFirstAsync }) }));
vi.mock('@boardsesh/offline-sync', () => ({ getLatestClimbMutationKey: mocks.latestMutation }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({ getCredentialGeneration: () => mocks.generation }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: mocks.reportHandledError }));

const canonical = { name: 'Draft one', frames: 'p1r1p2r2', published_at: '2026-10-26T10:00:00.000Z', is_draft: 0 };
const acknowledged = {
  tableName: 'board_climbs',
  operation: 'create',
  idempotencyKey: 'climb:create:ABC',
  entityKey: 'climb:spray:ABC',
  status: 'acknowledged' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generation = 1;
  mocks.getFirstAsync.mockResolvedValue(canonical);
  mocks.latestMutation.mockResolvedValue(null);
});

describe('queued climb acknowledgement in the active queue', () => {
  it('clears the pending marker using canonical fields after the creator has closed', async () => {
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useQueueClimbWriteDelivery(refresh));
    act(() => publishMutationDeliveryEvent(acknowledged, vi.fn()));
    await waitFor(() =>
      expect(refresh).toHaveBeenCalledWith('ABC', {
        name: canonical.name,
        frames: canonical.frames,
        published_at: canonical.published_at,
        is_draft: false,
        localWritePending: false,
      }),
    );
    unmount();
  });

  it('keeps a later outstanding edit pending', async () => {
    mocks.latestMutation.mockResolvedValue('climb:update:later');
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useQueueClimbWriteDelivery(refresh));
    act(() => publishMutationDeliveryEvent(acknowledged, vi.fn()));
    await waitFor(() => expect(mocks.latestMutation).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
    unmount();
  });

  it('leaves rejected and unrelated writes alone', () => {
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useQueueClimbWriteDelivery(refresh));
    act(() => {
      publishMutationDeliveryEvent({ ...acknowledged, status: 'dead_letter' }, vi.fn());
      publishMutationDeliveryEvent({ ...acknowledged, tableName: 'boardsesh_ticks' }, vi.fn());
      publishMutationDeliveryEvent({ ...acknowledged, entityKey: 'climb:kilter:ABC' }, vi.fn());
    });
    expect(mocks.getFirstAsync).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    unmount();
  });

  it('fences a read completed after the account changes', async () => {
    mocks.getFirstAsync.mockImplementation(async () => {
      mocks.generation = 2;
      return canonical;
    });
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useQueueClimbWriteDelivery(refresh));
    act(() => publishMutationDeliveryEvent(acknowledged, vi.fn()));
    await waitFor(() => expect(mocks.latestMutation).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
    unmount();
  });

  it('does not refresh a provider that unmounted during the database read', async () => {
    let finishRead!: (climb: typeof canonical) => void;
    mocks.getFirstAsync.mockReturnValue(
      new Promise<typeof canonical>((resolve) => {
        finishRead = resolve;
      }),
    );
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useQueueClimbWriteDelivery(refresh));
    act(() => publishMutationDeliveryEvent(acknowledged, vi.fn()));
    unmount();
    await act(async () => {
      finishRead(canonical);
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
