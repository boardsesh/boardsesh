// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ProfileTabKey } from '../ProfileTopChrome';

const ctrl = vi.hoisted(() => ({
  variant: 'glass' as 'glass' | 'material',
}));
const router = vi.hoisted(() => ({ push: vi.fn() }));
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
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));
vi.mock('react-native-reanimated', () => ({}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#000', separator: '#ccc', fill: '#eee' },
    brandColors: { primary: '#6D28D9' },
    m3: { primary: '#6750A4', onSurfaceVariant: '#49454F', outlineVariant: '#CAC4D0' },
    variant: ctrl.variant,
  }),
}));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16 }, shadows: { sm: {} } }));

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
// Paper Appbar: render the title + actions so the material-branch cases can query
// them via the accessibility label (mirroring the glass islands).
vi.mock('react-native-paper', () => ({
  Appbar: {
    Header: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-appbar': 'true' }, children),
    Content: ({ title }: { title?: string }) => createElement('div', { 'data-appbar-title': title ?? '' }),
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
  }: {
    leftActions?: ReactNode;
    rightActions?: ReactNode;
    children?: ReactNode;
  }) =>
    createElement(
      'div',
      { 'data-header': 'true' },
      createElement('div', { 'data-slot': 'left' }, leftActions),
      createElement('div', { 'data-slot': 'right' }, rightActions),
      createElement('div', { 'data-slot': 'children' }, children),
    ),
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

const scrollY = { value: 0 } as unknown as Parameters<typeof ProfileTopChrome>[0]['scrollY'];

function makeProps(over: Partial<Parameters<typeof ProfileTopChrome>[0]> = {}) {
  return {
    activeTab: 'progress' as ProfileTabKey,
    onSelectTab: vi.fn(),
    hasActiveFilters: false,
    onOpenFilters: vi.fn(),
    scrollY,
    onPressTitle: vi.fn(),
    onHeightChange: vi.fn(),
    ...over,
  };
}

const settingsAction = (root: HTMLElement) =>
  root.querySelector('[data-action="mobile.settings"]') as HTMLButtonElement | null;
const filterAction = (root: HTMLElement) =>
  root.querySelector('[data-action="mobile.filter.title"]') as HTMLButtonElement | null;
const filterIcon = (root: HTMLElement) => root.querySelector('[data-icon="filter"]') as HTMLElement | null;

describe('ProfileTopChrome', () => {
  beforeEach(() => {
    ctrl.variant = 'glass';
    router.push.mockClear();
    segments.entries = [];
    materialTabs.entries = [];
  });

  describe('glass variant', () => {
    it('pushes the settings route when the settings island is pressed', () => {
      const { container } = render(<ProfileTopChrome {...makeProps()} />);
      fireEvent.click(settingsAction(container)!);
      expect(router.push).toHaveBeenCalledWith('/(tabs)/profile/more');
    });

    it('renders the filter island only on the Progress sub-tab', () => {
      const { container, rerender } = render(<ProfileTopChrome {...makeProps({ activeTab: 'progress' })} />);
      expect(filterAction(container)).not.toBeNull();

      rerender(<ProfileTopChrome {...makeProps({ activeTab: 'sessions' })} />);
      expect(filterAction(container)).toBeNull();

      rerender(<ProfileTopChrome {...makeProps({ activeTab: 'logbook' })} />);
      expect(filterAction(container)).toBeNull();
    });

    it('tints the filter glyph with the brand colour only when filters are active', () => {
      const { container, rerender } = render(<ProfileTopChrome {...makeProps({ hasActiveFilters: false })} />);
      expect(filterIcon(container)?.getAttribute('data-icon-color')).toBe('#000');

      rerender(<ProfileTopChrome {...makeProps({ hasActiveFilters: true })} />);
      expect(filterIcon(container)?.getAttribute('data-icon-color')).toBe('#6D28D9');
    });

    it('opens the filter sheet when the filter island is pressed', () => {
      const onOpenFilters = vi.fn();
      const { container } = render(<ProfileTopChrome {...makeProps({ onOpenFilters })} />);
      fireEvent.click(filterAction(container)!);
      expect(onOpenFilters).toHaveBeenCalledTimes(1);
    });

    it('passes the profile tab options and selectedKey to the segmented control', () => {
      render(<ProfileTopChrome {...makeProps({ activeTab: 'sessions' })} />);
      const segment = segments.entries.at(-1)!;
      expect(segment.options.map((option) => option.key)).toEqual(['progress', 'sessions', 'logbook', 'social']);
      expect(segment.selectedKey).toBe('sessions');
    });

    it('forwards segment selection through onSelectTab', () => {
      const onSelectTab = vi.fn();
      render(<ProfileTopChrome {...makeProps({ onSelectTab })} />);
      segments.entries.at(-1)!.onSelect('logbook');
      expect(onSelectTab).toHaveBeenCalledWith('logbook');
    });

    it('wraps the segmented control in a glass track', () => {
      const { container } = render(<ProfileTopChrome {...makeProps()} />);
      // The glass branch mounts a GlassSurface track and a transparent track colour.
      expect(container.querySelector('[data-slot="children"] [data-glass="true"]')).not.toBeNull();
      expect(segments.entries.at(-1)!.trackColor).toBe('transparent');
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

    it('renders a Paper app bar with the dashboard title and the MaterialTabs row', () => {
      const { container } = render(<ProfileTopChrome {...makeProps()} />);
      expect(container.querySelector('[data-appbar="true"]')).not.toBeNull();
      expect(container.querySelector('[data-appbar-title="metadata.dashboard.title"]')).not.toBeNull();
      expect(container.querySelector('[data-material-tabs="true"]')).not.toBeNull();
      // No glass segmented control / track on the material branch.
      expect(container.querySelector('[data-segmented="true"]')).toBeNull();
      expect(container.querySelector('[data-glass="true"]')).toBeNull();
    });

    it('pushes the settings route from the settings Appbar.Action', () => {
      const { container } = render(<ProfileTopChrome {...makeProps()} />);
      fireEvent.click(settingsAction(container)!);
      expect(router.push).toHaveBeenCalledWith('/(tabs)/profile/more');
    });

    it('renders the filter Appbar.Action only on the Progress sub-tab', () => {
      const { container, rerender } = render(<ProfileTopChrome {...makeProps({ activeTab: 'progress' })} />);
      expect(filterAction(container)).not.toBeNull();

      rerender(<ProfileTopChrome {...makeProps({ activeTab: 'sessions' })} />);
      expect(filterAction(container)).toBeNull();
    });

    it('tints the filter action with the brand colour only when filters are active', () => {
      const { container, rerender } = render(<ProfileTopChrome {...makeProps({ hasActiveFilters: false })} />);
      expect(filterAction(container)?.getAttribute('data-icon-color')).toBe('#000');

      rerender(<ProfileTopChrome {...makeProps({ hasActiveFilters: true })} />);
      expect(filterAction(container)?.getAttribute('data-icon-color')).toBe('#6D28D9');
    });

    it('opens the filter sheet from the filter Appbar.Action', () => {
      const onOpenFilters = vi.fn();
      const { container } = render(<ProfileTopChrome {...makeProps({ onOpenFilters })} />);
      fireEvent.click(filterAction(container)!);
      expect(onOpenFilters).toHaveBeenCalledTimes(1);
    });

    it('passes the profile tab options and selectedKey to MaterialTabs', () => {
      render(<ProfileTopChrome {...makeProps({ activeTab: 'sessions' })} />);
      const tabs = materialTabs.entries.at(-1)!;
      expect(tabs.options.map((option) => option.key)).toEqual(['progress', 'sessions', 'logbook', 'social']);
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
