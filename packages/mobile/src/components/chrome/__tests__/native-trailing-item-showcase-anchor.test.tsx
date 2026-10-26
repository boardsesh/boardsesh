// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const anchorCalls = vi.hoisted(() => ({ names: [] as string[] }));

type BoxProps = { style?: unknown; children?: ReactNode; onLayout?: unknown; pointerEvents?: string };
const flatten = (style: unknown): Record<string, unknown> =>
  Array.isArray(style)
    ? Object.assign({}, ...style.map(flatten))
    : typeof style === 'object' && style !== null
      ? (style as Record<string, unknown>)
      : {};

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  View: ({ style, pointerEvents, onLayout }: BoxProps) =>
    createElement('div', {
      'data-box': JSON.stringify(flatten(style)),
      'data-pointer-events': pointerEvents,
      'data-measured': onLayout ? 'true' : 'false',
    }),
  useWindowDimensions: () => ({ width: 402, height: 874 }),
  // The theme tokens behind native-title-bound read these.
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  DynamicColorIOS: (colors: { light: string }) => colors.light,
  PlatformColor: (name: string) => name,
}));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 116 }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('../../../lib/showcase-anchor', () => ({
  useShowcaseAnchor: (name: string) => {
    anchorCalls.names.push(name);
    return { ref: undefined, onLayout: () => undefined };
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  anchorCalls.names = [];
});

async function loadAnchor(screenshotMode: boolean) {
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', screenshotMode ? '1' : '');
  vi.resetModules();
  return (await import('../NativeTrailingItemShowcaseAnchor')).NativeTrailingItemShowcaseAnchor;
}

describe('NativeTrailingItemShowcaseAnchor', () => {
  it('logs an untouchable 44pt box where history sits in the bar, in screenshot mode', async () => {
    const Anchor = await loadAnchor(true);
    const { container } = render(<Anchor name="board-history-button" positionFromEnd={1} />);
    const box = container.querySelector('[data-box]');
    // 402 - 16 margin - 44 (⋯) - 57 step back to history; centred in the 54pt bar below the 62pt inset.
    expect(JSON.parse(box?.getAttribute('data-box') ?? '{}')).toMatchObject({
      position: 'absolute',
      left: 285,
      top: 67,
      width: 44,
      height: 44,
    });
    expect(box?.getAttribute('data-pointer-events')).toBe('none');
    expect(box?.getAttribute('data-measured')).toBe('true');
    expect(anchorCalls.names).toEqual(['board-history-button']);
  });

  it('renders nothing outside screenshot mode', async () => {
    const Anchor = await loadAnchor(false);
    const { container } = render(<Anchor name="board-history-button" positionFromEnd={1} />);
    expect(container.innerHTML).toBe('');
  });
});
