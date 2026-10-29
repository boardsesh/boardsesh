import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { BusyWallQuestionModel } from './busy-wall-question';
import { shortCaptionName } from './track-label-text';

// The words for a busy-wall question model (`resolveBusyWallQuestion`), shared
// by the header caption, the announcement and the pair of segments, so they
// can't word one question two ways.

export type BusyWallQuestionText = {
  /** "Test2 just put up Crimp Ladder": the header caption, and what VoiceOver hears once. */
  caption: string;
  /** "Keep Test2's", or "Keep theirs" when nobody can be named. */
  keepLabel: string;
  /** "Keep theirs": Keep's label where the name won't fit. */
  keepShortLabel: string;
  putLabel: string;
};

/**
 * The caption: who put up which climb. The climb's name comes last in every
 * language and is cut short first (`shortCaptionName`), so the line's own
 * truncation takes the climb before the name.
 */
export function formatBusyWallCaption(model: BusyWallQuestionModel, t: TFunction<'session'>): string {
  const name = shortCaptionName(model.wallClimbName);
  return model.holderName
    ? t('playView.wallState.busyWall.captionNamed', { person: model.holderName, name })
    : t('playView.wallState.busyWall.caption', { name });
}

export function formatBusyWallQuestion(model: BusyWallQuestionModel, t: TFunction<'session'>): BusyWallQuestionText {
  const keepShortLabel = t('playView.wallState.commitOverride.cancel');
  return {
    caption: formatBusyWallCaption(model, t),
    keepLabel: model.holderName
      ? t('playView.wallState.commitOverride.cancelNamed', { person: model.holderName })
      : keepShortLabel,
    keepShortLabel,
    putLabel: t('playView.wallState.commitOverride.confirm'),
  };
}

export function useBusyWallQuestionText(model: BusyWallQuestionModel): BusyWallQuestionText {
  const { t } = useTranslation('session');
  return useMemo(() => formatBusyWallQuestion(model, t), [model, t]);
}
