// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFullLogbookSheet } from '../use-full-logbook-sheet';

function renderSheetState(initialClimbUuid: string | undefined) {
  return renderHook(({ climbUuid }: { climbUuid: string | undefined }) => useFullLogbookSheet(climbUuid), {
    initialProps: { climbUuid: initialClimbUuid },
  });
}

describe('useFullLogbookSheet', () => {
  it('opens for the displayed climb and closes on request', () => {
    const { result } = renderSheetState('climb-a');
    expect(result.current.climbUuid).toBeNull();

    act(() => result.current.open());
    expect(result.current.climbUuid).toBe('climb-a');

    act(() => result.current.close());
    expect(result.current.climbUuid).toBeNull();
  });

  it('closes when the displayed climb changes under it', () => {
    const { result, rerender } = renderSheetState('climb-a');
    act(() => result.current.open());

    rerender({ climbUuid: 'climb-b' });
    expect(result.current.climbUuid).toBeNull();
  });

  // The sheet's own onClose never fires for a programmatic dismiss, so the
  // climb has to be forgotten here or coming back to it reopens the sheet.
  it('stays closed when the climber lands back on the climb it was opened for', () => {
    const { result, rerender } = renderSheetState('climb-a');
    act(() => result.current.open());

    rerender({ climbUuid: 'climb-b' });
    rerender({ climbUuid: 'climb-a' });
    expect(result.current.climbUuid).toBeNull();
  });

  it('stays closed when there is no climb to open for', () => {
    const { result } = renderSheetState(undefined);
    act(() => result.current.open());
    expect(result.current.climbUuid).toBeNull();
  });
});
