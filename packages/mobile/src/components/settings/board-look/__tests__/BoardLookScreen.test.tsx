// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { MoreFormModel } from '../../../MoreForm.types';

// Screen-level wiring only: which board shows the MoonBoard section, and that
// its switch writes the setting. What the section contains is covered by
// board-look-model.test.ts.

const screen = vi.hoisted(() => ({
  activeBoardType: 'moonboard' as string | null,
  platform: 'ios',
  showPreview: false,
  applyPreset: vi.fn(),
  lastModel: null as MoreFormModel | null,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return screen.platform;
    },
  },
  StyleSheet: { create: (styles: unknown) => styles },
  ActivityIndicator: () => null,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  useWindowDimensions: () => ({ width: 393, height: 852, fontScale: 1, scale: 3 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../MoreForm', () => ({
  MoreForm: ({ model }: { model: MoreFormModel }) => {
    screen.lastModel = model;
    return null;
  },
}));
vi.mock('../../../../lib/routing/scoped-navigation', () => ({ scopedRouter: { push: vi.fn() } }));
vi.mock('../../../board-look/BoardLookCarousel', () => ({
  BoardLookCarousel: ({ onSelect }: { onSelect: (id: string) => void }) =>
    createElement('button', { onClick: () => onSelect('aura') }, 'Board preset preview'),
}));
vi.mock('../../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { lg: 12 },
}));
vi.mock('../../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('../../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../AppMenu', () => ({ AppMenu: () => null }));
vi.mock('../../../ListRow', () => ({ ListRow: () => null }));
vi.mock('../../../SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../../../SegmentedControl', () => ({ SegmentedControl: () => null }));
vi.mock('../../../SwitchRow', () => ({ SwitchRow: () => null }));
vi.mock('../../MarkerMultiplierSlider', () => ({ MarkerMultiplierSlider: () => null }));
vi.mock('../../../board-look/board-look-card-metrics', () => ({ boardLookCardHeight: () => 240 }));
vi.mock('../../../../hooks/use-board-preview-climb', () => ({
  useBoardPreviewClimb: () => ({ preview: screen.showPreview ? {} : null }),
}));
vi.mock('../../../../lib/board-render/use-board-look-settings', () => ({
  useBoardLookSettings: () => ({
    settings: {},
    matchingOptionId: 'aura',
    boardseshRendererAvailable: true,
    requestedMode: 'aura',
    applyPreset: screen.applyPreset,
    restoreCustomLook: vi.fn(),
  }),
}));
vi.mock('../../../../lib/hold-color-overrides', () => ({
  countHoldMarkerOverrides: () => 0,
  useHoldColorOverrides: () => ({ markerOverrides: {} }),
}));
vi.mock('../../../../lib/board-render/board-look-options', () => ({
  BOARD_LOOK_SETTINGS_OPTIONS: [],
  drawableBoardLookOptions: () => [],
}));
vi.mock('../../../../hooks/use-os-accessibility-signals', () => ({ useOsAccessibilitySignals: () => ({}) }));
vi.mock('../../../../lib/board-render/board-look-suggestions', () => ({
  applyBoardLookSuggestion: vi.fn(),
  pickBoardLookSuggestion: () => null,
}));
vi.mock('../../../../lib/board-render/board-look-suggestion-dismissals', () => ({
  ALL_BOARD_LOOK_SUGGESTIONS_DISMISSED: {},
  dismissBoardLookSuggestion: vi.fn(),
  loadBoardLookSuggestionDismissals: () => new Promise(() => {}),
}));
vi.mock('../../../../lib/spray-wall-look-preference', () => ({
  useSprayWallsUseOwnLookSetting: () => ({ useOwnLook: false, setUseOwnLook: vi.fn() }),
}));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../../lib/settings-analytics', () => ({ withSettingTracking: (model: MoreFormModel) => model }));
vi.mock('../../board-lighting/use-board-lighting-sections', () => ({ useBoardLightingSections: () => [] }));
vi.mock('../../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: screen.activeBoardType ? { boardType: screen.activeBoardType } : null }),
}));

import { BoardLookScreen } from '../BoardLookScreen';
import { DEFAULT_SETTINGS, getSetting, setSetting } from '../../../../settings';

function moonboardToggle() {
  const row = screen.lastModel?.sections
    .find((section) => section.key === 'moonboard')
    ?.rows.find((candidate) => candidate.key === 'moonboardGridLabels');
  return row?.kind === 'toggle' ? row : undefined;
}

afterEach(() => {
  cleanup();
  screen.activeBoardType = 'moonboard';
  screen.platform = 'ios';
  screen.showPreview = false;
  screen.applyPreset.mockClear();
  screen.lastModel = null;
  setSetting('moonboardGridLabels', DEFAULT_SETTINGS.moonboardGridLabels);
});

describe('BoardLookScreen MoonBoard grid labels', () => {
  it('shows the switch, on by default, when the active board is a MoonBoard', () => {
    render(<BoardLookScreen />);
    expect(moonboardToggle()?.value).toBe(true);
  });

  it('hides the section when the active board is a Kilter', () => {
    screen.activeBoardType = 'kilter';
    render(<BoardLookScreen />);
    expect(screen.lastModel?.sections.map((section) => section.key)).not.toContain('moonboard');
  });

  it('hides the section when no board is picked yet', () => {
    screen.activeBoardType = null;
    render(<BoardLookScreen />);
    expect(screen.lastModel?.sections.map((section) => section.key)).not.toContain('moonboard');
  });

  it('writes the setting when the switch flips', () => {
    render(<BoardLookScreen />);
    act(() => moonboardToggle()?.onValueChange(false));
    expect(getSetting('moonboardGridLabels')).toBe(false);
    expect(moonboardToggle()?.value).toBe(false);
  });
});

describe('BoardLookScreen renderer routing', () => {
  it('renders the preset subtree in RN on Android and keeps preset selection wired', () => {
    screen.platform = 'android';
    screen.showPreview = true;
    const view = render(<BoardLookScreen />);
    fireEvent.click(view.getByRole('button', { name: 'Board preset preview' }));
    expect(screen.applyPreset).toHaveBeenCalledWith('aura');
    expect(screen.lastModel).toBeNull();
  });

  it('keeps iOS on the native form with its preview model', () => {
    screen.showPreview = true;
    const view = render(<BoardLookScreen />);
    expect(view.queryByText('Board preset preview')).toBeNull();
    expect(screen.lastModel?.sections.find((section) => section.key === 'presets')?.rows[0].kind).toBe('custom');
  });
});
