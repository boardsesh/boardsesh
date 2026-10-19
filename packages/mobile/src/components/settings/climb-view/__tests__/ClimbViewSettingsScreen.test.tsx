// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MoreFormModel } from '../../../MoreForm.types';

const screen = vi.hoisted(() => ({ platform: 'android', nativeModel: null as MoreFormModel | null }));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return screen.platform;
    },
  },
  StyleSheet: { create: (styles: unknown) => styles },
  ActivityIndicator: () => null,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'form-scroll' }, children),
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
vi.mock('../../../SegmentedControl', () => ({
  SegmentedControl: ({ onSelect }: { onSelect: (key: string) => void }) =>
    createElement('button', { onClick: () => onSelect('above') }, 'Place buttons above'),
}));
vi.mock('../../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    onValueChange: (next: boolean) => void;
  }) => createElement('button', { onClick: () => onValueChange(!value) }, label),
}));
vi.mock('../../MarkerMultiplierSlider', () => ({ MarkerMultiplierSlider: () => null }));
vi.mock('../../../MoreForm', () => ({
  MoreForm: ({ model }: { model: MoreFormModel }) => {
    screen.nativeModel = model;
    return null;
  },
}));
vi.mock('../../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../../lib/settings-analytics', () => ({ withSettingTracking: (model: MoreFormModel) => model }));
vi.mock('../../use-play-drawer-section-controls', () => ({
  usePlayDrawerSectionControls: () => ({ settingsSection: { key: 'below', rows: [] } }),
}));
vi.mock('../../use-player-button-controls', () => ({
  usePlayerButtonControls: () => {
    const [position, setPosition] = useState('below');
    const [previousNext, setPreviousNext] = useState(true);
    return {
      title: 'Player buttons',
      settingsFooter: '',
      positionLabel: 'Position',
      positionFooter: '',
      positionOptions: [
        { key: 'below', label: 'Below' },
        { key: 'above', label: 'Above' },
      ],
      position,
      onPositionChange: setPosition,
      previousNextLabel: 'Previous and next',
      previousNextDescription: '',
      previousNext,
      onPreviousNextChange: setPreviousNext,
      controls: [],
      onVisibleChange: vi.fn(),
      restoreDefaultsLabel: 'Restore defaults',
      canRestoreDefaults: false,
      restoreDefaults: vi.fn(),
      buttons: { order: [], visible: {} },
    };
  },
}));
vi.mock('../../../player-buttons/PlayerButtonsPreview', () => ({
  FALLBACK_PREVIEW_BOARD: {},
  PLAYER_BUTTONS_PREVIEW_HEIGHT: 100,
  PlayerButtonsPreview: ({ position, previousNext }: { position: string; previousNext: boolean }) =>
    createElement('span', null, `Preview ${position} ${previousNext ? 'with navigation' : 'without navigation'}`),
}));

import { ClimbViewSettingsScreen } from '../ClimbViewSettingsScreen';

afterEach(() => {
  cleanup();
  screen.platform = 'android';
  screen.nativeModel = null;
});

describe('ClimbViewSettingsScreen renderer routing', () => {
  it('renders the live preview in RN on Android and follows settings changes', () => {
    const view = render(<ClimbViewSettingsScreen />);
    expect(view.getByText('Preview below with navigation')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Place buttons above' }));
    expect(view.getByText('Preview above with navigation')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Previous and next' }));
    expect(view.getByText('Preview above without navigation')).toBeTruthy();
    expect(view.getAllByTestId('form-scroll')).toHaveLength(1);
    expect(screen.nativeModel).toBeNull();
  });

  it('keeps iOS on the native form with the preview in its model', () => {
    screen.platform = 'ios';
    const view = render(<ClimbViewSettingsScreen />);
    expect(view.queryByText('Preview below with navigation')).toBeNull();
    expect(screen.nativeModel?.sections[0].rows[0].kind).toBe('custom');
  });
});
