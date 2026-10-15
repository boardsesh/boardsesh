// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  headerInset: 96,
  preview: null as unknown,
  rendererAvailable: true as boolean | null,
  carouselProps: null as null | {
    options: readonly BoardLookOption[];
    boardseshRendererAvailable?: boolean | null;
    selectedId: string;
    selectOnSnap?: boolean;
    showDescriptions?: boolean;
    heroThumb?: { width: number; height: number } | null;
    onSelect: (id: string) => void;
  },
  /** The form model the step last handed `MoreForm`. */
  model: null as null | MoreFormModel,
  /** Which renderer drew that model. */
  renderer: null as null | 'native' | 'rn',
  formProps: null as null | {
    fitted?: boolean;
    scrollable?: boolean;
    onReservedHeightChange?: (height: number) => void;
  },
  /** The `Platform` the step reads; mutated in place so the mock stays live. */
  platform: { OS: 'ios' as 'ios' | 'android', select: (choices: { ios: unknown }) => choices.ios },
  /** What each measured view reports, by testID: jsdom has no layout. */
  layouts: {} as Record<string, { width: number; height: number }>,
  dimProps: null as null | { onLiveChange: (dim: number) => void; onCommit: (dim: number) => void },
  unavailable: true,
  stalled: false,
  retry: vi.fn(),
  save: vi.fn(async (_input: unknown) => {}),
  art: { status: 'error' as 'pending' | 'error' | 'success', data: null as unknown },
  /** The header's confirm, as the step last set it through `useHeaderActions`. */
  headerTrailing: null as null | { label: string; onPress: () => void },
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 402, height: 874, fontScale: 1 }),
  Platform: controls.platform,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (color: string) => color,
  View: ({
    children,
    style,
    onLayout,
    testID,
  }: {
    children?: ReactNode;
    style?: unknown;
    onLayout?: (event: unknown) => void;
    testID?: string;
  }) => {
    useEffect(() => {
      const layout = (testID ? controls.layouts[testID] : undefined) ?? { width: 402, height: 500 };
      onLayout?.({ nativeEvent: { layout } });
    }, [onLayout, testID]);
    const paddingTop = Array.isArray(style) ? style.find((entry) => entry?.paddingTop != null)?.paddingTop : undefined;
    return createElement('div', { 'data-padding-top': paddingTop, 'data-testid': testID }, children);
  },
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  // What the MoreForm stub draws its rows with.
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityRole,
    accessibilityLabel,
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
  }) =>
    createElement(
      'button',
      {
        role: accessibilityRole,
        'aria-label': accessibilityLabel,
        'aria-checked': accessibilityState?.selected,
        disabled,
        onClick: onPress,
      },
      children,
    ),
  Switch: () => null,
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
// The real stub, with the model it was handed kept for the test to drive.
vi.mock('../../MoreForm', async () => {
  // `importActual`: the alias points '../../MoreForm' at this very stub, so the
  // mock below replaces it, and a plain import would hand back the mock.
  const stub = await vi.importActual<typeof import('../../../../test/more-form-stub')>(
    '../../../../test/more-form-stub',
  );
  return {
    MoreForm: (props: { model: MoreFormModel }) => {
      controls.model = props.model;
      controls.renderer = 'native';
      return stub.MoreForm(props);
    },
  };
});
vi.mock('../../MoreForm.rn', async () => {
  // `importActual`: the alias points '../../MoreForm' at this very stub, so the
  // mock below replaces it, and a plain import would hand back the mock.
  const stub = await vi.importActual<typeof import('../../../../test/more-form-stub')>(
    '../../../../test/more-form-stub',
  );
  return {
    MoreFormRN: (props: {
      model: MoreFormModel;
      fitted?: boolean;
      scrollable?: boolean;
      onReservedHeightChange?: (height: number) => void;
    }) => {
      controls.model = props.model;
      controls.renderer = 'rn';
      controls.formProps = props;
      return stub.MoreForm(props);
    },
  };
});
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
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
    systemColors: {
      secondaryLabel: '#888',
      background: '#fff',
      secondaryBackground: '#eee',
      separator: '#ddd',
      groupedBackground: '#f4f1fb',
    },
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
vi.mock('../../board-look/BoardLookCarousel', () => ({
  BoardLookCarousel: (props: NonNullable<typeof controls.carouselProps>) => {
    controls.carouselProps = props;
    return createElement('div', { 'data-testid': 'board-look-carousel', 'data-selected': props.selectedId });
  },
}));
vi.mock('../../board-look/RailIndexDots', () => ({ RailIndexDots: () => null }));
vi.mock('../../board-look/board-look-card-metrics', () => ({
  RAIL_MIN_WIDTH: 132,
  RAIL_THUMB_HEIGHT: 168,
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
  useSprayWallDraft: () => ({
    isUnavailable: controls.unavailable,
    isStalled: controls.stalled,
    retry: controls.retry,
    lookPreviewSource: null,
  }),
  useKeepSprayDraftRegistered: () => {},
}));
vi.mock('../../../lib/spray/use-create-spray-wall', () => ({
  useSetSprayWallRenderSettings: () => ({ isPending: false, mutateAsync: controls.save }),
}));
vi.mock('../../../lib/spray/use-spray-wall-art', () => ({
  useSprayWallArt: () => controls.art,
}));
vi.mock('../SprayWallBackgroundCarousel', () => ({
  SprayWallBackgroundCarousel: ({
    value,
    gate,
    disabled,
    onChange,
  }: {
    value: string;
    gate: { kind: string };
    disabled: boolean;
    onChange: (key: string) => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'background-preview', 'data-value': value },
      gate.kind === 'open'
        ? ['photo', 'wall-crop', 'hold-cutouts'].map((key, index) =>
            createElement('button', {
              key,
              role: 'radio',
              'aria-label': `sprayBackground.${['photo', 'wallCrop', 'holdCutouts'][index]}`,
              'aria-checked': value === key,
              disabled,
              onClick: () => onChange(key),
            }),
          )
        : null,
    ),
}));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

import { SprayWallLookStep, type SprayLookChoice } from '../SprayWallLookStep';
import type { MoreFormModel, MoreRow } from '../../MoreForm.types';
import {
  SPRAY_WALL_LOOK_OPTIONS,
  DEFAULT_SPRAY_WALL_LOOK_OPTION_ID,
  boardLookOptionWallDefault,
  type BoardLookOption,
} from '../../../lib/board-render/board-look-options';
/** A background segment in the form, by its label key's last part. */
function backgroundRadio(label: 'photo' | 'wallCrop' | 'holdCutouts') {
  return screen.getByRole('radio', { name: `sprayBackground.${label}` });
}
/** A row of the model the step last handed `MoreForm`. */
function modelRow(key: string): MoreRow | undefined {
  return controls.model?.sections.flatMap((section) => section.rows).find((row) => row.key === key);
}
const draft = { wallUuid: 'wall-1', layoutId: 9001, versionId: '12', versionNumber: 1, viewerCanEdit: true };
/** The header's "Use <look>": checks the label, then presses it. */
function pressHeaderTrailing(label: string) {
  expect(controls.headerTrailing?.label).toBe(label);
  controls.headerTrailing?.onPress();
}
function renderStep(
  initialPhase: 'background' | 'look' = 'look',
  extra: { lookLabel?: string; initialChoice?: SprayLookChoice } = {},
) {
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
        forwardLabel: phase === 'look' && extra.lookLabel ? extra.lookLabel : 'sprayWizard.next',
        confirmWithoutLabel: 'sprayWizard.look.continueWithout',
        saveFailedMessage: 'sprayWizard.look.failed',
        initialChoice: extra.initialChoice,
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
  act(() => pressHeaderTrailing('sprayWizard.next'));
}
beforeEach(() => {
  vi.clearAllMocks();
  controls.headerInset = 96;
  controls.unavailable = true;
  controls.stalled = false;
  controls.preview = null;
  controls.carouselProps = null;
  controls.model = null;
  controls.renderer = null;
  controls.formProps = null;
  controls.platform.OS = 'ios';
  controls.layouts = {};
  controls.rendererAvailable = true;
  controls.art = { status: 'error', data: null };
  controls.headerTrailing = null;
});
afterEach(cleanup);

describe('spray Look visibility and fallback', () => {
  it.each([96, 0])('clears a %i-point header and displays the wizard counter', (headerInset) => {
    controls.headerInset = headerInset;
    const { container, getByText } = renderStep();
    expect(container.firstElementChild?.lastElementChild?.getAttribute('data-padding-top')).toBe(String(headerInset));
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
      pressHeaderTrailing('sprayWizard.next');
    });
    expect(controls.save).toHaveBeenCalledExactlyOnceWith({
      layoutId: draft.layoutId,
      uuid: draft.wallUuid,
      renderSettings: boardLookOptionWallDefault(alternative.id),
    });
    expect(onConfirmed).toHaveBeenCalledOnce();
  });
  it('says the read stalled and retries it from the button', () => {
    controls.stalled = true;
    const { getByText, queryByText } = renderStep();
    expect(getByText('sprayEditor.loadStalled')).toBeTruthy();
    expect(queryByText('sprayWizard.look.unavailable')).toBeNull();
    fireEvent.click(getByText('sprayWizard.review.retry'));
    expect(controls.retry).toHaveBeenCalledOnce();
  });
  it('offers a retry beside the unavailable line too', () => {
    const { getByText } = renderStep();
    expect(getByText('sprayWizard.look.unavailable')).toBeTruthy();
    fireEvent.click(getByText('sprayWizard.review.retry'));
    expect(controls.retry).toHaveBeenCalledOnce();
  });
  it('draws the swipeable rail as a form row, with the dim slider under it, when the wall can be drawn', () => {
    controls.unavailable = false;
    controls.preview = { boardWidth: 500, boardHeight: 700 };
    const { getByTestId, queryAllByRole, queryByTestId } = renderStep();
    expect(getByTestId('board-look-carousel')).toBeTruthy();
    // The names-only fallback is gone once there is a wall to draw.
    expect(queryAllByRole('radio')).toHaveLength(0);
    expect(queryByTestId('look-slider')).toBeNull();
    expect(controls.carouselProps?.showDescriptions).toBe(false);
    expect(controls.carouselProps?.selectedId).toBe(DEFAULT_SPRAY_WALL_LOOK_OPTION_ID);
    const carouselRow = modelRow('lookCarousel');
    expect(carouselRow).toMatchObject({ kind: 'custom', fullBleed: true });
    expect(modelRow('dim')).toMatchObject({ kind: 'slider', label: 'sprayWizard.look.dimTitle' });
  });

  it('lets a swipe choose the look, and saves the one it landed on', async () => {
    controls.unavailable = false;
    controls.preview = { boardWidth: 500, boardHeight: 700 };
    renderStep();
    const alternative = SPRAY_WALL_LOOK_OPTIONS.find((option) => option.id !== DEFAULT_SPRAY_WALL_LOOK_OPTION_ID)!;
    act(() => controls.carouselProps?.onSelect(alternative.id));
    expect(controls.carouselProps?.selectedId).toBe(alternative.id);
    expect(controls.save).not.toHaveBeenCalled();
    await act(async () => pressHeaderTrailing('sprayWizard.next'));
    expect(controls.save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ renderSettings: boardLookOptionWallDefault(alternative.id) }),
    );
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
  const saveButton = () => 'sprayWizard.next';

  it('hides the picker and sends no background to a backend without generated looks', async () => {
    const { queryAllByRole, getByText } = renderStep('background');
    expect(queryAllByRole('radio')).toHaveLength(0);
    expect(getByText(/sprayWizard\.background\.unsupported/)).toBeTruthy();
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
    expect(getByTestId('background-preview').getAttribute('data-value')).toBe('wall-crop');
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
    const { getByTestId } = renderStep('background');
    fireEvent.click(backgroundRadio('photo'));
    expect(getByTestId('background-preview').getAttribute('data-value')).toBe('photo');
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
    const { getByTestId, queryAllByRole, getByText } = renderStep('background');
    expect(getByText(/sprayBackground\.note\.lockedRetake/)).toBeTruthy();
    expect(getByTestId('background-preview').getAttribute('data-value')).toBe('photo');
    expect(queryAllByRole('radio')).toHaveLength(0);
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
    expect(getByText('sprayWizard.look.continueWithout')).toBeTruthy();
    fireEvent.click(getByText('Back to background'));
    expect(getByTestId('background-preview').getAttribute('data-value')).toBe('photo');
  });
});

describe('two look steps keep choices local until final confirmation', () => {
  it('preserves background, hold look and dimming through Back and stores them together', async () => {
    controls.art = artAnswer('GOOD');
    const { getByText, getByTestId, getByRole } = renderStep('background');
    fireEvent.click(backgroundRadio('holdCutouts'));
    finishBackground();
    const alternative = SPRAY_WALL_LOOK_OPTIONS.find(
      (option) => option.id !== DEFAULT_SPRAY_WALL_LOOK_OPTION_ID && option.id !== 'classic',
    )!;
    fireEvent.click(getByRole('radio', { name: alternative.labelI18nKey }));
    act(() => controls.dimProps?.onCommit(0.65));
    fireEvent.click(getByText('Back to background'));
    expect(getByTestId('background-preview').getAttribute('data-value')).toBe('hold-cutouts');
    expect(controls.save).not.toHaveBeenCalled();
    finishBackground();
    expect(getByRole('radio', { name: alternative.labelI18nKey }).getAttribute('aria-checked')).toBe('true');
    await act(async () => pressHeaderTrailing('sprayWizard.next'));
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
    expect(controls.carouselProps?.options.map((option) => option.id)).toEqual(
      SPRAY_WALL_LOOK_OPTIONS.map((option) => option.id),
    );
    expect(controls.carouselProps?.boardseshRendererAvailable).toBe(false);
    expect(controls.carouselProps).not.toHaveProperty('previewUnderlay');
  });
});

describe('the dim slider row', () => {
  function dimRow() {
    const row = modelRow('dim');
    if (row?.kind !== 'slider') throw new Error('no dim slider row');
    return row;
  }

  it('redraws only the selected card while dragging, and writes nothing', () => {
    controls.preview = { boardWidth: 500, boardHeight: 700 };
    controls.unavailable = false;
    renderStep();
    const before = controls.carouselProps?.options;
    act(() => dimRow().onValueChange(0.7));
    const after = controls.carouselProps?.options ?? [];
    const selected = boardLookOptionWallDefault(DEFAULT_SPRAY_WALL_LOOK_OPTION_ID, after);
    expect(selected?.boardsesh.veilOpacity).toBe(0.7);
    // Every other card is the same object it was, so it does not re-render.
    after
      .filter((option) => option.id !== DEFAULT_SPRAY_WALL_LOOK_OPTION_ID)
      .forEach((option) => expect(before).toContain(option));
    expect(dimRow().value).toBe(0.7);
    expect(controls.save).not.toHaveBeenCalled();
  });

  it('keeps the released value, rounded to a step, and stores it with the look', async () => {
    controls.preview = { boardWidth: 500, boardHeight: 700 };
    controls.unavailable = false;
    renderStep();
    act(() => dimRow().onCommit(0.15000000000000002));
    expect(dimRow().value).toBe(0.15);
    await act(async () => pressHeaderTrailing('sprayWizard.next'));
    expect(controls.save.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        renderSettings: expect.objectContaining({ boardsesh: expect.objectContaining({ veilOpacity: 0.15 }) }),
      }),
    );
  });

  it('says a failed save in the form, with the way past it', async () => {
    controls.preview = { boardWidth: 500, boardHeight: 700 };
    controls.unavailable = false;
    controls.save.mockRejectedValueOnce(new Error('offline'));
    const { getByText, getByRole, onConfirmed } = renderStep();
    await act(async () => pressHeaderTrailing('sprayWizard.next'));
    expect(getByText('sprayWizard.look.failed')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'sprayWizard.look.continueWithout' }));
    expect(onConfirmed).toHaveBeenCalledOnce();
  });
});

describe('the wizard names the forward action and keeps the choice', () => {
  it('says what the wizard tells it to, Save on a reset', () => {
    renderStep('look', { lookLabel: 'sprayWizard.details.save' });
    expect(controls.headerTrailing?.label).toBe('sprayWizard.details.save');
  });

  it('reports the confirmed choice, so Back from the details step can bring it back', async () => {
    controls.art = artAnswer('GOOD');
    const { getByRole, onConfirmed } = renderStep('background');
    fireEvent.click(backgroundRadio('holdCutouts'));
    finishBackground();
    const alternative = SPRAY_WALL_LOOK_OPTIONS.find(
      (option) => option.id !== DEFAULT_SPRAY_WALL_LOOK_OPTION_ID && option.id !== 'classic',
    )!;
    fireEvent.click(getByRole('radio', { name: alternative.labelI18nKey }));
    act(() => controls.dimProps?.onCommit(0.4));
    await act(async () => pressHeaderTrailing('sprayWizard.next'));
    expect(onConfirmed).toHaveBeenCalledExactlyOnceWith({
      selectedId: alternative.id,
      dim: 0.4,
      background: 'hold-cutouts',
      backgroundTouched: true,
    });
  });

  it('opens on the choice it is handed', () => {
    const alternative = SPRAY_WALL_LOOK_OPTIONS.find(
      (option) => option.id !== DEFAULT_SPRAY_WALL_LOOK_OPTION_ID && option.id !== 'classic',
    )!;
    const { getByRole } = renderStep('look', {
      initialChoice: { selectedId: alternative.id, dim: 0.3, background: 'photo', backgroundTouched: true },
    });
    expect(getByRole('radio', { name: alternative.labelI18nKey }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('the preview row height', () => {
  it('is worked out from the form slot alone, not the whole step', () => {
    controls.preview = { boardWidth: 500, boardHeight: 700 };
    controls.unavailable = false;
    // The step itself is taller by the header inset and the header block; only
    // the form's own height may count.
    controls.layouts = {
      'spray-look-step': { width: 402, height: 900 },
      'spray-look-form': { width: 402, height: 608 },
    };
    renderStep();
    const row = modelRow('lookCarousel');
    if (row?.kind !== 'custom') throw new Error('no carousel row');
    expect(row.height).toBe(496);
  });
});

describe('the form renderer', () => {
  it.each(['ios', 'android'] as const)(
    'fits %s controls and notes beside the preview before allowing overflow scrolling',
    (platform) => {
      controls.platform.OS = platform;
      controls.preview = { boardWidth: 500, boardHeight: 700 };
      controls.unavailable = false;
      controls.layouts = { 'spray-look-form': { width: 402, height: 500 } };
      renderStep();
      act(() => controls.formProps?.onReservedHeightChange?.(180));
      expect(modelRow('lookCarousel')).toMatchObject({ height: 320 });
      expect(controls.formProps).toMatchObject({ fitted: true, scrollable: false });
      // Translated footers or enlarged labels consume real room, rather than
      // being omitted from a guessed fixed slider-height reservation.
      act(() => controls.formProps?.onReservedHeightChange?.(400));
      expect(controls.formProps?.scrollable).toBe(true);
      expect(controls.carouselProps?.selectOnSnap).toBe(true);
    },
  );
  it('draws both preview forms directly in React Native', () => {
    controls.preview = { boardWidth: 500, boardHeight: 700 };
    controls.unavailable = false;
    renderStep();
    expect(controls.renderer).toBe('rn');
    cleanup();
    controls.renderer = null;
    controls.platform.OS = 'android';
    renderStep();
    expect(controls.renderer).toBe('rn');
  });
});
