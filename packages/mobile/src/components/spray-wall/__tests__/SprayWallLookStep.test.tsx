// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  headerInset: 96,
  preview: null as unknown,
  unavailable: true,
  save: vi.fn(async (_input: unknown) => {}),
  art: { status: 'error' as 'pending' | 'error' | 'success', data: null as unknown },
  /** The header's confirm, as the step last set it through `useHeaderActions`. */
  headerTrailing: null as null | { label: string; onPress: () => void },
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 402, height: 874, fontScale: 1 }),
  Platform: { OS: 'ios', select: (choices: { ios: unknown }) => choices.ios },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
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
}));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));
vi.mock('../../../hooks/use-header-actions', () => ({
  useHeaderActions: ({ trailing }: { trailing?: { label: string; onPress: () => void } | null }) => {
    if (trailing) controls.headerTrailing = trailing;
  },
}));
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
vi.mock('../../RadioGroup', () => ({
  RadioGroup: ({
    options,
    value,
    onChange,
  }: {
    options: { value: string; label: string }[];
    value: string;
    onChange: (id: string) => void;
  }) =>
    createElement(
      'div',
      null,
      options.map((option) =>
        createElement(
          'button',
          {
            key: option.value,
            role: 'radio',
            'aria-checked': option.value === value,
            onClick: () => onChange(option.value),
          },
          option.label,
        ),
      ),
    ),
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
vi.mock('../../../lib/spray/use-spray-wall-art', () => ({
  useSprayWallArt: () => controls.art,
}));
vi.mock('../SprayWallBackgroundPicker', () => ({
  SprayWallBackgroundPicker: ({
    gate,
    value,
    onChange,
  }: {
    gate: { kind: string };
    value: string;
    onChange: (background: string) => void;
  }) =>
    gate.kind === 'loading' || gate.kind === 'unsupported'
      ? null
      : createElement(
          'div',
          { 'data-testid': 'background-picker', 'data-value': value, 'data-gate': gate.kind },
          ['photo', 'wall-crop', 'hold-cutouts'].map((key) =>
            createElement('button', { key, onClick: () => onChange(key) }, `bg:${key}`),
          ),
        ),
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
/** The header's "Use <look>": checks the label, then presses it. */
function pressHeaderTrailing(label: string) {
  expect(controls.headerTrailing?.label).toBe(label);
  controls.headerTrailing?.onPress();
}
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
  controls.art = { status: 'error', data: null };
  controls.headerTrailing = null;
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
    const { getByRole, onConfirmed } = renderStep();
    for (const option of SPRAY_WALL_LOOK_OPTIONS)
      expect(getByRole('radio', { name: option.labelI18nKey })).toBeTruthy();
    const alternative = SPRAY_WALL_LOOK_OPTIONS.find((option) => option.id !== DEFAULT_SPRAY_WALL_LOOK_OPTION_ID)!;
    fireEvent.click(getByRole('radio', { name: alternative.labelI18nKey }));
    expect(getByRole('radio', { name: alternative.labelI18nKey }).getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      pressHeaderTrailing(`mobile.settings.boardLook.intro.saveNamed:${alternative.labelI18nKey}`);
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

function artAnswer(verdict: 'GOOD' | 'SOFT' | 'FAIL', reason = 'ok') {
  return {
    status: 'success' as const,
    data: {
      versionNumber: 1,
      recipe: 1,
      status: 'NONE',
      width: null,
      height: null,
      quality: { stretch: 1.2, verdict, reason, frameShortEdge: 3000 },
      crop: null,
      cutout: null,
    },
  };
}

describe('spray Look wall background', () => {
  const defaultLook = () => boardLookOptionWallDefault(DEFAULT_SPRAY_WALL_LOOK_OPTION_ID);
  const saveButton = () => {
    const option = SPRAY_WALL_LOOK_OPTIONS.find((entry) => entry.id === DEFAULT_SPRAY_WALL_LOOK_OPTION_ID)!;
    return `mobile.settings.boardLook.intro.saveNamed:${option.labelI18nKey}`;
  };

  it('hides the picker and sends no background to a backend without generated looks', async () => {
    const { queryByTestId } = renderStep();
    expect(queryByTestId('background-picker')).toBeNull();
    await act(async () => {
      pressHeaderTrailing(saveButton());
    });
    expect(controls.save).toHaveBeenCalledExactlyOnceWith({
      layoutId: draft.layoutId,
      uuid: draft.wallUuid,
      renderSettings: defaultLook(),
    });
  });

  it('suggests Wall only when the photo passes, and stores it', async () => {
    controls.art = artAnswer('GOOD');
    const { getByTestId } = renderStep();
    expect(getByTestId('background-picker').getAttribute('data-value')).toBe('wall-crop');
    await act(async () => {
      pressHeaderTrailing(saveButton());
    });
    expect(controls.save).toHaveBeenCalledExactlyOnceWith({
      layoutId: draft.layoutId,
      uuid: draft.wallUuid,
      renderSettings: { ...defaultLook(), background: 'wall-crop' },
    });
  });

  it('stores the photo by name when the creator picks it, so an earlier save cannot stick', async () => {
    controls.art = artAnswer('SOFT');
    const { getByTestId, getByText } = renderStep();
    fireEvent.click(getByText('bg:photo'));
    expect(getByTestId('background-picker').getAttribute('data-value')).toBe('photo');
    await act(async () => {
      pressHeaderTrailing(saveButton());
    });
    expect(controls.save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ renderSettings: { ...defaultLook(), background: 'photo' } }),
    );
  });

  it('sends no background for an untouched photo that fails the gate', async () => {
    controls.art = artAnswer('FAIL', 'no-pins');
    renderStep();
    await act(async () => {
      pressHeaderTrailing(saveButton());
    });
    expect(controls.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ renderSettings: defaultLook() }));
  });

  it('stays on the photo for a photo that fails the gate', async () => {
    controls.art = artAnswer('FAIL', 'keystone');
    const { getByTestId, getByText } = renderStep();
    expect(getByTestId('background-picker').getAttribute('data-gate')).toBe('locked');
    expect(getByTestId('background-picker').getAttribute('data-value')).toBe('photo');
    fireEvent.click(getByText('bg:hold-cutouts'));
    await act(async () => {
      pressHeaderTrailing(saveButton());
    });
    // Picked, but the gate is shut: the save stores the photo, never the look.
    expect(controls.save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ renderSettings: { ...defaultLook(), background: 'photo' } }),
    );
  });

  it('says why, and goes back to the photo, when the server refuses the look', async () => {
    controls.art = artAnswer('GOOD');
    controls.save.mockRejectedValueOnce({
      response: {
        errors: [{ message: 'nope', extensions: { code: 'SPRAY_WALL_ART_NOT_AVAILABLE', reason: 'keystone' } }],
      },
    });
    const { getByTestId, getByText } = renderStep();
    await act(async () => {
      pressHeaderTrailing(saveButton());
    });
    // Keystone: the "too angled" sentence, not the corner-pins one.
    expect(getByText('sprayBackground.notAvailable')).toBeTruthy();
    expect(getByTestId('background-picker').getAttribute('data-value')).toBe('photo');
    // The way past a save that will not land, inline under the sentence.
    expect(getByText('sprayWizard.look.publishWithout')).toBeTruthy();
  });
});
