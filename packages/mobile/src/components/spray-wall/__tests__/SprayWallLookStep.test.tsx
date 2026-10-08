// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  headerInset: 96,
  preview: null as unknown,
  rendererAvailable: true as boolean | null,
  sliderProps: null as null | {
    options: readonly BoardLookOption[];
    boardseshRendererAvailable?: boolean | null;
    selectedId: string;
    disabled?: boolean;
  },
  dimProps: null as null | { onLiveChange: (dim: number) => void; onCommit: (dim: number) => void },
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
vi.mock('../../LookOptionSlider', () => ({
  LookOptionSlider: ({
    options,
    value,
    onChange,
    disabled,
  }: {
    options: { id: string; label: string }[];
    value: string;
    onChange: (id: string) => void;
    disabled?: boolean;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'look-slider' },
      options.map((option) =>
        createElement(
          'button',
          {
            key: option.id,
            role: 'radio',
            'aria-checked': option.id === value,
            disabled,
            onClick: () => onChange(option.id),
          },
          option.label,
        ),
      ),
    ),
}));
vi.mock('../../ValueSlider', () => ({
  ValueSlider: (props: { onLiveChange: (dim: number) => void; onCommit: (dim: number) => void }) => {
    controls.dimProps = props;
    return null;
  },
}));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../board-look/BoardLookSlider', () => ({
  BoardLookSlider: (props: NonNullable<typeof controls.sliderProps>) => {
    controls.sliderProps = props;
    return createElement('div', { 'data-testid': 'board-look-slider', 'data-selected': props.selectedId });
  },
}));
vi.mock('../../board-look/RailIndexDots', () => ({ RailIndexDots: () => null }));
vi.mock('../../board-look/board-look-card-metrics', () => ({
  captionBlockHeight: () => 20,
  captionLineHeights: () => [],
  resolveHeroThumb: () => null,
}));
vi.mock('../../../hooks/use-native-climb-render', () => ({
  useEffectiveBoardRenderSettings: () => ({ boardseshRendererAvailable: controls.rendererAvailable }),
}));
vi.mock('../../../hooks/use-synthetic-spray-wall-preview', () => ({
  useSyntheticSprayWallPreview: () => ({
    status: controls.unavailable ? 'unavailable' : 'ready',
    preview: controls.preview,
  }),
}));
vi.mock('../../../lib/spray/use-spray-wall-draft', () => ({
  useSprayWallDraft: () => ({ isUnavailable: controls.unavailable, lookPreviewSource: null }),
  useKeepSprayDraftRegistered: () => {},
}));
vi.mock('../../../lib/spray/use-create-spray-wall', () => ({
  useSetSprayWallRenderSettings: () => ({ isPending: false, mutateAsync: controls.save }),
}));
vi.mock('../../../lib/spray/use-spray-wall-art', () => ({
  useSprayWallArt: () => controls.art,
}));
vi.mock('../SprayWallBackgroundSlider', () => ({
  SprayWallBackgroundSlider: ({
    gate,
    value,
    onChange,
  }: {
    gate: { kind: string };
    value: string;
    onChange: (background: string) => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'background-picker', 'data-value': value, 'data-gate': gate.kind },
      (gate.kind === 'open' ? ['photo', 'wall-crop', 'hold-cutouts'] : ['photo']).map((key) =>
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
  type BoardLookOption,
} from '../../../lib/board-render/board-look-options';
const draft = { wallUuid: 'wall-1', layoutId: 9001, versionId: '12', versionNumber: 1, viewerCanEdit: true };
/** The header's "Use <look>": checks the label, then presses it. */
function pressHeaderTrailing(label: string) {
  expect(controls.headerTrailing?.label).toBe(label);
  controls.headerTrailing?.onPress();
}
function renderStep(initialPhase: 'background' | 'look' = 'look') {
  const onConfirmed = vi.fn();
  const onSaveStarted = vi.fn();
  const onSaveFailed = vi.fn();
  function WizardLook() {
    const [phase, setPhase] = useState(initialPhase);
    return createElement(
      'div',
      null,
      createElement('button', { onClick: () => setPhase('background') }, 'Back to background'),
      createElement(SprayWallLookStep, {
        draft,
        phase,
        stepCounter: phase === 'background' ? 'Step 5 of 7' : 'Step 6 of 7',
        onBackgroundConfirmed: () => setPhase('look'),
        onSaveStarted,
        onSaveFailed,
        onConfirmed,
      }),
    );
  }
  return { ...render(createElement(WizardLook)), onConfirmed, onSaveStarted, onSaveFailed };
}
function finishBackground() {
  act(() => pressHeaderTrailing('sprayWizard.background.next'));
}
beforeEach(() => {
  vi.clearAllMocks();
  controls.headerInset = 96;
  controls.unavailable = true;
  controls.preview = null;
  controls.rendererAvailable = true;
  controls.art = { status: 'error', data: null };
  controls.headerTrailing = null;
});
afterEach(cleanup);

describe('spray Look visibility and fallback', () => {
  it.each([96, 0])('clears a %i-point header and displays the wizard counter', (headerInset) => {
    controls.headerInset = headerInset;
    const { container, getByText } = renderStep();
    expect(container.firstElementChild?.lastElementChild?.getAttribute('data-margin-top')).toBe(String(headerInset));
    expect(getByText('Step 6 of 7')).toBeTruthy();
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
  it('draws one selected preview with a slider when the wall can be drawn', () => {
    controls.unavailable = false;
    controls.preview = { boardWidth: 500, boardHeight: 700 };
    const { getByTestId, queryAllByRole } = renderStep();
    expect(getByTestId('board-look-slider')).toBeTruthy();
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
    const { getByTestId } = renderStep('background');
    expect(getByTestId('background-picker').getAttribute('data-gate')).toBe('unsupported');
    finishBackground();
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
    const { getByTestId } = renderStep('background');
    expect(getByTestId('background-picker').getAttribute('data-value')).toBe('wall-crop');
    expect(controls.save).not.toHaveBeenCalled();
    finishBackground();
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
    const { getByTestId, getByText } = renderStep('background');
    fireEvent.click(getByText('bg:photo'));
    expect(getByTestId('background-picker').getAttribute('data-value')).toBe('photo');
    finishBackground();
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
    const { getByTestId, queryByText } = renderStep('background');
    expect(getByTestId('background-picker').getAttribute('data-gate')).toBe('locked');
    expect(getByTestId('background-picker').getAttribute('data-value')).toBe('photo');
    expect(queryByText('bg:hold-cutouts')).toBeNull();
    finishBackground();
    await act(async () => {
      pressHeaderTrailing(saveButton());
    });
    expect(controls.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ renderSettings: defaultLook() }));
  });

  it('says why, and goes back to the photo, when the server refuses the look', async () => {
    controls.art = artAnswer('GOOD');
    controls.save.mockRejectedValueOnce({
      response: {
        errors: [{ message: 'nope', extensions: { code: 'SPRAY_WALL_ART_NOT_AVAILABLE', reason: 'keystone' } }],
      },
    });
    const { getByTestId, getByText } = renderStep('background');
    finishBackground();
    await act(async () => {
      pressHeaderTrailing(saveButton());
    });
    // Keystone: the "too angled" sentence, not the corner-pins one.
    expect(getByText('sprayBackground.notAvailable')).toBeTruthy();
    // The way past a save that will not land, inline under the sentence.
    expect(getByText('sprayWizard.look.publishWithout')).toBeTruthy();
    fireEvent.click(getByText('Back to background'));
    expect(getByTestId('background-picker').getAttribute('data-value')).toBe('photo');
  });
});

describe('two look steps keep choices local until final confirmation', () => {
  it('preserves background, hold look and dimming through Back and stores them together', async () => {
    controls.art = artAnswer('GOOD');
    const { getByText, getByTestId, getByRole } = renderStep('background');
    fireEvent.click(getByText('bg:hold-cutouts'));
    finishBackground();
    const alternative = SPRAY_WALL_LOOK_OPTIONS.find(
      (option) => option.id !== DEFAULT_SPRAY_WALL_LOOK_OPTION_ID && option.id !== 'classic',
    )!;
    fireEvent.click(getByRole('radio', { name: alternative.labelI18nKey }));
    act(() => controls.dimProps?.onCommit(0.65));
    fireEvent.click(getByText('Back to background'));
    expect(getByTestId('background-picker').getAttribute('data-value')).toBe('hold-cutouts');
    expect(controls.save).not.toHaveBeenCalled();
    finishBackground();
    expect(getByRole('radio', { name: alternative.labelI18nKey }).getAttribute('aria-checked')).toBe('true');
    await act(async () => pressHeaderTrailing(`mobile.settings.boardLook.intro.saveNamed:${alternative.labelI18nKey}`));
    expect(controls.save).toHaveBeenCalledOnce();
    expect(controls.save.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        renderSettings: expect.objectContaining({
          background: 'hold-cutouts',
          boardsesh: expect.objectContaining({ veilOpacity: 0.65 }),
        }),
      }),
    );
  });

  it('locks both selections and accepts one final save before mutation pending renders', async () => {
    let finishSave: (() => void) | undefined;
    controls.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const { getByRole, onSaveStarted, onConfirmed } = renderStep();
    const firstConfirm = controls.headerTrailing?.onPress;
    act(() => {
      firstConfirm?.();
      firstConfirm?.();
    });
    expect(controls.save).toHaveBeenCalledOnce();
    expect(onSaveStarted).toHaveBeenCalledOnce();
    const alternative = SPRAY_WALL_LOOK_OPTIONS.find((option) => option.id !== DEFAULT_SPRAY_WALL_LOOK_OPTION_ID)!;
    expect(getByRole('radio', { name: alternative.labelI18nKey }).hasAttribute('disabled')).toBe(true);
    await act(async () => {
      finishSave?.();
    });
    expect(onConfirmed).toHaveBeenCalledOnce();
  });

  it('keeps every wall-wide look offered when this creator cannot render Aura', () => {
    controls.rendererAvailable = false;
    controls.preview = { boardWidth: 500, boardHeight: 700 };
    controls.unavailable = false;
    renderStep();
    expect(controls.sliderProps?.options.map((option) => option.id)).toEqual(
      SPRAY_WALL_LOOK_OPTIONS.map((option) => option.id),
    );
    expect(controls.sliderProps?.boardseshRendererAvailable).toBe(false);
    expect(controls.sliderProps).not.toHaveProperty('previewUnderlay');
  });
});

it('updates the selected hold preview while dimming before writing settings', () => {
  controls.preview = { boardWidth: 500, boardHeight: 700 };
  controls.unavailable = false;
  renderStep();
  act(() => controls.dimProps?.onLiveChange(0.7));
  const settings = boardLookOptionWallDefault(DEFAULT_SPRAY_WALL_LOOK_OPTION_ID, controls.sliderProps?.options);
  expect(settings?.boardsesh.veilOpacity).toBe(0.7);
  expect(controls.save).not.toHaveBeenCalled();
});
