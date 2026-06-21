// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement } from 'react';

const cfg = vi.hoisted(() => ({
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  // The provider hands components the already scheme-resolved brand fill; dark
  // mode swaps this to #7C3AED. Tests vary it to prove the FAB tints from whatever
  // fill it's given rather than a hardcoded hue.
  primaryFill: '#6D28D9',
}));

// GlassIconButton → a <button> surfacing the props FilterButton forwards: the
// badge count, the icon tint, the glass tint, and the accessibility label.
type GlassMockProps = {
  iconName?: string;
  iconColor?: string;
  iconSize?: number;
  size?: number;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityActions?: ReadonlyArray<{ name: string; label?: string }>;
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  tintColor?: string;
  fallbackColor?: string;
  badgeCount?: number;
  badgeBackgroundColor?: string;
  badgeTextColor?: string;
};
vi.mock('../../GlassIconButton', () => ({
  GlassIconButton: ({
    iconName,
    iconColor,
    iconSize,
    size,
    onPress,
    onLongPress,
    accessibilityLabel,
    accessibilityHint,
    accessibilityActions,
    onAccessibilityAction,
    tintColor,
    fallbackColor,
    badgeCount,
    badgeBackgroundColor,
    badgeTextColor,
  }: GlassMockProps) =>
    createElement('button', {
      onClick: onPress,
      onDoubleClick: onLongPress,
      // Simulate VoiceOver / Switch Control invoking the named "grade" action.
      onContextMenu: () => onAccessibilityAction?.({ nativeEvent: { actionName: 'grade' } }),
      'data-icon': iconName,
      'data-icon-color': iconColor ?? '',
      'data-icon-size': iconSize == null ? '' : String(iconSize),
      'data-size': size == null ? '' : String(size),
      'data-label': accessibilityLabel ?? '',
      'data-hint': accessibilityHint ?? '',
      'data-actions': Array.isArray(accessibilityActions)
        ? accessibilityActions.map((action) => action.name).join(',')
        : '',
      'data-tint': tintColor ?? '',
      'data-fallback': fallbackColor ?? '',
      'data-badge': badgeCount == null ? '' : String(badgeCount),
      'data-badge-bg': badgeBackgroundColor ?? '',
      'data-badge-color': badgeTextColor ?? '',
    }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#EEE', secondaryLabel: '#999' },
    brandColors: { primary: '#6D28D9', primaryFill: cfg.primaryFill, onPrimary: '#FFFFFF' },
    variant: cfg.variant,
  }),
}));

vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { white: '#FFFFFF' },
}));

// Deterministic colour helper so the active tint/fallback are assertable.
vi.mock('../../../theme/colors', () => ({
  withAlpha: (color: string, alpha: number) => `${color}@${alpha}`,
}));

vi.mock('../../../theme/layout', () => ({
  glassSize: { inlinePrimary: 48 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FilterButton } from '../FilterButton';

const button = (root: HTMLElement) => root.querySelector('[data-icon="filter"]') as HTMLButtonElement;

describe('FilterButton', () => {
  beforeEach(() => {
    cfg.variant = 'liquidGlass';
    cfg.primaryFill = '#6D28D9';
  });

  it('renders the filter glyph and fires onPress', () => {
    const onPress = vi.fn();
    const { container, getByRole } = render(<FilterButton activeFilterCount={0} onPress={onPress} />);
    expect(button(container)).not.toBeNull();
    fireEvent.click(getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('fires the optional long-press handler without firing onPress', () => {
    const onPress = vi.fn();
    const onLongPress = vi.fn();
    const { getByRole } = render(<FilterButton activeFilterCount={0} onPress={onPress} onLongPress={onLongPress} />);
    fireEvent.doubleClick(getByRole('button'));
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('forwards the active filter count as the badge', () => {
    const { container } = render(<FilterButton activeFilterCount={3} onPress={() => {}} />);
    expect(button(container).getAttribute('data-badge')).toBe('3');
  });

  it('uses the smaller floating action size', () => {
    const { container } = render(<FilterButton activeFilterCount={0} onPress={() => {}} />);
    const filterButton = button(container);
    expect(filterButton.getAttribute('data-size')).toBe('48');
    expect(filterButton.getAttribute('data-icon-size')).toBe('20');
  });

  it('forwards a zero count so the underlying button can hide the badge itself', () => {
    const { container } = render(<FilterButton activeFilterCount={0} onPress={() => {}} />);
    // The count is always forwarded; GlassIconButton owns the "hide when 0" rule.
    expect(button(container).getAttribute('data-badge')).toBe('0');
  });

  it('uses muted styling when no filters are active', () => {
    const { container } = render(<FilterButton activeFilterCount={0} onPress={() => {}} />);
    const filterButton = button(container);
    // Inactive: icon takes the secondary-label colour, no glass tint, system fill fallback.
    expect(filterButton.getAttribute('data-icon-color')).toBe('#999');
    expect(filterButton.getAttribute('data-tint')).toBe('');
    expect(filterButton.getAttribute('data-fallback')).toBe('#EEE');
  });

  it('uses a translucent violet glass tint over an opaque fallback for the floating Liquid Glass affordance', () => {
    const { container } = render(<FilterButton activeFilterCount={0} onPress={() => {}} prominence="floating" />);
    const filterButton = button(container);
    expect(filterButton.getAttribute('data-icon-color')).toBe('#FFFFFF');
    // Translucent tint so the Liquid Glass lenses through (purple glass, not a flat fill);
    // the fallback stays opaque so Reduce Transparency / Android read as a solid violet.
    expect(filterButton.getAttribute('data-tint')).toBe('#6D28D9@0.6');
    expect(filterButton.getAttribute('data-fallback')).toBe('#6D28D9');
  });

  it('tints the floating affordance from the scheme-resolved brand fill (dark mode)', () => {
    // In dark mode the provider resolves brandColors.primaryFill to #7C3AED. The
    // FAB must follow that fill (tint + opaque fallback), not a hardcoded violet.
    cfg.primaryFill = '#7C3AED';
    const { container } = render(<FilterButton activeFilterCount={0} onPress={() => {}} prominence="floating" />);
    const filterButton = button(container);
    expect(filterButton.getAttribute('data-tint')).toBe('#7C3AED@0.6');
    expect(filterButton.getAttribute('data-fallback')).toBe('#7C3AED');
  });

  it('uses a white glyph on the violet glass tint when active (Liquid Glass)', () => {
    cfg.variant = 'liquidGlass';
    const { container } = render(<FilterButton activeFilterCount={2} onPress={() => {}} />);
    const filterButton = button(container);
    // Active on glass: white glyph reads on the violet tint; glass tints/falls back to alpha-mixed violet.
    expect(filterButton.getAttribute('data-icon-color')).toBe('#FFFFFF');
    expect(filterButton.getAttribute('data-tint')).toBe('#6D28D9@0.18');
    expect(filterButton.getAttribute('data-fallback')).toBe('#6D28D9@0.16');
  });

  it('keeps the floating Liquid Glass count badge visible on the filled button', () => {
    const { container } = render(<FilterButton activeFilterCount={2} onPress={() => {}} prominence="floating" />);
    const filterButton = button(container);
    expect(filterButton.getAttribute('data-icon-color')).toBe('#FFFFFF');
    expect(filterButton.getAttribute('data-tint')).toBe('#6D28D9@0.6');
    expect(filterButton.getAttribute('data-fallback')).toBe('#6D28D9');
    expect(filterButton.getAttribute('data-badge-bg')).toBe('#FFFFFF');
    expect(filterButton.getAttribute('data-badge-color')).toBe('#6D28D9');
  });

  it('keeps the violet glyph on Material when active (no tint behind it)', () => {
    cfg.variant = 'material';
    const { container } = render(<FilterButton activeFilterCount={2} onPress={() => {}} />);
    expect(button(container).getAttribute('data-icon-color')).toBe('#6D28D9');
  });

  it('keeps Material styling unchanged when floating prominence is requested', () => {
    cfg.variant = 'material';
    const { container } = render(<FilterButton activeFilterCount={2} onPress={() => {}} prominence="floating" />);
    const filterButton = button(container);
    expect(filterButton.getAttribute('data-icon-color')).toBe('#6D28D9');
    expect(filterButton.getAttribute('data-tint')).toBe('#6D28D9@0.18');
    expect(filterButton.getAttribute('data-fallback')).toBe('#6D28D9@0.16');
    expect(filterButton.getAttribute('data-badge-bg')).toBe('');
    expect(filterButton.getAttribute('data-badge-color')).toBe('');
  });

  it('omits the count from the a11y label when no filters are active', () => {
    const { container } = render(<FilterButton activeFilterCount={0} onPress={() => {}} />);
    expect(button(container).getAttribute('data-label')).toBe('mobile.search.filters');
  });

  it('uses the active-count a11y label when filters are active', () => {
    const { container } = render(<FilterButton activeFilterCount={5} onPress={() => {}} />);
    expect(button(container).getAttribute('data-label')).toBe('mobile.search.filterCountAria');
  });

  it('adds the long-press hint when quick grade search is available', () => {
    const { container } = render(<FilterButton activeFilterCount={0} onPress={() => {}} onLongPress={() => {}} />);
    expect(button(container).getAttribute('data-hint')).toBe('mobile.search.filterHint');
  });

  it('exposes a grade accessibility action that assistive tech can trigger', () => {
    // A raw long-press is invisible to VoiceOver / Switch Control, so grade must
    // also be reachable as a named action that runs the same handler.
    const onLongPress = vi.fn();
    const { getByRole } = render(<FilterButton activeFilterCount={0} onPress={() => {}} onLongPress={onLongPress} />);
    const filterButton = getByRole('button');
    expect(filterButton.getAttribute('data-actions')).toContain('grade');
    fireEvent.contextMenu(filterButton);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('exposes no custom actions when grade quick-access is unavailable', () => {
    const { container } = render(<FilterButton activeFilterCount={0} onPress={() => {}} />);
    expect(button(container).getAttribute('data-actions')).toBe('');
  });
});
