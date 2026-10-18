import type { ReactNode } from 'react';
import type { BoardLookOptionId } from '../../../lib/board-render/board-look-options';
import type { BoardLookSuggestion } from '../../../lib/board-render/board-look-suggestions';
import type { MoreFormModel, MoreRow, MoreSection } from '../../MoreForm.types';

/**
 * The Board page as plain data — the parent of the two look leaves.
 *
 * The look used to be one scroll of seven headed blocks and about twenty-five
 * controls, with accessibility settings and renderer tuning knobs sitting at the
 * same level. It now leads with the looks and puts everything else one tap away,
 * so the top of the page answers "which look?". Below that come the lighting and
 * Bluetooth groups, which used to be a Board lighting page of their own. Each
 * leaf keeps its own reset, so this page has none.
 *
 * Takes the carousel as a `ReactNode` rather than importing it: that keeps this a
 * pure function of state, so which rows appear — and what the two nav rows say
 * about what is behind them — is testable without a renderer.
 */
export type BoardLookModelInput = {
  /** The preset rail. `null` when there is no board to draw, which hides the row. */
  carousel: ReactNode;
  carouselHeight: number;
  /** Which look the settings sit on, for the Custom look row's subtitle. */
  matchingOptionId: BoardLookOptionId;
  /** Localised label of the current look (e.g. "Bold"). */
  currentLookLabel: string;
  /** How many hold-marker settings are off default, for the Hold colours & shapes subtitle. */
  overriddenCount: number;
  /** `false` = this build cannot draw the Boardsesh look, so say so up front. */
  boardseshRendererAvailable: boolean | null;
  requestedMode: 'classic' | 'aura';
  t: (key: string, options?: Record<string, unknown>) => string;
  onOpenCustomLook: () => void;
  onOpenAccessibility: () => void;
  /**
   * What the phone's own accessibility settings suggest, or `null` for the
   * overwhelmingly common case of nothing to say. Chosen by
   * `pickBoardLookSuggestion`, which is where all the gating lives.
   */
  suggestion: BoardLookSuggestion | null;
  onApplySuggestion: () => void;
  onDismissSuggestion: () => void;
  /**
   * The "use my look on spray walls" switch, or `null` to leave the section out
   * (spray walls not enabled for this climber).
   */
  sprayWalls: { useOwnLook: boolean; onUseOwnLookChange: (useOwnLook: boolean) => void } | null;
  /**
   * The MoonBoard grid letters and numbers switch, or `null` to leave the section
   * out (the active board is not a MoonBoard).
   */
  moonboardGridLabels: { enabled: boolean; onChange: (enabled: boolean) => void } | null;
  /** What lights the board and when the phone lets go of it (`useBoardLightingSections`), last on the page. */
  lightingSections: readonly MoreSection[];
};

export function buildBoardLookModel(input: BoardLookModelInput): MoreFormModel {
  const {
    carousel,
    carouselHeight,
    matchingOptionId,
    currentLookLabel,
    overriddenCount,
    boardseshRendererAvailable,
    requestedMode,
    t,
  } = input;

  const sections: MoreSection[] = [];

  // Only worth saying when they have actually asked for the look this build
  // cannot draw; otherwise it is a warning about nothing.
  if (boardseshRendererAvailable === false && requestedMode === 'aura') {
    sections.push({
      key: 'rendererUnavailable',
      rows: [
        {
          kind: 'info',
          key: 'rendererUnavailable',
          label: t('mobile.settings.boardLook.rendererUnavailable.title'),
          body: t('mobile.settings.boardLook.rendererUnavailable.body'),
        },
      ],
    });
  }

  // Above the rail, because it points at a card in it. One tap applies, one
  // dismisses, and nothing is written until one of them is pressed — the whole
  // point of this feature is that noticing is not the same as deciding.
  if (input.suggestion) {
    sections.push({
      key: 'suggestion',
      rows: [
        {
          kind: 'info',
          key: 'suggestionBody',
          label: t(input.suggestion.titleI18nKey),
          body: t(input.suggestion.bodyI18nKey),
        },
        {
          kind: 'button',
          key: 'suggestionApply',
          label: t(input.suggestion.applyI18nKey),
          onPress: input.onApplySuggestion,
        },
        {
          kind: 'button',
          key: 'suggestionDismiss',
          // The literal, not the exported constant: `t(someVariable)` cannot be
          // statically analysed, so the i18n orphan checker rejects it.
          label: t('mobile.settings.boardLook.suggestion.dismiss'),
          emphasis: 'subtle',
          onPress: input.onDismissSuggestion,
        },
      ],
    });
  }

  if (carousel) {
    sections.push({
      key: 'presets',
      title: t('mobile.settings.boardLook.presets.title'),
      // No footer: the cards are renders of the climber's own board, so a
      // sentence explaining that you are choosing how holds render only repeats
      // what the rail is already showing.
      rows: [{ kind: 'custom', key: 'presetsCarousel', content: carousel, height: carouselHeight, fullBleed: true }],
    });
  }

  const destinations: MoreRow[] = [
    {
      kind: 'nav',
      key: 'customLook',
      label: t('mobile.settings.boardLook.customLook.title'),
      // Says which look you are on, so the row reads as "go and tune what you
      // have" rather than as another way to switch looks.
      subtitle:
        matchingOptionId === 'custom'
          ? t('mobile.settings.boardLook.customLook.rowSubtitleCustom')
          : t('mobile.settings.boardLook.customLook.rowSubtitle', { look: currentLookLabel }),
      icon: 'boardLook',
      onPress: input.onOpenCustomLook,
    },
    {
      kind: 'nav',
      key: 'accessibility',
      label: t('mobile.settings.boardLook.accessibility.pageTitle'),
      subtitle:
        overriddenCount === 0
          ? t('mobile.settings.boardLook.accessibility.rowSubtitleDefault')
          : t('mobile.settings.boardLook.accessibility.rowSubtitleOverridden', { count: overriddenCount }),
      icon: 'accessibility',
      onPress: input.onOpenAccessibility,
    },
  ];

  sections.push({ key: 'destinations', rows: destinations });

  if (input.sprayWalls) {
    const { useOwnLook, onUseOwnLookChange } = input.sprayWalls;
    sections.push({
      key: 'sprayWalls',
      title: t('mobile.settings.boardLook.sprayWalls.title'),
      rows: [
        {
          kind: 'toggle',
          key: 'sprayWallsUseOwnLook',
          label: t('mobile.settings.boardLook.sprayWalls.useOwnLook'),
          value: useOwnLook,
          onValueChange: onUseOwnLookChange,
        },
      ],
      footer: t('mobile.settings.boardLook.sprayWalls.footer'),
    });
  }

  if (input.moonboardGridLabels) {
    const { enabled, onChange } = input.moonboardGridLabels;
    sections.push({
      key: 'moonboard',
      title: t('mobile.settings.boardLook.moonboard.title'),
      rows: [
        {
          kind: 'toggle',
          key: 'moonboardGridLabels',
          label: t('mobile.settings.boardLook.moonboard.gridLabels'),
          value: enabled,
          onValueChange: onChange,
        },
      ],
      footer: t('mobile.settings.boardLook.moonboard.footer'),
    });
  }

  sections.push(...input.lightingSections);

  return { sections };
}
