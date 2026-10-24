// @vitest-environment jsdom
// What the iOS probe hands its @expo/ui `Host`. The SwiftUI tree can't mount
// under vitest, so the Host is captured, not rendered. Whether `.global` is the
// window inside a sheet is native behaviour this test cannot see; the on-device
// calibration readout exists to answer that (#5964).
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, isValidElement, type ReactNode } from 'react';

const hostCalls = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

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
  it('is a touch-transparent Host that reports its frame through onGeometryChange', () => {
    const onFrame = vi.fn();
    const style = { position: 'absolute' as const, top: 0, left: 0, width: 1, height: 1 };
    render(<SheetWindowOriginProbe onFrame={onFrame} style={style} />);
    const props = hostCalls.props.at(-1);
    expect(props?.pointerEvents).toBe('none');
    // Ignore every safe area so no inset moves the probe's own content.
    expect(props?.ignoreSafeArea).toBe('all');
    expect(props?.style).toBe(style);
    const modifiers = props?.modifiers as Array<{ kind: string; handler: (frame: unknown) => void }>;
    expect(modifiers.map((modifier) => modifier.kind)).toEqual(['onGeometryChange']);
    modifiers[0]?.handler({ x: 0, y: 72, width: 1, height: 1 });
    expect(onFrame).toHaveBeenCalledWith({ x: 0, y: 72, width: 1, height: 1 });
    // Host requires a child; a Spacer gives the root layout a size to report.
    expect(isValidElement(props?.children)).toBe(true);
  });
});
