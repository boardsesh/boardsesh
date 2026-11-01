// @vitest-environment jsdom
// The busy-wall question's pair (#7017): it draws a model and nothing else.
// Two segments in the wall button's family, Put mine up as "Put on the wall"
// with the bulb, Keep with the holder's face and a hairline, "Keep theirs"
// where the name won't fit, and stacked (Put mine up on top) where a label
// won't fit half the row. Nothing floats over the row above.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Children = { children?: ReactNode };
type LayoutEvent = { nativeEvent: { layout: { width: number; height: number } } };
type StyleFn = (state: { pressed: boolean }) => unknown;

const layouts = vi.hoisted(() => ({
  row: undefined as undefined | ((event: LayoutEvent) => void),
  labels: new Map<string, (event: LayoutEvent) => void>(),
}));
const flatten = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(10).filter((part) => part && typeof part === 'object'));

vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
    testID,
    style,
  }: Children & {
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityState?: { disabled?: boolean };
    testID?: string;
    style?: StyleFn;
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'aria-disabled': String(Boolean(accessibilityState?.disabled)),
        'data-testid': testID,
        'data-style': JSON.stringify(flatten(style?.({ pressed: false }))),
      },
      children,
    ),
}));
vi.mock('react-native', () => ({
  View: ({
    testID,
    children,
    style,
    onLayout,
  }: Children & { testID?: string; style?: unknown; onLayout?: (event: LayoutEvent) => void }) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'data-style': JSON.stringify(flatten(style)),
        ref: () => {
          if (testID === 'busy-wall-question') layouts.row = onLayout;
        },
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 0.5 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params?.person ? `${key}:${params.person}` : key),
  }),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, color, onLayout }: Children & { color?: string; onLayout?: (event: LayoutEvent) => void }) =>
    createElement(
      'span',
      {
        'data-color': color,
        'data-measure': onLayout ? 'true' : undefined,
        ref: () => {
          if (onLayout) layouts.labels.set(String(children), onLayout);
        },
      },
      children,
    ),
}));
vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({ children }: Children) => createElement('span', null, children),
}));
vi.mock('../../board-presence/BoardDriverAvatar', () => ({
  BoardDriverAvatar: ({ name }: { name?: string | null }) => createElement('i', { 'data-avatar': name ?? '?' }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#000', tertiaryFill: '#EEE', separator: '#CCC' },
    brandColors: { primary: '#6D28D9', primaryFill: '#6D28D9', live: '#B45309' },
  }),
}));
vi.mock('../../../theme/colors', () => ({ withAlpha: (color: string, alpha: number) => `${color}/${alpha}` }));
vi.mock('../../../theme/tokens', () => ({ androidRipple: () => undefined }));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.4 }));
vi.mock('../WallControlButton', () => ({ WALL_CONTROL_HEIGHT: 44 }));

import { BusyWallQuestionGroup } from '../BusyWallQuestionGroup';
import { resolveBusyWallQuestion, type BusyWallQuestionModel } from '../busy-wall-question';

const KEEP_NAMED = 'playView.wallState.commitOverride.cancelNamed:Test2';
const KEEP_SHORT = 'playView.wallState.commitOverride.cancel';
const PUT = 'playView.wallState.commitOverride.confirm';

const model = (overrides: Partial<Parameters<typeof resolveBusyWallQuestion>[0]> = {}): BusyWallQuestionModel =>
  resolveBusyWallQuestion({
    holder: { name: 'Test2', avatarUrl: null },
    wallClimbName: 'Crimp Ladder',
    selfHoldsBoard: true,
    ready: true,
    ...overrides,
  });

function renderGroup(question = model()) {
  const onKeep = vi.fn();
  const onPut = vi.fn();
  const view = render(createElement(BusyWallQuestionGroup, { model: question, onKeep, onPut }));
  return { ...view, onKeep, onPut };
}

/** Lays the row and the three hidden labels out at the given widths. */
function measure(rowWidth: number, widths: { put: number; keep: number; keepShort: number }) {
  act(() => {
    layouts.row?.({ nativeEvent: { layout: { width: rowWidth, height: 44 } } });
    layouts.labels.get(PUT)?.({ nativeEvent: { layout: { width: widths.put, height: 20 } } });
    layouts.labels.get(KEEP_NAMED)?.({ nativeEvent: { layout: { width: widths.keep, height: 20 } } });
    layouts.labels.get(KEEP_SHORT)?.({ nativeEvent: { layout: { width: widths.keepShort, height: 20 } } });
  });
}

const segments = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].map((node) => node.getAttribute('data-testid'));
const styleOf = (node: Element | null) =>
  JSON.parse(node?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
const visibleLabel = (button: Element | null) =>
  [...(button?.querySelectorAll('span[data-color]') ?? [])].map((node) => node.textContent).join('');

afterEach(() => {
  cleanup();
  layouts.labels.clear();
  layouts.row = undefined;
});

describe('BusyWallQuestionGroup', () => {
  it('draws Keep then Put mine up side by side, two equal segments of the wall button’s height and pill', () => {
    const { container } = renderGroup();
    expect(segments(container)).toEqual(['busy-wall-keep', 'busy-wall-put']);
    for (const segment of container.querySelectorAll('button')) {
      expect(styleOf(segment)).toMatchObject({ height: 44, borderRadius: 22, flex: 1 });
    }
    expect(styleOf(container.querySelector('[data-testid="busy-wall-question"]'))).toMatchObject({
      flexDirection: 'row',
      gap: 8,
    });
  });

  it('draws Put mine up as Put on the wall: the tonal lavender fill, the lavender label, the amber bulb', () => {
    const { container } = renderGroup();
    const put = container.querySelector('[data-testid="busy-wall-put"]');
    expect(styleOf(put)).toMatchObject({ backgroundColor: '#6D28D9/0.2' });
    expect(styleOf(put)).not.toHaveProperty('borderWidth');
    expect(visibleLabel(put)).toBe(PUT);
    expect(put?.querySelector('span[data-color="#6D28D9"]')).not.toBeNull();
    expect(put?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('lightbulb.fill');
    expect(put?.querySelector('[data-icon]')?.getAttribute('data-color')).toBe('#B45309');
  });

  it('draws an outline bulb on Put mine up while this phone doesn’t hold the board', () => {
    const { container } = renderGroup(model({ selfHoldsBoard: false }));
    const bulb = container.querySelector('[data-testid="busy-wall-put"] [data-icon]');
    expect(bulb?.getAttribute('data-icon')).toBe('lightbulb');
    expect(bulb?.getAttribute('data-color')).toBe('#6D28D9');
  });

  it('draws Keep in the neutral tonal fill with a hairline and the holder’s face', () => {
    const { container } = renderGroup();
    const keep = container.querySelector('[data-testid="busy-wall-keep"]');
    expect(styleOf(keep)).toMatchObject({ backgroundColor: '#EEE', borderWidth: 0.5, borderColor: '#CCC' });
    expect(keep?.querySelector('[data-avatar]')?.getAttribute('data-avatar')).toBe('Test2');
    expect(visibleLabel(keep)).toBe(KEEP_NAMED);
  });

  it('runs each answer’s own handler', () => {
    const { container, onKeep, onPut } = renderGroup();
    act(() => (container.querySelector('[data-testid="busy-wall-put"]') as HTMLButtonElement).click());
    expect(onPut).toHaveBeenCalledOnce();
    expect(onKeep).not.toHaveBeenCalled();
    act(() => (container.querySelector('[data-testid="busy-wall-keep"]') as HTMLButtonElement).click());
    expect(onKeep).toHaveBeenCalledOnce();
  });

  it('reads disabled while the model isn’t ready, without dimming', () => {
    const { container } = renderGroup(model({ ready: false }));
    for (const segment of container.querySelectorAll('button')) {
      expect(segment.getAttribute('aria-disabled')).toBe('true');
      expect(styleOf(segment)).not.toHaveProperty('opacity');
    }
  });

  it('says "Keep theirs" where the name won’t fit half the row, and still speaks the name', () => {
    const { container } = renderGroup();
    measure(361, { put: 85, keep: 150, keepShort: 80 });
    const keep = container.querySelector('[data-testid="busy-wall-keep"]');
    expect(visibleLabel(keep)).toBe(KEEP_SHORT);
    expect(keep?.getAttribute('aria-label')).toBe(KEEP_NAMED);
    expect(segments(container)).toEqual(['busy-wall-keep', 'busy-wall-put']);
  });

  it('stacks full width, Put mine up on top, where a label won’t fit half the row', () => {
    const { container } = renderGroup();
    measure(361, { put: 140, keep: 200, keepShort: 130 });
    expect(segments(container)).toEqual(['busy-wall-put', 'busy-wall-keep']);
    expect(styleOf(container.querySelector('[data-testid="busy-wall-question"]'))).toMatchObject({
      flexDirection: 'column',
    });
    for (const segment of container.querySelectorAll('button')) {
      expect(styleOf(segment)).toMatchObject({ alignSelf: 'stretch', height: 44 });
      expect(styleOf(segment)).not.toHaveProperty('flex');
    }
    expect(visibleLabel(container.querySelector('[data-testid="busy-wall-keep"]'))).toBe(KEEP_NAMED);
  });

  it('draws nothing absolute over the row above: the question is the header’s caption', () => {
    const { container } = renderGroup();
    const floating = [...container.querySelectorAll('div')].filter(
      (node) => styleOf(node).position === 'absolute' && styleOf(node).opacity !== 0,
    );
    expect(floating).toHaveLength(0);
    expect(container.textContent).not.toContain('busyWall.caption');
  });
});
