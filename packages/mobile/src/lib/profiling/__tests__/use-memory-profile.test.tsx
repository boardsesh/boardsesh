// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createMemoryCollector, type MemoryCommand } from '../memory-collector';

const runtime = vi.hoisted(() => ({
  collector: null as ReturnType<typeof createMemoryCollector> | null,
  command: '' as string,
  exports: [] as { commandId: string; valid: boolean; invalidReasons: string[]; appState: string }[],
  appStateListener: null as ((state: string) => void) | null,
  wake: null as (() => void) | null,
  pendingRenders: 0,
  drive: vi.fn(() => 'complete' as const),
  removed: vi.fn(),
}));
vi.mock('../memory-profile', () => ({
  MEMORY_PROFILING_ENABLED: true,
  memoryRunId: 'process',
  get memoryProfile() {
    return runtime.collector!;
  },
  registerMemoryExportWake: (wake: () => void) => {
    runtime.wake = wake;
    return () => {
      runtime.wake = null;
    };
  },
}));
vi.mock('../memory-control', () => ({ applyMemoryBrowseControl: runtime.drive }));
vi.mock('expo-router', () => ({ useSegments: () => ['(tabs)', 'home'] }));
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      runtime.appStateListener = listener;
      return { remove: runtime.removed };
    },
  },
}));
vi.mock('../../overlay-index', () => ({ getOverlayIndexSize: () => 200 }));
vi.mock('../../board-render/render-scheduler', () => ({
  getRenderSchedulerCounts: () => ({
    pendingRenders: runtime.pendingRenders,
    queuedRenders: runtime.pendingRenders,
    dispatchedRenders: 0,
  }),
}));
vi.mock('expo-file-system', () => ({
  Paths: { document: '/documents' },
  Directory: class {
    create() {}
  },
  File: class {
    get exists() {
      return runtime.command.length > 0;
    }
    get size() {
      return runtime.command.length;
    }
    text() {
      return Promise.resolve(runtime.command);
    }
    write(payload: string) {
      runtime.exports.push(JSON.parse(payload));
    }
  },
}));
import { useMemoryProfile } from '../use-memory-profile';
const begin: MemoryCommand = {
  schemaVersion: 1,
  commandId: 'begin',
  cycle: 1,
  surface: 'list',
  phase: 'settled',
  action: 'begin',
};
async function elapse(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
function submit(command: MemoryCommand) {
  runtime.command = JSON.stringify(command);
}

beforeEach(() => {
  vi.useFakeTimers();
  runtime.collector = createMemoryCollector(true, 'process');
  runtime.command = '';
  runtime.exports = [];
  runtime.pendingRenders = 0;
  runtime.drive.mockClear();
  runtime.removed.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Release memory mailbox', () => {
  it('never applies a previous-process control left on disk', async () => {
    submit({ ...begin, action: 'open', runId: 'old-process', targetUuid: 'climb', targetIndex: 0 });
    renderHook(() => useMemoryProfile());
    await elapse(31_000);
    expect(runtime.drive).not.toHaveBeenCalled();
    expect(runtime.exports.at(-1)).toMatchObject({ valid: false });
    expect(runtime.exports.at(-1)?.invalidReasons).toContain('process-replaced');
  });
  it('waits for render cleanup, then exports the current command exactly once', async () => {
    runtime.pendingRenders = 1;
    submit(begin);
    renderHook(() => useMemoryProfile());
    await elapse(1500);
    expect(runtime.exports).toEqual([]);
    runtime.pendingRenders = 0;
    await elapse(1000);
    expect(runtime.exports).toHaveLength(1);
    expect(runtime.exports[0]).toMatchObject({ commandId: 'begin', valid: true });
    await elapse(1000);
    expect(runtime.exports).toHaveLength(1);
  });
  it('exports verified background completion without waiting for the interval timer', async () => {
    submit(begin);
    renderHook(() => useMemoryProfile());
    await elapse(1000);
    submit({ ...begin, commandId: 'background', runId: 'process', action: 'checkpoint', phase: 'background' });
    await elapse(300);
    expect(runtime.exports).toHaveLength(1);
    await act(async () => {
      runtime.appStateListener?.('background');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runtime.exports).toHaveLength(1);
    const generation = runtime.collector!.clearStarted();
    await act(async () => {
      runtime.collector!.clearCompleted(generation, true);
      runtime.wake?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runtime.exports.at(-1)).toMatchObject({ commandId: 'background', valid: true, appState: 'background' });
  });
  it('marks incomplete captures invalid at the deadline and removes ownership on unmount', async () => {
    runtime.pendingRenders = 1;
    submit(begin);
    const mounted = renderHook(() => useMemoryProfile());
    await elapse(31_000);
    expect(runtime.exports.at(-1)?.invalidReasons).toContain('checkpoint-timeout');
    expect(runtime.exports.at(-1)?.invalidReasons).toContain('pending-renders');
    mounted.unmount();
    expect(runtime.removed).toHaveBeenCalledOnce();
    expect(runtime.wake).toBeNull();
    const exported = runtime.exports.length;
    await elapse(31_000);
    expect(runtime.exports).toHaveLength(exported);
  });
});
