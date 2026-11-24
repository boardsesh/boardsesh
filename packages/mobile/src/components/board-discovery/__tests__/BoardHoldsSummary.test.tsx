// @vitest-environment jsdom
//
// "Holds: 3 of 4 sets" in the builder's main form (#8151), and the nudge for a
// Masters 2019 entered without its Screw-on Feet, with a one-tap add.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS } from '@boardsesh/board-config';

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('p', { 'data-testid': testID }, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, testID }: { title: string; onPress: () => void; testID?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-testid': testID }, title),
}));
vi.mock('../../TextAction', () => ({
  TextAction: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-text-action': true }, label),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { warning: 'amber' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12 }, borderRadius: { md: 8 } }));

const { BoardHoldsSummary } = await import('../BoardHoldsSummary');

const MASTERS_2019 = MOONBOARD_LAYOUTS['moonboard-masters-2019'].id;
const masters2019Sets = MOONBOARD_SETS['moonboard-masters-2019'];

function renderSummary(overrides: Partial<Parameters<typeof BoardHoldsSummary>[0]> = {}) {
  const onAddSet = vi.fn();
  const onToggleExpanded = vi.fn();
  const rendered = render(
    createElement(BoardHoldsSummary, {
      boardName: 'moonboard',
      layoutId: MASTERS_2019,
      sets: masters2019Sets,
      selectedSetIds: [17, 18, 19, 21, 22, 23],
      expanded: false,
      onToggleExpanded,
      onAddSet,
      ...overrides,
    }),
  );
  return { ...rendered, onAddSet, onToggleExpanded };
}

describe('BoardHoldsSummary', () => {
  it('counts the sets picked against the sets the size offers', () => {
    const { getByTestId } = renderSummary();
    expect(getByTestId('board-holds-count').textContent).toBe('mobile.create.holdsSummary {"selected":6,"count":7}');
  });

  it('asks about the missing Screw-on Feet and adds them in one tap', () => {
    const { getByTestId, onAddSet } = renderSummary();
    expect(getByTestId('board-holds-omission-20').textContent).toContain(
      'mobile.create.omissionHint {"set":"Screw-on Feet"}',
    );
    fireEvent.click(getByTestId('board-holds-add-20'));
    expect(onAddSet).toHaveBeenCalledWith(20);
  });

  it('says nothing once the feet are picked, or on a layout with no such set', () => {
    const withFeet = renderSummary({ selectedSetIds: [17, 18, 19, 20] });
    expect(withFeet.queryByTestId('board-holds-omission-20')).toBeNull();
    withFeet.unmount();
    const moon2016 = renderSummary({
      layoutId: MOONBOARD_LAYOUTS['moonboard-2016'].id,
      sets: MOONBOARD_SETS['moonboard-2016'],
      selectedSetIds: [2],
    });
    expect(moon2016.container.querySelector('[data-testid^="board-holds-omission"]')).toBeNull();
  });

  it('opens and closes the set chips', () => {
    const closed = renderSummary();
    fireEvent.click(closed.getByText('mobile.create.holdsChange'));
    expect(closed.onToggleExpanded).toHaveBeenCalledTimes(1);
    closed.unmount();
    const open = renderSummary({ expanded: true });
    expect(open.getByText('mobile.create.holdsDone')).toBeTruthy();
  });

  it('shows only the count on a locked setup', () => {
    const { getByTestId, queryByTestId, container } = renderSummary({ disabled: true });
    expect(getByTestId('board-holds-count')).toBeTruthy();
    expect(queryByTestId('board-holds-omission-20')).toBeNull();
    expect(container.querySelector('[data-text-action]')).toBeNull();
  });
});
