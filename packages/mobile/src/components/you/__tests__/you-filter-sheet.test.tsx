// @vitest-environment jsdom
import { createElement, type ComponentProps, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedTimeframeType } from '@boardsesh/profile-stats';

const sheetHost = vi.hoisted(() => ({
  props: undefined as { ref: unknown; onChange: (index: number) => void; onFullyDismissed: () => void } | undefined,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { fill: '#eee' }, brandColors: { primary: '#123' } }),
}));
vi.mock('../../Sheet', () => ({
  Sheet: ({
    children,
    header,
    ...props
  }: NonNullable<typeof sheetHost.props> & { children: ReactNode; header: ReactNode }) => {
    sheetHost.props = props;
    return createElement('div', null, header, children);
  },
}));
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({ leading }: { leading: { onPress: () => void } }) =>
    createElement('button', { 'data-testid': 'close', onClick: leading.onPress }),
}));
vi.mock('../../SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ListRow', () => ({
  ListRow: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({ onSelect }: { onSelect: (timeframe: UnifiedTimeframeType) => void }) =>
    createElement('button', { 'data-testid': 'timeframe', onClick: () => onSelect('lastWeek') }),
}));

import { YouFilterSheet } from '../YouFilterSheet';

afterEach(() => {
  cleanup();
  sheetHost.props = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function renderSheet() {
  const close = vi.fn();
  const props: ComponentProps<typeof YouFilterSheet> = {
    sheetRef: { current: { close } } as unknown as ComponentProps<typeof YouFilterSheet>['sheetRef'],
    selectedBoard: 'all',
    onSelectBoard: vi.fn(),
    timeframe: 'all',
    onSelectTimeframe: vi.fn(),
  };
  return { props, close, ...render(createElement(YouFilterSheet, props)) };
}

describe('YouFilterSheet screenshot diagnostics', () => {
  it('keeps normal callbacks silent and forwards filter and close actions', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { props, close, getByRole, getByTestId } = renderSheet();
    expect(sheetHost.props?.ref).toBe(props.sheetRef);
    act(() => {
      sheetHost.props?.onChange(0);
      sheetHost.props?.onChange(-1);
      sheetHost.props?.onFullyDismissed();
    });
    fireEvent.click(getByRole('button', { name: 'mobile.filter.allBoards' }));
    fireEvent.click(getByTestId('timeframe'));
    fireEvent.click(getByTestId('close'));
    expect(props.onSelectBoard).toHaveBeenCalledExactlyOnceWith('all');
    expect(props.onSelectTimeframe).toHaveBeenCalledExactlyOnceWith('lastWeek');
    expect(close).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs only invoked callbacks in screenshot mode and keeps handlers stable', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.spyOn(Date, 'now').mockReturnValue(5678);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { props, rerender } = renderSheet();
    const initialCallbacks = sheetHost.props!;
    expect(log).not.toHaveBeenCalled();
    rerender(createElement(YouFilterSheet, { ...props, selectedBoard: 'kilter' }));
    expect(sheetHost.props?.onChange).toBe(initialCallbacks.onChange);
    expect(sheetHost.props?.onFullyDismissed).toBe(initialCallbacks.onFullyDismissed);
    act(() => {
      sheetHost.props?.onChange(0);
      sheetHost.props?.onChange(-1);
      sheetHost.props?.onFullyDismissed();
    });
    expect(log.mock.calls).toEqual([
      ['[showcase-profile-filter] {"event":"change","index":0,"timestampMs":5678}'],
      ['[showcase-profile-filter] {"event":"change","index":-1,"timestampMs":5678}'],
      ['[showcase-profile-filter] {"event":"fully-dismissed","timestampMs":5678}'],
    ]);
  });
});
