import type { ReactNode } from 'react';
import type { BoardLookOptionId } from '../../../lib/board-render/board-look-options';
import type { MoreFormModel, MoreRow, MoreSection } from '../../MoreForm.types';

/**
 * The Board look screen as plain data — the parent of the two leaves.
 *
 * The screen used to be one scroll of seven headed blocks and about twenty-five
 * controls, with accessibility settings and renderer tuning knobs sitting at the
 * same level. It now leads with the looks and puts everything else one tap away,
 * so the first screen answers "which look?" and nothing else.
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
  /** How many hold-marker settings are off default, for the Accessibility subtitle. */
  overriddenCount: number;
  /** `false` = this build cannot draw the Boardsesh look, so say so up front. */
  boardseshRendererAvailable: boolean | null;
  requestedMode: 'classic' | 'boardsesh';
  t: (key: string, options?: Record<string, unknown>) => string;
  onOpenCustomLook: () => void;
  onOpenAccessibility: () => void;
  onResetBoardLook: () => void;
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
  if (boardseshRendererAvailable === false && requestedMode === 'boardsesh') {
    sections.push({
      key: 'rendererUnavailable',
      rows: [
        {
          kind: 'info',
          key: 'rendererUnavailable',
          label: t('mobile.more.boardLook.rendererUnavailable.title'),
          body: t('mobile.more.boardLook.rendererUnavailable.body'),
        },
      ],
    });
  }

  if (carousel) {
    sections.push({
      key: 'presets',
      title: t('mobile.more.boardLook.presets.title'),
      rows: [{ kind: 'custom', key: 'presetsCarousel', content: carousel, height: carouselHeight, fullBleed: true }],
      footer: t('mobile.more.boardLook.description'),
    });
  }

  const destinations: MoreRow[] = [
    {
      kind: 'nav',
      key: 'customLook',
      label: t('mobile.more.boardLook.customLook.title'),
      // Says which look you are on, so the row reads as "go and tune what you
      // have" rather than as another way to switch looks.
      subtitle:
        matchingOptionId === 'custom'
          ? t('mobile.more.boardLook.customLook.rowSubtitleCustom')
          : t('mobile.more.boardLook.customLook.rowSubtitle', { look: currentLookLabel }),
      icon: 'boardLook',
      onPress: input.onOpenCustomLook,
    },
    {
      kind: 'nav',
      key: 'accessibility',
      label: t('mobile.more.boardLook.accessibility.title'),
      subtitle:
        overriddenCount === 0
          ? t('mobile.more.boardLook.accessibility.rowSubtitleDefault')
          : t('mobile.more.boardLook.accessibility.rowSubtitleOverridden', { count: overriddenCount }),
      icon: 'accessibility',
      onPress: input.onOpenAccessibility,
    },
  ];

  sections.push({ key: 'destinations', rows: destinations });

  sections.push({
    key: 'reset',
    rows: [
      {
        kind: 'button',
        key: 'resetBoardLook',
        label: t('mobile.more.boardLook.resetAll'),
        emphasis: 'subtle',
        onPress: input.onResetBoardLook,
      },
    ],
    // The footer is what makes the reset split legible: this button used to wipe
    // the climber's hold colours too, under a label that never mentioned them.
    footer: t('mobile.more.boardLook.resetAllNote'),
  });

  return { sections };
}
