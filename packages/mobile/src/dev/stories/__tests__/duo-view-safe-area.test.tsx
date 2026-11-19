// @vitest-environment jsdom
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const insets = vi.hoisted(() => ({ top: 12, bottom: 18, left: 0, right: 0 }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => insets }));
vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../../test/flatten-style');
  return {
    Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) => (
      <div data-testid={testID} data-style={JSON.stringify(flattenStyle(style))}>
        {children}
      </div>
    ),
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../lib/boardsesh-grade-display', () => ({ resolveDisplayGrade: () => ({ label: 'V4', color: 'red' }) }));
vi.mock('../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ gradeFormat: 'v-grade' }) }));
vi.mock('../../../components/ChromeIconButton', () => ({ ChromeIconButton: () => null }));
vi.mock('../../../components/play-drawer/PlayTopChromeView', () => ({
  PlayTopChromeView: () => <div data-testid="player-chrome" />,
}));
vi.mock('../../../components/play-drawer/PlayDrawerHeaderView', () => ({
  PlayDrawerHeader: () => <div data-testid="player-grade" />,
}));
vi.mock('../../../components/play-drawer/PlayDrawerActionBar', () => ({ PlayDrawerActionBar: () => null }));
vi.mock('../../../components/play-drawer/WallStatePillView', () => ({ WallStatePillView: () => null }));
vi.mock('../StoryBoard', () => ({ StoryBoard: () => <div data-testid="board" /> }));
// The swipeable board (the frost-following story) is off here: no pager, no carousel.
vi.mock('react-native-reanimated', () => ({
  useSharedValue: <Value,>(initial: Value) => ({ value: initial }),
  useAnimatedReaction: () => {},
}));
vi.mock('../../../components/play-drawer/use-wall-swap', () => ({ useWallSwap: () => ({ value: null }) }));
vi.mock('../../../components/play-drawer/SwipeBoardCarousel', () => ({ SwipeBoardCarousel: () => null }));
vi.mock('../../../components/play-drawer/use-swipe-pager', () => ({
  useSwipePager: () => ({ pager: {}, stepSignal: { direction: 0, step: 0 } }),
  useSwipeNavigation: () => {},
  useSwipePages: () => 0,
}));
vi.mock('../StorySprayBoard', () => ({ StorySprayBoard: () => null }));
vi.mock('../../../components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../components/Text', () => ({ Text: () => null }));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListHeaderComponent,
    contentContainerStyle,
    contentInsetAdjustmentBehavior,
  }: {
    data: { key: string }[];
    renderItem: (item: { item: { key: string }; index: number }) => ReactNode;
    ListHeaderComponent: ReactNode;
    contentContainerStyle: unknown;
    contentInsetAdjustmentBehavior: string;
  }) => (
    <div
      data-testid="list"
      data-style={JSON.stringify(contentContainerStyle)}
      data-adjustment={contentInsetAdjustmentBehavior}
    >
      {ListHeaderComponent}
      {data.map((item, index) => (
        <div key={item.key}>{renderItem({ item, index })}</div>
      ))}
    </div>
  ),
}));
import { PlayerScene } from '../PlayerScene';
import { SessionDetailView } from '../../../components/session/SessionDetailView';
import { HorizontalSafeAreaApplied, useHorizontalSafeArea } from '../../../hooks/use-horizontal-safe-area';
const noop = () => {};
const styleOf = (element: Element | null) => JSON.parse(element?.getAttribute('data-style') ?? '{}');
function InsetProbe({ id }: { id: string }) {
  return <div data-testid={id} data-insets={JSON.stringify(useHorizontalSafeArea())} />;
}
function Detail() {
  return (
    <SessionDetailView
      loading={false}
      found
      rows={[{ type: 'offPlan', key: 'one', count: 1 }]}
      renderItem={() => <InsetProbe id="row" />}
      header={<InsetProbe id="header" />}
      overlays={<InsetProbe id="overlay" />}
      paddingBottom={61}
    />
  );
}
beforeEach(() => Object.assign(insets, { top: 12, bottom: 18, left: 0, right: 0 }));
describe('Duo content bounds', () => {
  it.each([
    { left: 25, right: 84 },
    { left: 0, right: 0 },
  ])('keeps player grade and chrome within route bounds %j', (sides) => {
    Object.assign(insets, sides);
    const { getByTestId } = render(<PlayerScene onReady={noop} onError={noop} />);
    const stage = getByTestId('player-grade').parentElement;
    expect(stage?.contains(getByTestId('player-chrome'))).toBe(true);
    expect(stage?.contains(getByTestId('board'))).toBe(true);
    expect(styleOf(stage?.parentElement ?? null)).toMatchObject({
      paddingLeft: sides.left,
      paddingRight: sides.right,
      paddingTop: 12,
      paddingBottom: 18,
    });
  });
  it('honors ancestor-owned player clearance', () => {
    Object.assign(insets, { left: 25, right: 84 });
    const { getByTestId } = render(
      <HorizontalSafeAreaApplied>
        <PlayerScene onReady={noop} onError={noop} />
      </HorizontalSafeAreaApplied>,
    );
    expect(styleOf(getByTestId('player-grade').parentElement?.parentElement ?? null)).toMatchObject({
      paddingLeft: 0,
      paddingRight: 0,
    });
  });
  it('bounds header and rows together, suppresses nested padding, and leaves overlays outside', () => {
    Object.assign(insets, { left: 25, right: 84 });
    const { getByTestId, rerender } = render(<Detail />);
    const bounds = getByTestId('list').parentElement;
    expect(styleOf(bounds)).toMatchObject({ flex: 1, paddingLeft: 25, paddingRight: 84 });
    for (const id of ['header', 'row']) {
      expect(bounds?.contains(getByTestId(id))).toBe(true);
      expect(JSON.parse(getByTestId(id).getAttribute('data-insets')!)).toEqual({ left: 0, right: 0 });
    }
    expect(bounds?.contains(getByTestId('overlay'))).toBe(false);
    expect(JSON.parse(getByTestId('overlay').getAttribute('data-insets')!)).toEqual({ left: 25, right: 84 });
    expect(styleOf(getByTestId('list'))).toEqual({ paddingBottom: 61 });
    expect(getByTestId('list').getAttribute('data-adjustment')).toBe('automatic');
    Object.assign(insets, { left: 0, right: 0 });
    rerender(<Detail />);
    expect(styleOf(getByTestId('list').parentElement)).toMatchObject({ paddingLeft: 0, paddingRight: 0 });
  });
  it('does not pad session content again under an inset ancestor', () => {
    Object.assign(insets, { left: 25, right: 84 });
    const { getByTestId } = render(
      <HorizontalSafeAreaApplied>
        <Detail />
      </HorizontalSafeAreaApplied>,
    );
    expect(styleOf(getByTestId('list').parentElement)).toMatchObject({ paddingLeft: 0, paddingRight: 0 });
  });
});
