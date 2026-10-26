// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ProfileTabKey, ProfileTopChromeProps } from '../ProfileTopChrome';

const ctrl = vi.hoisted(() => ({
  fontScale: 1,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  profileName: 'Sam Climber' as string | null,
  materialMeasure: undefined as ((event: { nativeEvent: { layout: { height: number } } }) => void) | undefined,
  glassMeasure: undefined as ((height: number) => void) | undefined,
  // What the glass header was told about floating its controls over the list.
  glassOpaqueControls: undefined as boolean | undefined,
  // The scroll-edge store it was handed for the sub-tab's list.
  glassScrollEdge: undefined as unknown,
}));
// Captures the props the SegmentedControl receives so the test can assert its
// option set / selected key / which variant branch rendered it.
const segments = vi.hoisted(() => ({
  entries: [] as Array<{
    options: Array<{ key: string; label: string }>;
    selectedKey: string;
    trackColor: unknown;
    onSelect: (key: ProfileTabKey) => void;
  }>,
}));
// Captures the props the Material primary tabs receive so the material-branch
// cases can assert the option set / selected key / selection forwarding.
const materialTabs = vi.hoisted(() => ({
  entries: [] as Array<{
    options: Array<{ key: string; label: string }>;
    selectedKey: string;
    onSelect: (key: ProfileTabKey) => void;
  }>,
}));

vi.mock('react-native', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  useWindowDimensions: () => ({ width: 402, height: 874, fontScale: ctrl.fontScale }),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-scroll-tabs': true }, children),
  View: ({
    children,
    onLayout,
    style,
  }: {
    children?: ReactNode;
    onLayout?: typeof ctrl.materialMeasure;
    style?: unknown;
  }) => {
    if (onLayout) ctrl.materialMeasure = onLayout;
    return createElement(
      'div',
      {
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
      },
      children,
    );
  },
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    absoluteFill: {},
    hairlineWidth: 1,
  },
}));
vi.mock('react-native-reanimated', () => ({}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { label: '#000', separator: '#ccc', fill: '#eee', background: '#010203' },
    brandColors: { primary: '#6D28D9' },
    m3: { primary: '#6750A4', onSurfaceVariant: '#49454F', outlineVariant: '#CAC4D0' },
    variant: ctrl.variant,
  }),
}));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 2: 8, 4: 16 },
  shadows: { sm: {} },
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('span', { 'data-icon': name, 'data-icon-color': color ?? '' }),
}));
vi.mock('../../GlassSurface', () => ({ GlassSurface: () => createElement('div', { 'data-glass': 'true' }) }));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    selectedKey,
    onSelect,
    trackColor,
  }: {
    options: Array<{ key: string; label: string }>;
    selectedKey: string;
    onSelect: (key: ProfileTabKey) => void;
    trackColor: unknown;
  }) => {
    segments.entries.push({ options, selectedKey, onSelect, trackColor });
    return createElement('div', { 'data-segmented': 'true', 'data-track': String(trackColor) });
  },
}));
vi.mock('../../navigation/MaterialTabs', () => ({
  MaterialTabs: ({
    options,
    selectedKey,
    onSelect,
  }: {
    options: Array<{ key: string; label: string }>;
    selectedKey: string;
    onSelect: (key: ProfileTabKey) => void;
  }) => {
    materialTabs.entries.push({ options, selectedKey, onSelect });
    return createElement('div', { 'data-material-tabs': 'true' });
  },
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: ctrl.profileName == null ? undefined : { displayName: ctrl.profileName } }),
}));
vi.mock('../../chrome/MaterialAppBarTitle', () => ({
  MaterialAppBarTitle: ({ title }: { title: string }) => createElement('div', { 'data-appbar-title': title }),
}));
vi.mock('../../user-drawer/UserAvatarToolbarAction', () => ({
  UserAvatarToolbarAction: ({ variant }: { variant: 'glass' | 'material' }) =>
    createElement('button', { 'data-action': 'ariaLabels.userMenu', 'data-avatar-variant': variant }),
}));
// Paper Appbar: render the title + actions so the material-branch cases can query
// them via the accessibility label (mirroring the glass islands).
vi.mock('react-native-paper', () => ({
  Appbar: {
    Header: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-appbar': 'true' }, children),
    Action: ({
      icon,
      color,
      onPress,
      accessibilityLabel,
    }: {
      icon?: string;
      color?: string;
      onPress?: () => void;
      accessibilityLabel?: string;
    }) =>
      createElement('button', {
        onClick: onPress,
        'data-action': accessibilityLabel ?? '',
        'data-icon': icon ?? '',
        'data-icon-color': color ?? '',
      }),
  },
}));
// Render the islands + children so the test can query them. The track-vs-bare
// distinction is detected via the presence of `data-glass` (only the glass
// branch wraps the control in a GlassSurface track).
vi.mock('../../chrome', () => ({
  CollapsingLargeTitleHeader: ({
    leftActions,
    rightActions,
    children,
    onHeightChange,
    opaqueControls,
    scrollEdge,
  }: {
    leftActions?: ReactNode;
    rightActions?: ReactNode;
    children?: ReactNode;
    onHeightChange: (height: number) => void;
    opaqueControls?: boolean;
    scrollEdge?: unknown;
  }) => {
    ctrl.glassMeasure = onHeightChange;
    ctrl.glassOpaqueControls = opaqueControls;
    ctrl.glassScrollEdge = scrollEdge;
    return createElement(
      'div',
      { 'data-header': 'true' },
      createElement('div', { 'data-slot': 'left' }, leftActions),
      createElement('div', { 'data-slot': 'right' }, rightActions),
      createElement('div', { 'data-slot': 'children' }, children),
    );
  },
  GlassActionToolbar: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-toolbar': 'true' }, children),
  GlassToolbarAction: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'data-action': accessibilityLabel ?? '' }, children),
}));

import { ProfileTopChrome } from '../ProfileTopChrome';
import { createScrollEdgeBackdrop } from '../../../hooks/use-scroll-edge-backdrop';

function makeProps(over: Partial<ProfileTopChromeProps> = {}) {
  return {
    activeTab: 'progress' as ProfileTabKey,
    onSelectTab: vi.fn(),
    onHeightChange: vi.fn(),
    ...over,
  };
}

const userMenuAction = (root: HTMLElement) =>
  root.querySelector('[data-action="ariaLabels.userMenu"]') as HTMLButtonElement | null;
const filterAction = (root: HTMLElement) =>
  root.querySelector('[data-action="mobile.filter.title"]') as HTMLButtonElement | null;

describe('ProfileTopChrome', () => {
  beforeEach(() => {
    ctrl.fontScale = 1;
    ctrl.variant = 'liquidGlass';
    ctrl.profileName = 'Sam Climber';
    ctrl.materialMeasure = undefined;
    ctrl.glassMeasure = undefined;
    ctrl.glassOpaqueControls = undefined;
    ctrl.glassScrollEdge = undefined;
    segments.entries = [];
    materialTabs.entries = [];
  });

  describe('glass variant', () => {
    it('renders the avatar menu in the left island', () => {
      const { container } = render(<ProfileTopChrome {...makeProps()} />);
      expect(filterAction(container)).toBeNull();
      expect(userMenuAction(container)?.getAttribute('data-avatar-variant')).toBe('glass');
    });

    it('passes the profile tab options and selectedKey to the segmented control', () => {
      render(<ProfileTopChrome {...makeProps({ activeTab: 'sessions' })} />);
      const segment = segments.entries.at(-1)!;
      expect(segment.options.map((option) => option.key)).toEqual([
        'progress',
        'sessions',
        'logbook',
        'climbs',
        'social',
      ]);
      expect(segment.selectedKey).toBe('sessions');
    });

    it('forwards segment selection through onSelectTab', () => {
      const onSelectTab = vi.fn();
      render(<ProfileTopChrome {...makeProps({ onSelectTab })} />);
      segments.entries.at(-1)!.onSelect('logbook');
      expect(onSelectTab).toHaveBeenCalledWith('logbook');
    });

    it('renders the native segmented control without a glass-track wrapper', () => {
      const { container } = render(<ProfileTopChrome {...makeProps()} />);
      // The native segmented control brings its own track, so it renders directly —
      // wrapping it in a GlassSurface doubled the border, so the wrapper was dropped.
      expect(container.querySelector('[data-glass="true"]')).toBeNull();
      expect(segments.entries.at(-1)!.trackColor).toBe('transparent');
    });

    it('backs the profile tabs locally and keeps child filter controls outside the backing', () => {
      const onSelectTab = vi.fn();
      const { container, getByText } = render(
        <ProfileTopChrome {...makeProps({ onSelectTab })}>
          <span>Filter capsules</span>
        </ProfileTopChrome>,
      );
      const segmentCarrier = container.querySelector('[data-segmented]')?.parentElement;
      expect(JSON.parse(segmentCarrier?.getAttribute('data-style') ?? '{}')).toMatchObject({
        backgroundColor: '#010203',
        paddingHorizontal: 16,
        paddingVertical: 8,
      });
      expect(segmentCarrier?.contains(getByText('Filter capsules'))).toBe(false);
      expect(container.querySelector('[data-glass="true"]')).toBeNull();
      segments.entries.at(-1)!.onSelect('logbook');
      expect(onSelectTab).toHaveBeenCalledWith('logbook');
    });

    it('leaves the wider supplementary control block transparent unless the caller opts out', () => {
      render(<ProfileTopChrome {...makeProps()} />);
      expect(ctrl.glassOpaqueControls).toBeUndefined();
    });

    // Logbook's header carries a bare text heading under the tabs.
    it('passes the opaque-controls opt-out through to the header', () => {
      render(<ProfileTopChrome {...makeProps({ activeTab: 'logbook', opaqueControls: true })} />);
      expect(ctrl.glassOpaqueControls).toBe(true);
    });

    it("hands the header the screen's scroll-edge store for the sub-tab's list", () => {
      const scrollEdge = createScrollEdgeBackdrop();
      render(<ProfileTopChrome {...makeProps({ scrollEdge })} />);
      expect(ctrl.glassScrollEdge).toBe(scrollEdge);
    });

    it('does not render the Material app bar or primary tabs', () => {
      const { container } = render(<ProfileTopChrome {...makeProps()} />);
      expect(container.querySelector('[data-appbar="true"]')).toBeNull();
      expect(container.querySelector('[data-material-tabs="true"]')).toBeNull();
    });
  });

  describe('material variant', () => {
    beforeEach(() => {
      ctrl.variant = 'material';
    });

    it("titles the Paper app bar with the climber's name over the MaterialTabs row", () => {
      const { container } = render(<ProfileTopChrome {...makeProps()} />);
      expect(container.querySelector('[data-appbar="true"]')).not.toBeNull();
      // The bar names the page; the tabs below switch views inside it.
      expect(container.querySelector('[data-appbar-title]')?.getAttribute('data-appbar-title')).toBe('Sam Climber');
      expect(container.querySelector('[data-material-tabs="true"]')).not.toBeNull();
      // No glass segmented control / track on the material branch.
      expect(container.querySelector('[data-segmented="true"]')).toBeNull();
      expect(container.querySelector('[data-glass="true"]')).toBeNull();
    });

    it('falls back to the Profile title until the profile loads', () => {
      ctrl.profileName = null;
      const { container } = render(<ProfileTopChrome {...makeProps()} />);
      expect(container.querySelector('[data-appbar-title]')?.getAttribute('data-appbar-title')).toBe(
        'mobile.nav.profile',
      );
    });

    it('renders the material avatar menu', () => {
      const { container } = render(<ProfileTopChrome {...makeProps()} />);
      expect(filterAction(container)).toBeNull();
      expect(userMenuAction(container)?.getAttribute('data-avatar-variant')).toBe('material');
    });

    it('passes the profile tab options and selectedKey to MaterialTabs', () => {
      render(<ProfileTopChrome {...makeProps({ activeTab: 'sessions' })} />);
      const tabs = materialTabs.entries.at(-1)!;
      expect(tabs.options.map((option) => option.key)).toEqual(['progress', 'sessions', 'logbook', 'climbs', 'social']);
      expect(tabs.selectedKey).toBe('sessions');
    });

    it('forwards tab selection through onSelectTab', () => {
      const onSelectTab = vi.fn();
      render(<ProfileTopChrome {...makeProps({ onSelectTab })} />);
      materialTabs.entries.at(-1)!.onSelect('logbook');
      expect(onSelectTab).toHaveBeenCalledWith('logbook');
    });
  });
});

for (const variant of ['liquidGlass', 'material'] as const) {
  it(`measures supplemental controls with tabs and removes them on tab switch for ${variant}`, () => {
    ctrl.variant = variant;
    const onHeightChange = vi.fn();
    const props = makeProps({ activeTab: 'logbook', onHeightChange });
    const { container, rerender } = render(
      <ProfileTopChrome {...props}>
        <div data-logbook-controls="true">Search and filters</div>
      </ProfileTopChrome>,
    );
    const tabElement = container.querySelector('[data-segmented], [data-material-tabs]');
    const controls = container.querySelector('[data-logbook-controls]');
    expect(controls).not.toBeNull();
    expect(tabElement!.compareDocumentPosition(controls!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    if (variant === 'liquidGlass') ctrl.glassMeasure?.(180);
    else ctrl.materialMeasure?.({ nativeEvent: { layout: { height: 280 } } });
    expect(onHeightChange).toHaveBeenLastCalledWith(variant === 'liquidGlass' ? 180 : 280);

    rerender(<ProfileTopChrome {...props} activeTab="sessions" />);
    expect(container.querySelector('[data-logbook-controls]')).toBeNull();
  });
}

for (const variant of ['liquidGlass', 'material'] as const) {
  it(`keeps all five tabs scrollable at accessibility sizes on ${variant}`, () => {
    ctrl.variant = variant;
    ctrl.fontScale = 2;
    const { container } = render(<ProfileTopChrome {...makeProps()} />);
    expect(container.querySelector('[data-scroll-tabs]')).not.toBeNull();
    expect(container.querySelector('[data-segmented]')).toBeNull();
    expect(container.querySelector('[data-material-tabs]')).toBeNull();
  });
}
