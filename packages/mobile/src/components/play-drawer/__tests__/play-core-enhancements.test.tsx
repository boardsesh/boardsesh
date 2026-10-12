// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import {
  PlayCoreEnhancements,
  getPlayCoreEnhancementTargetKey,
  type PlayCoreEnhancementSnapshot,
} from '../PlayCoreEnhancements';
import { invalidatePrivacySnapshots } from '../../../lib/privacy/privacy-cache';
import type { useToggleFavorite } from '../../../lib/graphql/hooks';

type Mutate = ReturnType<typeof useToggleFavorite>['mutate'];
const hooks = vi.hoisted(() => ({
  favoriteStatus: vi.fn(),
  mutate: vi.fn<Mutate>(),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useFavoriteStatus: (...args: unknown[]) => {
    hooks.favoriteStatus(...args);
    return { data: true };
  },
  useToggleFavorite: () => ({ mutate: hooks.mutate }),
}));

const target = { boardName: 'kilter', climbUuid: 'climb-a', angle: 40 };
const variables = { input: target, currentlyFavorited: true };

beforeEach(() => vi.clearAllMocks());

function latestSnapshot(onSnapshot: ReturnType<typeof vi.fn<(snapshot: PlayCoreEnhancementSnapshot | null) => void>>) {
  const snapshot = onSnapshot.mock.calls.at(-1)?.[0];
  if (!snapshot) throw new Error('Expected a committed enhancement snapshot');
  return snapshot;
}

describe('PlayCoreEnhancements', () => {
  it('publishes scoped data after commit without adding a view and gates disabled reads', () => {
    const onSnapshot = vi.fn<(snapshot: PlayCoreEnhancementSnapshot | null) => void>();
    const { container, rerender } = render(<PlayCoreEnhancements {...target} enabled onSnapshot={onSnapshot} />);
    expect(container.childElementCount).toBe(0);
    expect(latestSnapshot(onSnapshot)).toMatchObject({
      ...target,
      targetKey: getPlayCoreEnhancementTargetKey('kilter', 'climb-a', 40),
      serverFavorited: true,
    });
    rerender(<PlayCoreEnhancements {...target} enabled={false} onSnapshot={onSnapshot} />);
    expect(onSnapshot).toHaveBeenLastCalledWith(null);
    expect(hooks.favoriteStatus).toHaveBeenLastCalledWith('kilter', 'climb-a', 40, { enabled: false });
  });

  it('retires delegates on target change, disable and unmount, including queued mutation callbacks', () => {
    const onSnapshot = vi.fn<(snapshot: PlayCoreEnhancementSnapshot | null) => void>();
    const { rerender, unmount } = render(<PlayCoreEnhancements {...target} enabled onSnapshot={onSnapshot} />);
    const snapshot = latestSnapshot(onSnapshot);
    const onError = vi.fn();
    snapshot.toggleFavoriteMutate(variables, { onError });
    expect(hooks.mutate).toHaveBeenCalledTimes(1);
    const capturedCallbacks = hooks.mutate.mock.calls[0][1];
    rerender(<PlayCoreEnhancements {...target} climbUuid="climb-b" enabled onSnapshot={onSnapshot} />);
    snapshot.toggleFavoriteMutate(variables);
    capturedCallbacks?.onError?.(new Error('late failure'), variables, undefined, {} as never);
    expect(hooks.mutate).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    const updatedSnapshot = latestSnapshot(onSnapshot);
    rerender(<PlayCoreEnhancements {...target} enabled onSnapshot={onSnapshot} />);
    snapshot.toggleFavoriteMutate(variables);
    capturedCallbacks?.onError?.(new Error('late failure after return'), variables, undefined, {} as never);
    expect(hooks.mutate).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    rerender(<PlayCoreEnhancements {...target} climbUuid="climb-b" enabled onSnapshot={onSnapshot} />);
    updatedSnapshot.toggleFavoriteMutate(variables);
    expect(hooks.mutate).toHaveBeenCalledTimes(1);
    rerender(<PlayCoreEnhancements {...target} climbUuid="climb-b" enabled={false} onSnapshot={onSnapshot} />);
    updatedSnapshot.toggleFavoriteMutate({ ...variables, input: { ...target, climbUuid: 'climb-b' } });
    expect(hooks.mutate).toHaveBeenCalledTimes(1);
    unmount();
    expect(onSnapshot).toHaveBeenLastCalledWith(null);
  });

  it.each(['privacy', 'credential'] as const)('rejects captured delegates immediately at %s boundaries', (reason) => {
    const onSnapshot = vi.fn<(snapshot: PlayCoreEnhancementSnapshot | null) => void>();
    const { unmount } = render(<PlayCoreEnhancements {...target} enabled onSnapshot={onSnapshot} />);
    const snapshot = latestSnapshot(onSnapshot);
    act(() => {
      invalidatePrivacySnapshots(reason);
      snapshot.toggleFavoriteMutate(variables);
    });
    expect(hooks.mutate).not.toHaveBeenCalled();
    expect(latestSnapshot(onSnapshot).privacyGeneration).toBeGreaterThan(snapshot.privacyGeneration);
    unmount();
  });
});
