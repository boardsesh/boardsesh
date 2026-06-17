// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  dismissedUuid: null as string | null,
  activeUuid: null as string | null,
  climbing: false,
}));

vi.mock('../../providers/queue-provider', () => ({
  useActiveClimbQueueItemUuid: () => cfg.activeUuid,
}));
vi.mock('../../lib/accessory-dismiss-store', () => ({
  useDismissedAccessoryUuid: () => cfg.dismissedUuid,
}));
vi.mock('../use-actively-climbing', () => ({
  useIsActivelyClimbing: () => cfg.climbing,
}));

import { useAccessoryDismissed } from '../use-accessory-dismissed';

describe('useAccessoryDismissed', () => {
  beforeEach(() => {
    cfg.dismissedUuid = null;
    cfg.activeUuid = null;
    cfg.climbing = false;
  });

  it('is false when there is no current climb', () => {
    cfg.dismissedUuid = 'climb-1';
    expect(renderHook(() => useAccessoryDismissed()).result.current).toBe(false);
  });

  it('is false when the current climb was never dismissed', () => {
    cfg.activeUuid = 'climb-1';
    expect(renderHook(() => useAccessoryDismissed()).result.current).toBe(false);
  });

  it('is true when the current climb is the dismissed one and not climbing', () => {
    cfg.activeUuid = 'climb-1';
    cfg.dismissedUuid = 'climb-1';
    expect(renderHook(() => useAccessoryDismissed()).result.current).toBe(true);
  });

  it('is false when actively climbing, even if the current climb was dismissed', () => {
    cfg.activeUuid = 'climb-1';
    cfg.dismissedUuid = 'climb-1';
    cfg.climbing = true;
    expect(renderHook(() => useAccessoryDismissed()).result.current).toBe(false);
  });

  it('is false when a different climb was the one dismissed', () => {
    cfg.activeUuid = 'climb-2';
    cfg.dismissedUuid = 'climb-1';
    expect(renderHook(() => useAccessoryDismissed()).result.current).toBe(false);
  });
});
