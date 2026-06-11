// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';

const cfg = vi.hoisted(() => ({
  placement: 'regular' as 'regular' | 'inline',
  currentClimbQueueItem: { climb: { uuid: 'c1', angle: 40 } } as unknown as ClimbQueueItem | null,
  sessionId: null as string | null,
}));

function dataValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

vi.mock('expo-router/unstable-native-tabs', () => ({
  NativeTabs: { BottomAccessory: { usePlacement: () => cfg.placement } },
}));

vi.mock('react-native', () => ({
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) => {
    const styles = Array.isArray(style) ? style : [style];
    const width = styles.reduce<unknown>((foundWidth, styleEntry) => {
      if (foundWidth != null) return foundWidth;
      return styleEntry != null && typeof styleEntry === 'object' && 'width' in styleEntry
        ? (styleEntry as { width?: unknown }).width
        : null;
    }, null);
    return createElement('div', { 'data-width': dataValue(width) }, children);
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }),
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({ state: { currentClimbQueueItem: cfg.currentClimbQueueItem }, sessionId: cfg.sessionId }),
}));
vi.mock('../../../theme/layout', () => ({
  glassSize: { standard: 56, inline: 44, capsule: 52 },
  NATIVE_BOTTOM_ACCESSORY_MAX_WIDTH: 344,
  NATIVE_BOTTOM_ACCESSORY_SCREEN_GUTTER: 32,
}));
vi.mock('../NativeAccessoryClimbRow', () => ({
  NativeAccessoryClimbRow: ({ placement, width }: { placement: 'regular' | 'inline'; width: number }) =>
    createElement('div', {
      'data-native-row': 'true',
      'data-placement': placement,
      'data-row-width': String(width),
    }),
}));
vi.mock('../NativeAccessoryRepTimerRow', () => ({
  NativeAccessoryRepTimerRow: ({ placement, width }: { placement: 'regular' | 'inline'; width: number }) =>
    createElement('div', {
      'data-native-timer-row': 'true',
      'data-placement': placement,
      'data-row-width': String(width),
    }),
}));
// Board-presence source flip: identity passthrough (flag off / no wall feed), so
// the accessory render-gate keys on the local queue head exactly as today.
vi.mock('../use-wall-or-queue-climb', () => ({
  useWallOrQueueCurrentClimb: (localClimb: unknown) => localClimb,
  useIsWallPinned: () => false,
}));

import { QueueBottomAccessory } from '../QueueBottomAccessory';

describe('QueueBottomAccessory', () => {
  beforeEach(() => {
    cfg.placement = 'regular';
    cfg.currentClimbQueueItem = { climb: { uuid: 'c1', angle: 40 } } as unknown as ClimbQueueItem;
    cfg.sessionId = null;
  });

  it('renders the native accessory row in regular placement', () => {
    const { container } = render(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row="true"]')).not.toBeNull();
    expect(container.querySelector('[data-placement="regular"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="search"]')).toBeNull();
    expect(container.querySelector('[data-native-timer-row]')).toBeNull();
  });

  it('renders the native rep timer row during an active session', () => {
    cfg.sessionId = 'session-1';
    const { container } = render(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-timer-row="true"]')).not.toBeNull();
    expect(container.querySelector('[data-placement="regular"]')).not.toBeNull();
    expect(container.querySelector('[data-native-row]')).toBeNull();
  });

  it('renders the native accessory row in inline placement', () => {
    cfg.placement = 'inline';
    const { container } = render(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row="true"]')).not.toBeNull();
    expect(container.querySelector('[data-placement="inline"]')).not.toBeNull();
  });

  it('keeps inline placement the same width as regular placement', () => {
    const regular = render(<QueueBottomAccessory />);
    const regularWidth = regular.container.querySelector('[data-width]')?.getAttribute('data-width');
    const regularRowWidth = regular.container.querySelector('[data-native-row]')?.getAttribute('data-row-width');
    regular.unmount();

    cfg.placement = 'inline';
    const inline = render(<QueueBottomAccessory />);
    const inlineWidth = inline.container.querySelector('[data-width]')?.getAttribute('data-width');
    const inlineRowWidth = inline.container.querySelector('[data-native-row]')?.getAttribute('data-row-width');

    expect(inlineWidth).toBe(regularWidth);
    expect(inlineWidth).toBe('344');
    expect(inlineRowWidth).toBe(regularRowWidth);
    expect(inlineRowWidth).toBe('344');
  });

  it('renders nothing without a current climb', () => {
    cfg.currentClimbQueueItem = null;
    const { container } = render(<QueueBottomAccessory />);
    expect(container.querySelector('[data-native-row]')).toBeNull();
  });
});
