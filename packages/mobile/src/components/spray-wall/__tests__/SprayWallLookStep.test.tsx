// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  headerInset: 96,
  preview: null as unknown,
  unavailable: true,
  save: vi.fn(async () => {}),
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 402, height: 874, fontScale: 1 }),
  Platform: { OS: 'ios', select: (choices: { ios: unknown }) => choices.ios },
  PlatformColor: (color: string) => color,
  View: ({
    children,
    style,
    onLayout,
  }: {
    children?: ReactNode;
    style?: unknown;
    onLayout?: (event: unknown) => void;
  }) => {
    useEffect(() => onLayout?.({ nativeEvent: { layout: { width: 402, height: 500 } } }), [onLayout]);
    const marginTop = Array.isArray(style) ? style.find((entry) => entry?.marginTop != null)?.marginTop : undefined;
    return createElement('div', { 'data-margin-top': marginTop }, children);
  },
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityState,
    disabled,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityState?: { selected: boolean };
    disabled?: boolean;
  }) =>
    createElement(
      'button',
      { onClick: onPress, role: 'radio', 'aria-checked': accessibilityState?.selected, disabled },
      children,
    ),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { look: string }) => (options ? `${key}:${options.look}` : key),
  }),
}));
vi.mock('../../../hooks/use-transparent-header-inset', () => ({
  useTransparentHeaderInset: () => controls.headerInset,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888', background: '#fff', secondaryBackground: '#eee', separator: '#ddd' },
    textStyles: { footnote: { lineHeight: 18 }, caption1: { lineHeight: 16 } },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../ValueSlider', () => ({ ValueSlider: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../board-look/BoardLookCarousel', () => ({
  BoardLookCarousel: () => createElement('div', { 'data-testid': 'carousel' }),
}));
vi.mock('../../board-look/RailIndexDots', () => ({ RailIndexDots: () => null }));
vi.mock('../../board-look/board-look-card-metrics', () => ({
  captionBlockHeight: () => 20,
  captionLineHeights: () => [],
  resolveHeroThumb: () => null,
}));
vi.mock('../../../hooks/use-native-climb-render', () => ({
  useEffectiveBoardRenderSettings: () => ({ boardseshRendererAvailable: true }),
}));
vi.mock('../../../hooks/use-synthetic-spray-wall-preview', () => ({
  useSyntheticSprayWallPreview: () => ({
    status: controls.unavailable ? 'unavailable' : 'ready',
    preview: controls.preview,
  }),
}));
vi.mock('../../../lib/spray/use-spray-wall-draft', () => ({
  useSprayWallDraft: () => ({ isUnavailable: controls.unavailable }),
  useKeepSprayDraftRegistered: () => {},
}));
vi.mock('../../../lib/spray/use-create-spray-wall', () => ({
  useSetSprayWallRenderSettings: () => ({ isPending: false, mutateAsync: controls.save }),
}));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

import { SprayWallLookStep } from '../SprayWallLookStep';
import {
  SPRAY_WALL_LOOK_OPTIONS,
  DEFAULT_SPRAY_WALL_LOOK_OPTION_ID,
  boardLookOptionWallDefault,
} from '../../../lib/board-render/board-look-options';
const draft = { wallUuid: 'wall-1', layoutId: 9001, versionId: '12', versionNumber: 1, viewerCanEdit: true };
function renderStep() {
  const onConfirmed = vi.fn();
  return {
    ...render(
      <SprayWallLookStep
        draft={draft}
        stepCounter="Step 5 of 6"
        onSaveStarted={vi.fn()}
        onSaveFailed={vi.fn()}
        onConfirmed={onConfirmed}
      />,
    ),
    onConfirmed,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  controls.headerInset = 96;
  controls.unavailable = true;
  controls.preview = null;
});
afterEach(cleanup);

describe('spray Look visibility and fallback', () => {
  it.each([96, 0])('clears a %i-point header and displays the wizard counter', (headerInset) => {
    controls.headerInset = headerInset;
    const { container, getByText } = renderStep();
    expect(container.firstElementChild?.getAttribute('data-margin-top')).toBe(String(headerInset));
    expect(getByText('Step 5 of 6')).toBeTruthy();
  });
  it('offers every look without a preview and saves the selected non-default look', async () => {
    const { getByRole, getByText, onConfirmed } = renderStep();
    for (const option of SPRAY_WALL_LOOK_OPTIONS)
      expect(getByRole('radio', { name: option.labelI18nKey })).toBeTruthy();
    const alternative = SPRAY_WALL_LOOK_OPTIONS.find((option) => option.id !== DEFAULT_SPRAY_WALL_LOOK_OPTION_ID)!;
    fireEvent.click(getByRole('radio', { name: alternative.labelI18nKey }));
    expect(getByRole('radio', { name: alternative.labelI18nKey }).getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      fireEvent.click(getByText(`mobile.settings.boardLook.intro.saveNamed:${alternative.labelI18nKey}`));
    });
    expect(controls.save).toHaveBeenCalledExactlyOnceWith({
      layoutId: draft.layoutId,
      uuid: draft.wallUuid,
      renderSettings: boardLookOptionWallDefault(alternative.id),
    });
    expect(onConfirmed).toHaveBeenCalledOnce();
  });
  it('retains the carousel when a preview can be drawn', () => {
    controls.unavailable = false;
    controls.preview = { boardWidth: 500, boardHeight: 700 };
    const { getByTestId, queryAllByRole } = renderStep();
    expect(getByTestId('carousel')).toBeTruthy();
    expect(queryAllByRole('radio')).toHaveLength(0);
  });
});
