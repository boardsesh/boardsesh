// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { BottomSheetMethods } from '@expo/ui/community/bottom-sheet';
import type { LayoutChangeEvent } from 'react-native';
const managed = vi.hoisted(() => ({
  handle: { snapToIndex: vi.fn() },
  onChange: vi.fn(),
  waitForPresentation: vi.fn(),
}));
vi.mock('../../../providers/sheet-presentation-provider', () => ({ useManagedSheet: () => managed }));
import { useStorySheetPresentation } from '../use-story-sheet-presentation';

beforeEach(() => vi.clearAllMocks());
it('requires the large detent, positive layout and settled presentation before capture', async () => {
  let finishPresentation!: (result: { status: 'presented' }) => void;
  managed.waitForPresentation.mockReturnValue(
    new Promise((resolve) => {
      finishPresentation = resolve;
    }),
  );
  const sheetRef: { current: BottomSheetMethods | null } = { current: null };
  const { result } = renderHook(() => useStorySheetPresentation(sheetRef));
  expect(managed.handle.snapToIndex).toHaveBeenCalledExactlyOnceWith(1);
  act(() => {
    result.current.onLayout({ nativeEvent: { layout: { width: 360, height: 700 } } } as LayoutChangeEvent);
    result.current.onChange(0);
  });
  await act(async () => finishPresentation({ status: 'presented' }));
  expect(result.current.presented).toBe(false);
  act(() => result.current.onChange(1));
  expect(result.current.presented).toBe(true);
  expect(managed.onChange).toHaveBeenLastCalledWith(1);
  act(() => result.current.onChange(-1));
  expect(result.current.presented).toBe(false);
});
