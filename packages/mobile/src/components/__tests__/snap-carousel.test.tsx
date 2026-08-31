// @vitest-environment jsdom
//
// The rail's arithmetic, which is silent when it is wrong: a card that looks
// centred but is not, or a flick that moves the rail without moving the
// selection. Both shipped as bugs once — the first from pairing the centring
// inset with `snapToAlignment="center"` so the centring applied twice, the
// second from a slow release that produces no momentum event.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const flashList = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  scrollToIndex: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove: () => {} }),
  },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    flashList.props = props;
    const ref = props.ref as { current: unknown } | null;
    if (ref) ref.current = { scrollToIndex: flashList.scrollToIndex };
    return createElement('div', { 'data-testid': 'list' });
  },
}));

const { SnapCarousel, SNAP_CARD_GAP } = await import('../SnapCarousel');

const CARD_WIDTH = 300;
const WINDOW_WIDTH = 402;
const INTERVAL = CARD_WIDTH + SNAP_CARD_GAP;
const DATA = ['a', 'b', 'c', 'd', 'e'];

function renderRail(overrides: Record<string, unknown> = {}) {
  return render(
    <SnapCarousel
      data={DATA}
      cardWidth={CARD_WIDTH}
      renderItem={() => createElement('div')}
      keyExtractor={(item: string) => item}
      {...overrides}
    />,
  );
}

/** The props the mocked list received. */
function listProps(): Record<string, unknown> {
  return flashList.props ?? {};
}

/** One of the list's scroll callbacks, which the tests fire by hand. */
function listHandler(name: string): (event: unknown) => void {
  return listProps()[name] as (event: unknown) => void;
}

/** The leading content inset the rail resolved. */
function contentInset(): number | undefined {
  const style = listProps().contentContainerStyle as Array<Record<string, number> | undefined>;
  return style[0]?.paddingHorizontal;
}

function scrollEvent(offsetX: number, velocityX?: number) {
  return { nativeEvent: { contentOffset: { x: offsetX }, velocity: velocityX == null ? undefined : { x: velocityX } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  flashList.props = null;
});

afterEach(() => {
  cleanup();
});

describe('SnapCarousel — centring', () => {
  it('centres with an inset and snaps to the START of each interval', () => {
    // Pairing the inset with snapToAlignment="center" applies the centring twice
    // and pushes every card off to one side, so the trailing neighbour falls off
    // screen. The inset alone is what centres a rail.
    renderRail({ align: 'center', windowWidth: WINDOW_WIDTH });

    expect(listProps().snapToAlignment).toBe('start');
    expect(contentInset()).toBe((WINDOW_WIDTH - CARD_WIDTH) / 2);
  });

  it('leaves the default rail flush to the leading edge', () => {
    renderRail();

    expect(listProps().snapToAlignment).toBe('start');
    expect(contentInset()).toBe(16);
  });

  it('snaps one card at a time', () => {
    renderRail({ align: 'center', windowWidth: WINDOW_WIDTH });
    expect(listProps().snapToInterval).toBe(INTERVAL);
  });
});

describe('SnapCarousel — settling on a card', () => {
  it('reports the card a flick lands on', () => {
    const onSnapToIndex = vi.fn();
    renderRail({ align: 'center', windowWidth: WINDOW_WIDTH, onSnapToIndex });

    listHandler('onMomentumScrollEnd')(scrollEvent(INTERVAL * 2));

    expect(onSnapToIndex).toHaveBeenCalledWith(2);
  });

  it('rounds to the nearest card rather than truncating toward the start', () => {
    const onSnapToIndex = vi.fn();
    renderRail({ align: 'center', windowWidth: WINDOW_WIDTH, onSnapToIndex });

    // Most of the way to card 3 — the snap will land there, so the selection must.
    listHandler('onMomentumScrollEnd')(scrollEvent(INTERVAL * 2.7));

    expect(onSnapToIndex).toHaveBeenCalledWith(3);
  });

  it('never reports past either end', () => {
    const onSnapToIndex = vi.fn();
    renderRail({ align: 'center', windowWidth: WINDOW_WIDTH, onSnapToIndex });

    // Away from card 0 first: a card that has not changed is deliberately not
    // re-reported, so an over-scroll back to where we already are says nothing.
    listHandler('onMomentumScrollEnd')(scrollEvent(INTERVAL * 2));

    listHandler('onMomentumScrollEnd')(scrollEvent(-500));
    expect(onSnapToIndex).toHaveBeenLastCalledWith(0);

    listHandler('onMomentumScrollEnd')(scrollEvent(INTERVAL * 99));
    expect(onSnapToIndex).toHaveBeenLastCalledWith(DATA.length - 1);
  });

  it('reports a card once, not on every frame it stays centred', () => {
    // The gate that makes an every-frame `onScroll` affordable: the host
    // re-renders a rail of board images per selection.
    const onSnapToIndex = vi.fn();
    renderRail({ align: 'center', windowWidth: WINDOW_WIDTH, onSnapToIndex });

    listHandler('onScrollBeginDrag')(scrollEvent(0));
    listHandler('onScroll')(scrollEvent(INTERVAL * 0.9));
    listHandler('onScroll')(scrollEvent(INTERVAL * 1.05));
    listHandler('onScroll')(scrollEvent(INTERVAL * 1.1));

    expect(onSnapToIndex).toHaveBeenCalledTimes(1);
    expect(onSnapToIndex).toHaveBeenCalledWith(1);
  });

  it('still settles when a slow release produces no momentum', () => {
    // The gap: no flick means no momentum scroll and no momentum-end event, so
    // the rail snapped to a new card while the selection stayed on the old one —
    // the button would name a look that is no longer under your eye.
    const onSnapToIndex = vi.fn();
    renderRail({ align: 'center', windowWidth: WINDOW_WIDTH, onSnapToIndex });

    listHandler('onScrollEndDrag')(scrollEvent(INTERVAL * 1.9, 0));

    expect(onSnapToIndex).toHaveBeenCalledWith(2);
  });

  it('leaves a flick to the momentum handler, so one gesture settles once', () => {
    const onSnapToIndex = vi.fn();
    renderRail({ align: 'center', windowWidth: WINDOW_WIDTH, onSnapToIndex });

    listHandler('onScrollEndDrag')(scrollEvent(INTERVAL, 1.4));

    expect(onSnapToIndex).not.toHaveBeenCalled();
  });

  it('wires no scroll handlers at all when the host does not want them', () => {
    // The settings rail: selection there writes straight through to the physical
    // board's LEDs, so a swipe must never pick a card.
    renderRail({ align: 'center', windowWidth: WINDOW_WIDTH });

    expect(listProps().onMomentumScrollEnd).toBeUndefined();
    expect(listProps().onScrollEndDrag).toBeUndefined();
  });
});

describe('SnapCarousel — lighting up during the swipe', () => {
  it('marks a card selected as it crosses the middle, not when the rail stops', () => {
    // Waiting for the scroll to settle left the new card looking unchosen for the
    // whole glide — it expanded and drew its border noticeably late.
    const onSnapToIndex = vi.fn();
    renderRail({ align: 'center', windowWidth: WINDOW_WIDTH, onSnapToIndex });

    listHandler('onScrollBeginDrag')(scrollEvent(0));
    listHandler('onScroll')(scrollEvent(INTERVAL * 0.6));

    expect(onSnapToIndex).toHaveBeenCalledWith(1);
  });

  it('ignores scroll frames the climber did not cause', () => {
    // A programmatic scrollToIndex passes over every card on the way to its
    // target; counting those would strobe the selection across each one.
    const onSnapToIndex = vi.fn();
    renderRail({ align: 'center', windowWidth: WINDOW_WIDTH, onSnapToIndex });

    listHandler('onScroll')(scrollEvent(INTERVAL * 2));

    expect(onSnapToIndex).not.toHaveBeenCalled();
  });

  it('stops treating frames as the climber\u2019s once the rail has stopped', () => {
    const onSnapToIndex = vi.fn();
    renderRail({ align: 'center', windowWidth: WINDOW_WIDTH, onSnapToIndex });

    listHandler('onScrollBeginDrag')(scrollEvent(0));
    listHandler('onMomentumScrollEnd')(scrollEvent(INTERVAL));
    onSnapToIndex.mockClear();

    listHandler('onScroll')(scrollEvent(INTERVAL * 3));

    expect(onSnapToIndex).not.toHaveBeenCalled();
  });
});

describe('SnapCarousel — following the selection', () => {
  it('brings a card picked by tap to the centre', () => {
    const { rerender } = renderRail({ align: 'center', windowWidth: WINDOW_WIDTH, activeIndex: 0 });

    rerender(
      <SnapCarousel
        data={DATA}
        cardWidth={CARD_WIDTH}
        renderItem={() => createElement('div')}
        keyExtractor={(item: string) => item}
        align="center"
        windowWidth={WINDOW_WIDTH}
        activeIndex={3}
      />,
    );

    expect(flashList.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 3 }));
  });

  it('does not bounce the rail back to where it already is', () => {
    // A selection the rail itself produced would otherwise scroll it mid-gesture.
    const onSnapToIndex = vi.fn();
    const { rerender } = renderRail({
      align: 'center',
      windowWidth: WINDOW_WIDTH,
      activeIndex: 0,
      onSnapToIndex,
    });

    // The rail settles on card 2 by itself, and the host echoes that back.
    listHandler('onMomentumScrollEnd')(scrollEvent(INTERVAL * 2));
    flashList.scrollToIndex.mockClear();

    rerender(
      <SnapCarousel
        data={DATA}
        cardWidth={CARD_WIDTH}
        renderItem={() => createElement('div')}
        keyExtractor={(item: string) => item}
        align="center"
        windowWidth={WINDOW_WIDTH}
        activeIndex={2}
        onSnapToIndex={onSnapToIndex}
      />,
    );

    expect(flashList.scrollToIndex).not.toHaveBeenCalled();
  });
});
