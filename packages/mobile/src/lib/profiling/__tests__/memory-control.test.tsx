// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
vi.mock('../memory-profile', () => ({ MEMORY_PROFILING_ENABLED: true }));
import { acknowledgeMemoryBrowseControl, applyMemoryBrowseControl, useMemoryBrowseControl } from '../memory-control';

describe('memory browse command lifecycle', () => {
  it('does not replay a completed action when the list remounts', () => {
    const command = { commandId: 'open-1', action: 'open' as const, targetUuid: 'uuid-1', targetIndex: 0 };
    const first = renderHook(() => useMemoryBrowseControl());
    act(() => {
      expect(applyMemoryBrowseControl(command)).toBe('waiting');
    });
    expect(first.result.current).toEqual(command);
    act(() => {
      acknowledgeMemoryBrowseControl(command.commandId, 'complete');
    });
    expect(first.result.current).toBeNull();
    first.unmount();
    const replacement = renderHook(() => useMemoryBrowseControl());
    expect(replacement.result.current).toBeNull();
    expect(applyMemoryBrowseControl(command)).toBe('complete');
    expect(replacement.result.current).toBeNull();
    replacement.unmount();
  });
  it('ignores stale acknowledgements after command replacement', () => {
    const first = { commandId: 'scroll-old', action: 'scroll' as const, targetUuid: 'old', targetIndex: 0 };
    const second = { ...first, commandId: 'scroll-new', targetUuid: 'new', targetIndex: 1 };
    applyMemoryBrowseControl(first);
    applyMemoryBrowseControl(second);
    acknowledgeMemoryBrowseControl(first.commandId, 'complete');
    expect(applyMemoryBrowseControl(second)).toBe('waiting');
    acknowledgeMemoryBrowseControl(second.commandId, 'mismatch');
    expect(applyMemoryBrowseControl(second)).toBe('mismatch');
  });
});
