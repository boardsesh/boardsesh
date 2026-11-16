// @vitest-environment jsdom
//
// The picker's body: the order of its shelves, and the first touch it notes
// for Near you's slot (a tap or the start of a drag), without a re-render.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement, useContext, type ReactNode } from 'react';

type ScrollHandlers = { onTouchStart?: () => void; onScrollBeginDrag?: () => void };
const scrollCtrl = vi.hoisted(() => ({ handlers: {} as ScrollHandlers }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  StyleSheet: { create: <T,>(styles: T): T => styles, hairlineWidth: 0.5 },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children, onTouchStart, onScrollBeginDrag }: ScrollHandlers & { children?: ReactNode }) => {
    scrollCtrl.handlers = { onTouchStart, onScrollBeginDrag };
    return createElement('div', { 'data-testid': 'picker-scroll' }, children);
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { accent: '#ACCENT' } }) }));
vi.mock('../../Button', () => ({ Button: ({ title }: { title: string }) => createElement('button', null, title) }));
vi.mock('../../EmptyState', () => ({
  EmptyState: ({ title }: { title: string }) => createElement('div', { 'data-testid': 'empty-state' }, title),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

import { act } from 'react';
import { BoardSelectorView } from '../BoardSelectorView';
import { PickerTouchContext } from '../picker-touch';

afterEach(() => {
  cleanup();
  scrollCtrl.handlers = {};
});

const touchReads: Array<boolean | null> = [];
/** Reads the picker's touch as Near you's slot does, and counts its own renders. */
function TouchProbe() {
  const touched = useContext(PickerTouchContext);
  touchReads.push(touched?.current ?? null);
  return createElement('div', { 'data-testid': 'probe' }, String(touched !== null));
}
let probeRef: { current: boolean } | null = null;
function TouchRefCatcher() {
  probeRef = useContext(PickerTouchContext);
  return null;
}

function renderView(sections: { nearby?: ReactNode; banner?: ReactNode }) {
  return render(
    <BoardSelectorView
      scrollBottomPadding={0}
      onActiveBoardDetails={vi.fn()}
      showFirstBoardChoice={false}
      fromOnboarding={false}
      inRangeSection={<div data-testid="top" />}
      myBoardsSection={<div data-testid="your-boards" />}
      nearbySection={sections.nearby}
      locationBanner={sections.banner}
      hasBoards
      onEmptySetUpBoard={vi.fn()}
      onEmptyAddSprayWall={vi.fn()}
    />,
  );
}

function order(): string[] {
  return Array.from(screen.getByTestId('picker-scroll').querySelectorAll('[data-testid]')).map(
    (element) => element.getAttribute('data-testid') ?? '',
  );
}

describe('BoardSelectorView', () => {
  it('puts Near you between the top and Your boards', () => {
    renderView({ nearby: <div data-testid="near-you" /> });
    expect(order()).toEqual(['top', 'near-you', 'your-boards']);
  });

  it('puts the location banner at the foot, in place of Near you', () => {
    renderView({ banner: <div data-testid="banner" /> });
    expect(order()).toEqual(['top', 'your-boards', 'banner']);
  });

  it.each(['onTouchStart', 'onScrollBeginDrag'] as const)(
    'notes the first touch (%s) for Near you, without drawing anything again',
    (handler) => {
      touchReads.length = 0;
      renderView({
        nearby: (
          <>
            <TouchProbe />
            <TouchRefCatcher />
          </>
        ),
      });
      expect(probeRef?.current).toBe(false);
      const rendersBefore = touchReads.length;
      act(() => {
        scrollCtrl.handlers[handler]?.();
      });
      expect(probeRef?.current).toBe(true);
      expect(touchReads.length).toBe(rendersBefore);
    },
  );
});
