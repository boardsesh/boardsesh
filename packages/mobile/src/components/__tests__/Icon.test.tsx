// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';

// Controls the platform branch under test.
const ctrl = vi.hoisted(() => ({ os: 'ios' as string, fontScale: 1 }));

vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ fontScale: ctrl.fontScale }),
  I18nManager: { isRTL: false },
  Platform: {
    get OS() {
      return ctrl.os;
    },
  },
}));

// Stand-ins that surface the glyph name + colour so we can assert which renderer ran.
vi.mock('expo-symbols', () => ({
  SymbolView: ({
    name,
    tintColor,
    size,
    style,
  }: {
    name: string;
    tintColor?: string;
    size?: number;
    style?: { transform?: { translateY: number }[] };
  }) =>
    createElement('div', {
      'data-testid': 'symbol-view',
      'data-name': name,
      'data-tint': tintColor,
      'data-size': size,
      'data-translate-y': style?.transform?.[0]?.translateY,
    }),
}));

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: ({
    name,
    color,
    size,
    style,
  }: {
    name: string;
    color?: string;
    size?: number;
    // Surfaced so the "Android is never shifted" assertion is a real check: if
    // the optical correction ever escaped the iOS branch, it would land here.
    style?: { transform?: { translateY: number }[] };
  }) =>
    createElement('div', {
      'data-testid': 'mci',
      'data-name': name,
      'data-color': color,
      'data-size': size,
      'data-translate-y': style?.transform?.[0]?.translateY,
    }),
}));

import { Icon } from '../Icon';
import { iconMap } from '../icon-map';

beforeEach(() => {
  ctrl.os = 'ios';
  ctrl.fontScale = 1;
});

describe('Icon platform rendering', () => {
  it('renders an SF Symbol (SymbolView) with the ios glyph on iOS', () => {
    const { queryByTestId } = render(<Icon name="skip.next" color="#FF0000" />);
    const symbol = queryByTestId('symbol-view');
    expect(symbol).not.toBeNull();
    expect(queryByTestId('mci')).toBeNull();
    expect(symbol?.getAttribute('data-name')).toBe(iconMap['skip.next'].ios);
    expect(symbol?.getAttribute('data-tint')).toBe('#FF0000');
  });

  it('renders MaterialCommunityIcons with the android glyph on Android', () => {
    ctrl.os = 'android';
    const { queryByTestId } = render(<Icon name="skip.next" color="#00FF00" />);
    const mci = queryByTestId('mci');
    expect(mci).not.toBeNull();
    expect(queryByTestId('symbol-view')).toBeNull();
    expect(mci?.getAttribute('data-name')).toBe(iconMap['skip.next'].android);
    expect(mci?.getAttribute('data-color')).toBe('#00FF00');
  });

  // 18 and 26 are the smallest and largest sizes `check.small` is rendered at
  // (YouFilterSheet / RadioGroup at the low end, LogAscentToolbarButton at the
  // high end), so both ends of the range that has to stay centred are covered.
  it.each([18, 26])('shifts an ink-off-centre SF Symbol down by its recorded fraction of %ipt', (size) => {
    const ratio = iconMap['check.small'].iosOpticalCenterRatio;
    expect(ratio).toBeGreaterThan(0);

    const { queryByTestId } = render(<Icon name="check.small" size={size} />);
    expect(queryByTestId('symbol-view')?.getAttribute('data-translate-y')).toBe(String(size * ratio));
  });

  it('leaves glyphs without a recorded correction untransformed', () => {
    const plain = render(<Icon name="skip.next" size={26} />);
    expect(plain.queryByTestId('symbol-view')?.hasAttribute('data-translate-y')).toBe(false);
    plain.unmount();

    // Same renderer, same size, a glyph that does carry a correction — so the
    // assertion above fails if the transform stopped being applied at all,
    // rather than passing because nothing ever sets the attribute.
    const corrected = render(<Icon name="check.small" size={26} />);
    expect(corrected.queryByTestId('symbol-view')?.hasAttribute('data-translate-y')).toBe(true);
  });

  it('never shifts the Android glyph, which is already ink-centred', () => {
    ctrl.os = 'android';
    const { queryByTestId } = render(<Icon name="check.small" size={26} />);
    expect(queryByTestId('mci')?.hasAttribute('data-translate-y')).toBe(false);
    expect(queryByTestId('symbol-view')).toBeNull();
  });

  it('maps every transport glyph to its platform-specific name', () => {
    for (const transportName of ['play.fill', 'pause', 'skip.previous', 'skip.next', 'end.session'] as const) {
      ctrl.os = 'ios';
      const ios = render(<Icon name={transportName} />);
      expect(ios.queryByTestId('symbol-view')?.getAttribute('data-name')).toBe(iconMap[transportName].ios);
      ios.unmount();

      ctrl.os = 'android';
      const android = render(<Icon name={transportName} />);
      expect(android.queryByTestId('mci')?.getAttribute('data-name')).toBe(iconMap[transportName].android);
      android.unmount();
    }
  });
});

describe('Icon text-size scaling', () => {
  const AX3 = 2.643; // React Native's fontScale at AX3.
  const sizeOf = (element: ReturnType<typeof render>) =>
    Number(
      (element.queryByTestId('symbol-view') ?? element.queryByTestId('mci'))?.getAttribute('data-size') ?? Number.NaN,
    );

  it('grows an uncapped iOS icon on the body ramp, in step with body text', () => {
    ctrl.fontScale = AX3;
    expect(sizeOf(render(<Icon name="check.small" size={17} maxFontSizeMultiplier={0} />))).toBeCloseTo(40, 5);
  });

  it('keeps the default 1.5 cap, so a capped icon draws the same size as before', () => {
    ctrl.fontScale = AX3;
    const capped = render(<Icon name="check.small" size={24} />);
    expect(sizeOf(capped)).toBe(36);
    capped.unmount();
    // xxxLarge: the body ramp is React Native's own 1.353 there.
    ctrl.fontScale = 1.353;
    expect(sizeOf(render(<Icon name="check.small" size={17} />))).toBeCloseTo(23, 1);
  });

  it('follows the ramp of the text it sits beside', () => {
    // xxxLarge (1.353): footnote is 19pt, 19/13; body is 23/17.
    ctrl.fontScale = 1.353;
    const footnote = render(<Icon name="check.small" size={13} textVariant="footnote" />);
    expect(sizeOf(footnote)).toBeCloseTo(19, 5);
    footnote.unmount();
    expect(sizeOf(render(<Icon name="check.small" size={17} />))).toBeCloseTo(23, 5);
  });

  it('grows by fontScale itself on Android, where Text has no ramp', () => {
    ctrl.os = 'android';
    ctrl.fontScale = AX3;
    expect(sizeOf(render(<Icon name="check.small" size={10} maxFontSizeMultiplier={0} />))).toBeCloseTo(26.43, 5);
  });
});
