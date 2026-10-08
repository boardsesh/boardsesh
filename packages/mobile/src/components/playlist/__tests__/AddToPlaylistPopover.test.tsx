// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
import { act, render } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';

const native = vi.hoisted(() => ({
  measurements: [] as ((rootX: number, rootY: number) => void)[],
  popover: null as { visible: boolean; point: { x: number; y: number }; onClose: () => void } | null,
}));
vi.mock('react-native', () => ({
  View: forwardRef(({ children }: { children?: ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({
      measureInWindow: (callback: (rootX: number, rootY: number) => void) => native.measurements.push(callback),
    }));
    return createElement('div', null, children);
  }),
  TextInput: () => null,
  StyleSheet: { absoluteFill: {} },
  useWindowDimensions: () => ({ width: 1000, height: 900 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../navigation/PointAnchoredPopover', () => ({
  PointAnchoredPopover: (props: { visible: boolean; point: { x: number; y: number }; onClose: () => void }) => {
    native.popover = props;
    return createElement('div', { 'data-testid': 'native-host' });
  },
}));
vi.mock('../../ClimbPreviewCard', () => ({ ClimbPreviewCard: () => null }));
vi.mock('../../SheetTopBar', () => ({ SheetTopBar: () => null }));
vi.mock('../InlinePlaylistPicker', () => ({ InlinePlaylistPicker: () => null }));

import { AddToPlaylistPopover } from '../AddToPlaylistPopover';

const props = {
  visible: true,
  climb: { uuid: 'climb-1' } as Climb,
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1',
  angle: 40,
  onClose: vi.fn(),
};

describe('AddToPlaylistPopover native window anchor', () => {
  beforeEach(() => {
    native.measurements = [];
    native.popover = null;
    props.onClose.mockClear();
  });

  it('waits for the actual root origin and preserves the native host on close', () => {
    const anchorPoint = { x: 640, y: 300 };
    const { container, rerender } = render(<AddToPlaylistPopover {...props} anchorPoint={anchorPoint} />);
    const host = container.querySelector('[data-testid="native-host"]');
    expect(native.popover?.visible).toBe(false);
    act(() => native.measurements.shift()?.(100, 80));
    expect(native.popover).toMatchObject({ visible: true, point: { x: 540, y: 220 } });
    rerender(<AddToPlaylistPopover {...props} visible={false} anchorPoint={anchorPoint} />);
    expect(native.popover?.visible).toBe(false);
    expect(container.querySelector('[data-testid="native-host"]')).toBe(host);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('ignores an old measurement after another row supplies the anchor', () => {
    const { rerender } = render(<AddToPlaylistPopover {...props} anchorPoint={{ x: 640, y: 300 }} />);
    const oldMeasurement = native.measurements.shift();
    rerender(<AddToPlaylistPopover {...props} anchorPoint={{ x: 250, y: 170 }} />);
    act(() => oldMeasurement?.(100, 80));
    expect(native.popover?.visible).toBe(false);
    act(() => native.measurements.shift()?.(150, 30));
    expect(native.popover).toMatchObject({ visible: true, point: { x: 100, y: 140 } });
  });
});
