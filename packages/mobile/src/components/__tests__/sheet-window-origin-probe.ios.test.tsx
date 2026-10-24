// @vitest-environment jsdom
// What the iOS probe hands its @expo/ui `Host`. The SwiftUI tree can't mount
// under vitest, so the Host is captured, not rendered. Whether `.global` is the
// window inside a sheet is native behaviour this test cannot see; the on-device
// calibration readout exists to answer that (#5964).
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, createRef, isValidElement, useImperativeHandle, type ReactNode, type Ref } from 'react';
import type { View } from 'react-native';

const hostCalls = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
const nativeView = vi.hoisted(() => ({ measureInWindow: vi.fn() }));
const viewCalls = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

vi.mock('react-native', () => ({
  StyleSheet: { absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } },
  View: ({ ref, children, ...props }: { ref?: Ref<typeof nativeView>; children?: ReactNode }) => {
    useImperativeHandle(ref, () => nativeView);
    viewCalls.props.push(props);
    return createElement('div', null, children);
  },
}));

vi.mock('@expo/ui/swift-ui', () => ({
  Host: (props: Record<string, unknown> & { children?: ReactNode }) => {
    hostCalls.props.push(props);
    return createElement('div', null, props.children);
  },
  Spacer: () => null,
}));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  onGeometryChange: (handler: (frame: unknown) => void) => ({ kind: 'onGeometryChange', handler }),
}));

import { SheetWindowOriginProbe } from '../sheet-window-origin-probe.ios';

describe('SheetWindowOriginProbe (iOS)', () => {
  it('measures a native View, while the nested SwiftUI Host only reports geometry', () => {
    const onFrame = vi.fn();
    const ref = createRef<View>();
    const style = { position: 'absolute' as const, top: 0, left: 0, width: 1, height: 1 };
    render(<SheetWindowOriginProbe ref={ref} onFrame={onFrame} style={style} />);
    expect(ref.current).toBe(nativeView);
    expect(viewCalls.props.at(-1)).toMatchObject({ pointerEvents: 'none', collapsable: false, style });
    const props = hostCalls.props.at(-1);
    expect(props?.ref).toBeUndefined();
    // Ignore every safe area so no inset moves the probe's own content.
    expect(props?.ignoreSafeArea).toBe('all');
    expect(props?.style).toEqual({ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 });
    const modifiers = props?.modifiers as Array<{ kind: string; handler: (frame: unknown) => void }>;
    expect(modifiers.map((modifier) => modifier.kind)).toEqual(['onGeometryChange']);
    modifiers[0]?.handler({ x: 0, y: 72, width: 1, height: 1 });
    expect(onFrame).toHaveBeenCalledWith({ x: 0, y: 72, width: 1, height: 1 });
    // Host requires a child; a Spacer gives the root layout a size to report.
    expect(isValidElement(props?.children)).toBe(true);
  });
});
