// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode } from 'react';

// #5960: on the glass sheet the body copy and the URL were light grey and hard
// to read, and the URL sat right against the buttons.

const COLORS = {
  label: '#LABEL',
  secondaryLabel: '#SECONDARY',
  tertiaryLabel: '#TERTIARY',
  secondaryBackground: '#BG',
};

type TextMockProps = { children?: ReactNode; color?: string; style?: { marginBottom?: number } };
vi.mock('react-native', () => ({
  Share: { share: vi.fn() },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('../../use-sheet-column-style', () => ({ useSheetColumnStyle: () => ({ height: 368 }) }));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  default: forwardRef(function BottomSheetMock({ children }: { children?: ReactNode }, _ref) {
    return createElement('div', null, children);
  }),
  BottomSheetView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  BottomSheetScrollView: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'share-scroll-body' }, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));
vi.mock('../../Text', () => ({
  Text: ({ children, color, style }: TextMockProps) =>
    createElement(
      'span',
      { 'data-color': color ?? '', 'data-margin-bottom': String(style?.marginBottom ?? 0) },
      children,
    ),
}));
vi.mock('../../Button', () => ({ Button: ({ title }: { title: string }) => createElement('button', null, title) }));
type TopBarMockProps = { title: string; leading?: { kind: string; onPress: () => void } };
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({ title, leading }: TopBarMockProps) =>
    createElement(
      'div',
      null,
      title,
      leading ? createElement('button', { 'data-testid': `leading-${leading.kind}`, onClick: leading.onPress }) : null,
    ),
}));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: COLORS }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: () => ({ onChange: vi.fn(), onFullyDismissed: vi.fn() }),
}));
vi.mock('../../sheet-snap-points', () => ({
  androidSafeSnapPoints: (points: string[]) => points,
  MEDIUM_LARGE_SNAP_POINTS: ['50%', '90%'],
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12 },
  sheetStyles: { indicator: {} },
}));

import { BoardShareSheet } from '../BoardShareSheet';

const URL = 'https://www.boardsesh.com/b/garage/40/list?wall=abc';

describe('BoardShareSheet text', () => {
  function renderSheet(onDismiss: () => void = vi.fn()) {
    return render(
      <BoardShareSheet visible onDismiss={onDismiss} shareUrl={URL} wallName="Garage" visibility="unlisted" />,
    );
  }

  it('keeps the QR code and actions in a scroll body at the medium detent', () => {
    const { getByTestId, getByText } = renderSheet();
    expect(getByTestId('share-scroll-body').contains(getByText('mobile.sprayShare.share'))).toBe(true);
  });

  it('closes from the top bar, which carries the title', () => {
    const onDismiss = vi.fn();
    const { getByTestId, getByText } = renderSheet(onDismiss);
    expect(getByText('mobile.sprayShare.title')).toBeTruthy();
    act(() => getByTestId('leading-close').click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('draws the body in the full label colour', () => {
    expect(renderSheet().getByText('mobile.sprayShare.unlistedBody').getAttribute('data-color')).toBe('#LABEL');
  });

  it('draws the URL in secondary label, spaced off the buttons', () => {
    const url = renderSheet().getByText(URL);
    expect(url.getAttribute('data-color')).toBe('#SECONDARY');
    expect(Number(url.getAttribute('data-margin-bottom'))).toBeGreaterThan(0);
  });
});
