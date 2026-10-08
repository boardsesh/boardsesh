// @vitest-environment jsdom
vi.mock('../AccessibleBottomSheetTextInput', async () => {
  const { BottomSheetTextInput } = await import('@expo/ui/community/bottom-sheet');
  return { AccessibleBottomSheetTextInput: BottomSheetTextInput };
});
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

const captured = vi.hoisted(() => ({
  sheetVisible: undefined as boolean | undefined,
  sheetProps: null as Record<string, unknown> | null,
  pickerProps: null as Record<string, unknown> | null,
  popoverProps: null as Record<string, unknown> | null,
  layout: { isPad: false, widthClass: 'compact' },
}));

vi.mock('../../hooks/use-device-layout', () => ({ useDeviceLayout: () => captured.layout }));
vi.mock('../playlist/AddToPlaylistPopover', () => ({
  AddToPlaylistPopover: (props: Record<string, unknown>) => {
    captured.popoverProps = props;
    return createElement('div', { 'data-native-popover': 'true' });
  },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetTextInput: function BottomSheetTextInput() {
    return null;
  },
  BottomSheetFlatList: function BottomSheetFlatList() {
    return null;
  },
}));

vi.mock('../ModalSheet', () => ({
  ModalSheet: ({ visible, children, ...rest }: { visible?: boolean; children?: ReactNode }) => {
    captured.sheetVisible = visible;
    captured.sheetProps = rest;
    return createElement('div', { 'data-modal-sheet': 'true' }, children);
  },
}));

vi.mock('../ClimbPreviewCard', () => ({
  ClimbPreviewCard: () => createElement('div', { 'data-climb-preview': 'true' }),
}));

vi.mock('../playlist/InlinePlaylistPicker', () => ({
  InlinePlaylistPicker: (props: Record<string, unknown>) => {
    captured.pickerProps = props;
    return createElement('div', { 'data-inline-picker': 'true' });
  },
}));

import { AddToPlaylistSheet } from '../AddToPlaylistSheet';

const climb = { uuid: 'climb-1', name: 'Big Move', frames: '' } as Climb;

function renderSheet(climbArg: Climb | null) {
  const onClose = vi.fn();
  const onFullyDismissed = vi.fn();
  return {
    onClose,
    onFullyDismissed,
    ...render(
      <AddToPlaylistSheet
        visible
        climb={climbArg}
        boardName="kilter"
        layoutId={1}
        sizeId={10}
        setIds="1,2"
        angle={40}
        onClose={onClose}
        onFullyDismissed={onFullyDismissed}
      />,
    ),
  };
}

describe('AddToPlaylistSheet', () => {
  beforeEach(() => {
    captured.sheetVisible = undefined;
    captured.sheetProps = null;
    captured.pickerProps = null;
    captured.popoverProps = null;
    captured.layout = { isPad: false, widthClass: 'compact' };
  });

  it('renders the preview + inline picker with the climb/board props when a climb is present', () => {
    const { container } = renderSheet(climb);
    expect(captured.sheetVisible).toBe(true);
    expect(container.querySelector('[data-climb-preview="true"]')).not.toBeNull();
    expect(container.querySelector('[data-inline-picker="true"]')).not.toBeNull();
    expect(captured.pickerProps).toMatchObject({
      climb,
      angle: 40,
      boardName: 'kilter',
      layoutId: 1,
    });
    // The sheet injects the native bottom-sheet text input + list so they scroll
    // with the sheet.
    expect(typeof captured.pickerProps?.TextInputComponent).toBe('function');
    expect(typeof captured.pickerProps?.ListComponent).toBe('function');
    // No back affordance in the sheet host.
    expect(captured.pickerProps?.onBack).toBeUndefined();
  });

  it('keeps the sheet closed and renders no picker when there is no climb', () => {
    const { container } = renderSheet(null);
    expect(captured.sheetVisible).toBe(false);
    expect(container.querySelector('[data-inline-picker="true"]')).toBeNull();
  });

  it('forwards the close + fully-dismissed lifecycle callbacks to ModalSheet', () => {
    const { onClose, onFullyDismissed } = renderSheet(climb);
    // The host clears its deferred sheet state on onFullyDismissed, so it must
    // reach the ModalSheet rather than being swallowed by the wrapper.
    expect(captured.sheetProps?.onClose).toBe(onClose);
    expect(captured.sheetProps?.onFullyDismissed).toBe(onFullyDismissed);
  });

  it('keeps the same anchored native host through resize and close, choosing afresh on reopen', () => {
    captured.layout = { isPad: true, widthClass: 'regular' };
    const onClose = vi.fn();
    const onFullyDismissed = vi.fn();
    const anchorPoint = { x: 640, y: 220 };
    const props = {
      climb,
      boardName: 'kilter' as const,
      layoutId: 1,
      sizeId: 10,
      setIds: '1',
      angle: 40,
      anchorPoint,
      onClose,
      onFullyDismissed,
    };
    const { container, rerender } = render(<AddToPlaylistSheet {...props} visible />);
    const nativeHost = container.querySelector('[data-native-popover]');
    expect(nativeHost).not.toBeNull();
    expect(captured.popoverProps).toMatchObject({ visible: true, anchorPoint });
    captured.layout.widthClass = 'compact';
    rerender(<AddToPlaylistSheet {...props} visible />);
    expect(container.querySelector('[data-native-popover]')).toBe(nativeHost);
    rerender(<AddToPlaylistSheet {...props} visible={false} />);
    expect(container.querySelector('[data-native-popover]')).toBe(nativeHost);
    expect(captured.popoverProps?.visible).toBe(false);
    expect(onFullyDismissed).not.toHaveBeenCalled();
    rerender(<AddToPlaylistSheet {...props} visible />);
    expect(container.querySelector('[data-native-popover]')).toBeNull();
    expect(captured.sheetVisible).toBe(true);
  });

  it('uses a sheet on regular iPad when no actual control anchor is supplied', () => {
    captured.layout = { isPad: true, widthClass: 'regular' };
    renderSheet(climb);
    expect(captured.sheetVisible).toBe(true);
    expect(captured.popoverProps).toBeNull();
  });
});
