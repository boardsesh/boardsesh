// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Flags = { resolved: boolean; showPlaceholder: boolean };

// A stand-in store with the real one's shape: stable snapshots and a listener
// set. The store's own behaviour is covered in launch-update-gate-store.test.ts.
const store = vi.hoisted(() => ({
  flags: { resolved: false, showPlaceholder: false } as Flags,
  progress: undefined as number | undefined,
  stage: 'checking' as 'checking' | 'installing',
  firstLaunch: false,
  listeners: new Set<() => void>(),
  start: vi.fn(),
}));

vi.mock('../../../lib/launch-update-gate-store', () => ({
  startLaunchUpdateGate: store.start,
  subscribeLaunchUpdateGate: (listener: () => void) => {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
  },
  getLaunchUpdateGateFlags: () => store.flags,
  getLaunchUpdateProgress: () => store.progress,
  getLaunchUpdateStage: () => store.stage,
  getLaunchUpdateFirstLaunch: () => store.firstLaunch,
}));

import {
  useLaunchUpdateFirstLaunch,
  useLaunchUpdateGate,
  useLaunchUpdateProgress,
  useLaunchUpdateStage,
} from '../use-launch-update-gate';

function publish(next: { flags?: Flags; progress?: number; stage?: 'checking' | 'installing'; firstLaunch?: boolean }) {
  act(() => {
    if (next.flags) store.flags = next.flags;
    if ('progress' in next) store.progress = next.progress;
    if (next.stage) store.stage = next.stage;
    if (next.firstLaunch !== undefined) store.firstLaunch = next.firstLaunch;
    for (const listener of store.listeners) listener();
  });
}

beforeEach(() => {
  store.flags = { resolved: false, showPlaceholder: false };
  store.progress = undefined;
  store.stage = 'checking';
  store.firstLaunch = false;
  store.listeners.clear();
  store.start.mockReset();
});

describe('useLaunchUpdateGate', () => {
  it('starts the gate before its first snapshot read, so a skipped launch is resolved on the first render', () => {
    store.start.mockImplementation(() => {
      store.flags = { resolved: true, showPlaceholder: false };
    });
    const renders: Flags[] = [];

    renderHook(() => {
      const flags = useLaunchUpdateGate({ development: true });
      renders.push(flags);
      return flags;
    });

    expect(store.start).toHaveBeenCalledExactlyOnceWith({ development: true });
    expect(renders[0]).toEqual({ resolved: true, showPlaceholder: false });
  });

  it('follows the store as the gate moves', () => {
    const { result } = renderHook(() => useLaunchUpdateGate());
    expect(result.current).toEqual({ resolved: false, showPlaceholder: false });

    publish({ flags: { resolved: false, showPlaceholder: true } });
    expect(result.current.showPlaceholder).toBe(true);

    publish({ flags: { resolved: true, showPlaceholder: false } });
    expect(result.current).toEqual({ resolved: true, showPlaceholder: false });
  });

  it('does not re-render its caller on download progress or a change of copy', () => {
    let renderCount = 0;
    renderHook(() => {
      renderCount += 1;
      return useLaunchUpdateGate();
    });
    const rendersBeforeProgress = renderCount;

    publish({ progress: 0.2 });
    publish({ progress: 0.6 });
    publish({ stage: 'installing', firstLaunch: true });

    expect(renderCount).toBe(rendersBeforeProgress);
  });

  it('reads the existing verdict on a remount instead of holding the launch again', () => {
    const first = renderHook(() => useLaunchUpdateGate());
    publish({ flags: { resolved: true, showPlaceholder: false } });
    first.unmount();

    const second = renderHook(() => useLaunchUpdateGate());

    expect(second.result.current.resolved).toBe(true);
  });
});

describe('useLaunchUpdateProgress', () => {
  it('follows download progress', () => {
    const { result } = renderHook(() => useLaunchUpdateProgress());
    expect(result.current).toBeUndefined();

    publish({ progress: 0.42 });
    expect(result.current).toBe(0.42);
  });
});

describe('useLaunchUpdateStage', () => {
  it('follows the copy from checking to installing', () => {
    const { result } = renderHook(() => useLaunchUpdateStage());
    expect(result.current).toBe('checking');

    publish({ stage: 'installing' });
    expect(result.current).toBe('installing');
  });
});

describe('useLaunchUpdateFirstLaunch', () => {
  it('follows whether this launch is a fresh install', () => {
    const { result } = renderHook(() => useLaunchUpdateFirstLaunch());
    expect(result.current).toBe(false);

    publish({ firstLaunch: true });
    expect(result.current).toBe(true);
  });
});
