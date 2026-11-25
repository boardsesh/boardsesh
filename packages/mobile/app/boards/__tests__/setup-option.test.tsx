// @vitest-environment jsdom
//
// Set up's pushed Layout or Size checklist: the catalogue's options, the
// current one ticked, a tap handed back to the form that pushed it. Opened with
// nothing to list or nobody to hand the pick to, it leaves instead of drawing
// an empty list.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Children = { children?: ReactNode };
const routerMock = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn(), canGoBack: vi.fn(() => true) }));
const state = vi.hoisted(() => ({ params: {} as Record<string, string | undefined> }));

vi.mock('react-native', () => ({
  ScrollView: ({ children }: Children) => createElement('div', { 'data-testid': 'list' }, children),
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
  useNavigation: () => ({ setOptions: vi.fn() }),
  useLocalSearchParams: () => state.params,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../src/components/ArtRow', () => ({
  ArtRow: ({ title, onPress, selected }: { title: string; onPress: () => void; selected: boolean }) =>
    createElement('button', { type: 'button', onClick: onPress, 'aria-pressed': selected }, title),
}));
vi.mock('../../../src/components/InsetGroupedList', () => ({
  InsetGroupedList: ({ children }: Children) => createElement('div', null, children),
}));
vi.mock('../../../src/components/boards/BoardThumbnail', () => ({ BoardThumbnail: () => null }));
vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../src/theme/tokens', () => ({ spacing: { 4: 16 } }));

const { default: SetupOptionList } = await import('../add/setup-option');
const { subscribeToSetupOptionPicks } = await import('../../../src/lib/boards/setup-option-handoff');

beforeEach(() => {
  vi.clearAllMocks();
  routerMock.canGoBack.mockReturnValue(true);
});

describe('/boards/add/setup-option', () => {
  it("lists a layout's sizes, ticks the current one, and hands a tap back to its form", () => {
    state.params = { field: 'size', boardType: 'kilter', layoutId: '8', selected: '25', handoffId: 'form-1' };
    const picks: unknown[] = [];
    const unsubscribe = subscribeToSetupOptionPicks('form-1', (pick) => picks.push(pick));
    render(createElement(SetupOptionList));
    const rows = screen.getAllByRole('button');
    expect(rows.length).toBeGreaterThan(8);
    expect(rows.filter((row) => row.getAttribute('aria-pressed') === 'true')).toHaveLength(1);

    fireEvent.click(rows[0] as HTMLElement);
    expect(picks).toHaveLength(1);
    expect(routerMock.back).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it.each([
    { name: 'no params at all', params: {} },
    { name: 'no form to hand the pick to', params: { field: 'size', boardType: 'kilter', layoutId: '8' } },
    { name: 'sizes with no layout', params: { field: 'size', boardType: 'kilter', handoffId: 'form-1' } },
  ])('goes back instead of an empty list with $name', ({ params }) => {
    state.params = params;
    const { container } = render(createElement(SetupOptionList));
    expect(container.innerHTML).toBe('');
    expect(routerMock.back).toHaveBeenCalledOnce();
  });

  it("goes to the wizard's step 1 when there is nothing to go back to", () => {
    routerMock.canGoBack.mockReturnValue(false);
    state.params = {};
    render(createElement(SetupOptionList));
    expect(routerMock.replace).toHaveBeenCalledExactlyOnceWith('/boards/add');
  });
});
