// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

type ViewMockProps = {
  children?: ReactNode;
  style?: unknown;
  testID?: string;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
};

vi.mock('react-native', () => ({
  View: ({ children, style, testID, onLayout }: ViewMockProps) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        onClick: onLayout ? () => onLayout({ nativeEvent: { layout: { height: 112 } } }) : undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-paper', () => ({
  Appbar: {
    Header: ({ children, elevated }: { children?: ReactNode; elevated?: boolean }) =>
      createElement('div', { 'data-appbar': 'true', 'data-elevated': String(elevated) }, children),
  },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#0F0B16' },
    m3SurfaceContainers: { base: '#221A33' },
  }),
}));

import { MaterialTopAppBar } from '../MaterialTopAppBar';
import { createScrollEdgeBackdrop, useScrollEdgeBackdrop } from '../../../hooks/use-scroll-edge-backdrop';

const scrollTo = (y: number) =>
  ({ nativeEvent: { contentOffset: { x: 0, y } } }) as unknown as NativeSyntheticEvent<NativeScrollEvent>;

const bandStyle = (root: HTMLElement) =>
  JSON.parse(root.querySelector('[data-testid="bar"]')?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;

describe('MaterialTopAppBar', () => {
  it('is flat surface with no divider at rest, under the status bar', () => {
    const { container } = render(
      <MaterialTopAppBar testID="bar" onHeightChange={vi.fn()} scrollEdge={createScrollEdgeBackdrop()}>
        <span>Title</span>
      </MaterialTopAppBar>,
    );
    expect(bandStyle(container)).toMatchObject({ backgroundColor: '#0F0B16', paddingTop: 24 });
    expect(bandStyle(container)).not.toHaveProperty('borderBottomWidth');
    expect(container.querySelector('[data-appbar]')?.getAttribute('data-elevated')).toBe('false');
  });

  it('tints to surfaceContainer once the list scrolls under it, and back at rest', () => {
    const edge = createScrollEdgeBackdrop();
    const { container } = render(
      <MaterialTopAppBar testID="bar" onHeightChange={vi.fn()} scrollEdge={edge}>
        <span>Title</span>
      </MaterialTopAppBar>,
    );
    act(() => edge.listProps.onScroll(scrollTo(40)));
    expect(bandStyle(container).backgroundColor).toBe('#221A33');
    act(() => edge.listProps.onScroll(scrollTo(0)));
    expect(bandStyle(container).backgroundColor).toBe('#0F0B16');
  });

  it('stays flat when no list is wired', () => {
    const { container } = render(
      <MaterialTopAppBar testID="bar" onHeightChange={vi.fn()}>
        <span>Title</span>
      </MaterialTopAppBar>,
    );
    expect(bandStyle(container).backgroundColor).toBe('#0F0B16');
  });

  it("attaches to the screen's store, which is what hands the list its scroll listeners", () => {
    let listWired: boolean | undefined;
    function Screen({ showBar }: { showBar: boolean }) {
      const scrollEdge = useScrollEdgeBackdrop();
      listWired = scrollEdge.list != null;
      return showBar ? (
        <MaterialTopAppBar onHeightChange={vi.fn()} scrollEdge={scrollEdge.backdrop}>
          <span>Title</span>
        </MaterialTopAppBar>
      ) : null;
    }
    const { rerender } = render(<Screen showBar />);
    expect(listWired).toBe(true);
    rerender(<Screen showBar={false} />);
    expect(listWired).toBe(false);
  });

  it('reports the measured band height and renders rows below the bar', () => {
    const onHeightChange = vi.fn();
    const { container } = render(
      <MaterialTopAppBar testID="bar" onHeightChange={onHeightChange} below={<span data-below="true" />}>
        <span>Title</span>
      </MaterialTopAppBar>,
    );
    fireEvent.click(container.querySelector('[data-testid="bar"]')!);
    expect(onHeightChange).toHaveBeenCalledWith(112);
    expect(container.querySelector('[data-appbar] [data-below]')).toBeNull();
    expect(container.querySelector('[data-below]')).not.toBeNull();
  });
});
