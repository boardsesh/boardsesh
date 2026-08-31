import {
  BOARD_RENDER_SETTING_BOUNDS,
  GLOW_FALLOFF_OPTIONS,
  MARK_STYLE_OPTIONS,
  THUMBNAIL_STYLE_OPTIONS,
  VEIL_OPTIONS,
  type BoardRenderModeSetting,
  type BoardseshRenderSettings,
} from '../../../lib/board-render-settings';
import type { ReactNode } from 'react';
import type { MoreFormModel, MoreRow } from '../../MoreForm.types';

/**
 * The "Custom look" screen as plain data.
 *
 * A pure builder rather than a component, because almost everything interesting
 * about this screen is which rows are VISIBLE — three of the four sliders are
 * conditional, and one of those conditions is subtle enough to have earned its
 * own test. As a function that is a node test with no renderer, no theme
 * provider and no mocks; as JSX it was six mocked modules to assert one row.
 */
export type CustomLookModelInput = {
  boardsesh: BoardseshRenderSettings;
  mode: BoardRenderModeSetting;
  /** What the mode control shows: the resolved mode when nothing is chosen yet. */
  selectedMode: 'classic' | 'boardsesh';
  /**
   * The falloff the render ACTUALLY uses right now, with `default` resolved.
   * The plateau-share slider gates on this rather than on the raw picker, so a
   * `default` that resolves to `plateau` still surfaces the control that shapes
   * what is on the wall.
   */
  effectiveGlowFalloff: 'soft' | 'plateau';
  /** `false` = this build cannot draw the Boardsesh look, so that segment is dead. */
  boardseshRendererAvailable: boolean | null;
  t: (key: string, options?: Record<string, unknown>) => string;
  setMode: (mode: BoardRenderModeSetting) => void;
  setBoardseshField: <F extends keyof BoardseshRenderSettings>(field: F, value: BoardseshRenderSettings[F]) => void;
  /** Per-field draft state, so a drag doesn't write to the store on every frame. */
  draft: Record<CustomLookSliderKey, { value: number; onValueChange: (value: number) => void }>;
  /**
   * The board being tuned, shown above the knobs. `null` when there is no board
   * to draw, which drops the row rather than leaving an empty frame.
   */
  preview: ReactNode;
  previewHeight: number;
};

export type CustomLookSliderKey = 'glowReach' | 'plateauShare' | 'veilOpacity' | 'fillOpacity';

const BOARDSESH_DISABLED_KEYS = new Set<BoardRenderModeSetting>(['boardsesh']);

export function buildCustomLookModel(input: CustomLookModelInput): MoreFormModel {
  const { boardsesh, selectedMode, effectiveGlowFalloff, boardseshRendererAvailable, t, setMode, draft } = input;
  const setField = input.setBoardseshField;

  // Takes an already-resolved label, never a key: `t(someVariable)` cannot be
  // statically analysed, so the i18n orphan checker rejects it outright.
  const slider = (
    key: CustomLookSliderKey,
    label: string,
    bounds: { min: number; max: number },
    step: number,
    format: (value: number) => string,
  ): MoreRow => ({
    kind: 'slider',
    key,
    label,
    value: draft[key].value,
    min: bounds.min,
    max: bounds.max,
    step,
    format,
    onValueChange: draft[key].onValueChange,
    onCommit: (value) => setField(key, value),
  });

  const glowVeilRows: MoreRow[] = [
    {
      kind: 'segmented',
      key: 'glowFalloff',
      label: t('mobile.more.boardLook.glowVeil.falloff.title'),
      options: GLOW_FALLOFF_OPTIONS.map((option) => ({
        key: option,
        label: t(`mobile.more.boardLook.glowVeil.falloff.options.${option}`),
      })),
      selectedKey: boardsesh.glowFalloff,
      onSelect: (key) => setField('glowFalloff', key as BoardseshRenderSettings['glowFalloff']),
    },
    slider(
      'glowReach',
      t('mobile.more.boardLook.glowVeil.reach.title'),
      BOARD_RENDER_SETTING_BOUNDS.glowReach,
      0.1,
      (v) => t('mobile.more.boardLook.glowVeil.reach.value', { value: v.toFixed(1) }),
    ),
  ];

  if (effectiveGlowFalloff === 'plateau') {
    glowVeilRows.push(
      slider(
        'plateauShare',
        t('mobile.more.boardLook.glowVeil.plateauShare.title'),
        BOARD_RENDER_SETTING_BOUNDS.plateauShare,
        0.05,
        (v) => t('mobile.more.boardLook.glowVeil.plateauShare.value', { value: Math.round(v * 100) }),
      ),
    );
  }

  glowVeilRows.push({
    kind: 'segmented',
    key: 'veil',
    label: t('mobile.more.boardLook.glowVeil.veil.title'),
    options: VEIL_OPTIONS.map((option) => ({
      key: option,
      label: t(`mobile.more.boardLook.glowVeil.veil.options.${option}`),
    })),
    selectedKey: boardsesh.veil,
    onSelect: (key) => setField('veil', key as BoardseshRenderSettings['veil']),
  });

  if (boardsesh.veil === 'custom') {
    glowVeilRows.push(
      slider(
        'veilOpacity',
        t('mobile.more.boardLook.glowVeil.veilOpacity.title'),
        BOARD_RENDER_SETTING_BOUNDS.veilOpacity,
        0.05,
        (v) => t('mobile.more.boardLook.glowVeil.veilOpacity.value', { value: Math.round(v * 100) }),
      ),
    );
  }

  const marksRows: MoreRow[] = [
    {
      kind: 'segmented',
      key: 'markStyle',
      label: t('mobile.more.boardLook.marks.style.title'),
      options: MARK_STYLE_OPTIONS.map((option) => ({
        key: option,
        label: t(`mobile.more.boardLook.marks.style.options.${option === 'glow-fill' ? 'glowFill' : option}`),
      })),
      selectedKey: boardsesh.markStyle,
      onSelect: (key) => setField('markStyle', key as BoardseshRenderSettings['markStyle']),
    },
  ];

  if (boardsesh.markStyle !== 'glow') {
    marksRows.push(
      slider(
        'fillOpacity',
        t('mobile.more.boardLook.marks.fillOpacity.title'),
        BOARD_RENDER_SETTING_BOUNDS.fillOpacity,
        0.05,
        (v) => t('mobile.more.boardLook.marks.fillOpacity.value', { value: Math.round(v * 100) }),
      ),
    );
  }

  marksRows.push(
    {
      kind: 'toggle',
      key: 'softDisc',
      label: t('mobile.more.boardLook.marks.softDisc.label'),
      subtitle: t('mobile.more.boardLook.marks.softDisc.subtitle'),
      value: boardsesh.softDisc,
      onValueChange: (value) => setField('softDisc', value),
    },
    {
      kind: 'toggle',
      key: 'smallHoldBoost',
      label: t('mobile.more.boardLook.marks.smallHoldBoost.label'),
      subtitle: t('mobile.more.boardLook.marks.smallHoldBoost.subtitle'),
      value: boardsesh.smallHoldBoost,
      onValueChange: (value) => setField('smallHoldBoost', value),
    },
    {
      kind: 'toggle',
      key: 'ledDots',
      label: t('mobile.more.boardLook.marks.ledDots.label'),
      subtitle: t('mobile.more.boardLook.marks.ledDots.subtitle'),
      value: boardsesh.ledDots,
      onValueChange: (value) => setField('ledDots', value),
    },
    {
      kind: 'segmented',
      key: 'thumbnailStyle',
      label: t('mobile.more.boardLook.marks.thumbnailStyle.title'),
      options: THUMBNAIL_STYLE_OPTIONS.map((option) => ({
        key: option,
        label: t(`mobile.more.boardLook.marks.thumbnailStyle.options.${option}`),
      })),
      selectedKey: boardsesh.thumbnailStyle,
      onSelect: (key) => setField('thumbnailStyle', key as BoardseshRenderSettings['thumbnailStyle']),
    },
  );

  const sections: MoreFormModel['sections'] = [];

  // First, because the knobs below are meaningless without the thing they act
  // on: you tune this screen by looking at the board, not by reading values.
  if (input.preview) {
    sections.push({
      key: 'preview',
      rows: [
        {
          kind: 'custom',
          key: 'customLookPreview',
          content: input.preview,
          height: input.previewHeight,
          fullBleed: true,
        },
      ],
    });
  }

  sections.push(
    {
      key: 'mode',
      title: t('mobile.more.boardLook.mode.title'),
      rows: [
        {
          kind: 'segmented',
          key: 'mode',
          label: t('mobile.more.boardLook.mode.title'),
          options: (['classic', 'boardsesh'] as const).map((option) => ({
            key: option,
            label: t(`mobile.more.boardLook.mode.options.${option}`),
          })),
          selectedKey: selectedMode,
          onSelect: (key) => setMode(key as BoardRenderModeSetting),
          disabledKeys: boardseshRendererAvailable === false ? BOARDSESH_DISABLED_KEYS : undefined,
        },
      ],
    },
    { key: 'glowVeil', title: t('mobile.more.boardLook.glowVeil.title'), rows: glowVeilRows },
    { key: 'marks', title: t('mobile.more.boardLook.marks.title'), rows: marksRows },
  );

  return { sections };
}
