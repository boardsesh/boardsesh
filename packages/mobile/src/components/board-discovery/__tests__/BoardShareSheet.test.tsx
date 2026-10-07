// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
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
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  default: forwardRef(function BottomSheetMock({ children }: { children?: ReactNode }, _ref) {
    return createElement('div', null, children);
  }),
  BottomSheetView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
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
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: COLORS }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: () => ({ onChange: vi.fn(), onFullyDismissed: vi.fn() }),
}));
vi.mock('../../sheet-snap-points', () => ({ androidSafeSnapPoints: (points: string[]) => points }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12 },
  sheetStyles: { indicator: {} },
}));

import { BoardShareSheet } from '../BoardShareSheet';

const URL = 'https://www.boardsesh.com/b/garage/40/list?wall=abc';

describe('BoardShareSheet text', () => {
  function renderSheet() {
    return render(
      <BoardShareSheet visible onDismiss={vi.fn()} shareUrl={URL} wallName="Garage" visibility="unlisted" />,
    );
  }

  it('draws the body in the full label colour', () => {
    expect(renderSheet().getByText('mobile.sprayShare.unlistedBody').getAttribute('data-color')).toBe('#LABEL');
  });

  it('draws the URL in secondary label, spaced off the buttons', () => {
    const url = renderSheet().getByText(URL);
    expect(url.getAttribute('data-color')).toBe('#SECONDARY');
    expect(Number(url.getAttribute('data-margin-bottom'))).toBeGreaterThan(0);
  });
});
