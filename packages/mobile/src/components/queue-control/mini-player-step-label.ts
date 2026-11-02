import type { TFunction } from 'i18next';
import type { StepTrack } from '@boardsesh/play-view';
import type { QueueNavigationDirection } from '@boardsesh/analytics';

/**
 * Which walk a ⏮ or ⏭ takes, for its spoken label (owner answer 2 on the
 * then-signposts): a named list, Up next, or null for the plain label (the
 * queue with no list, a list nobody named, Next at a list's end).
 */
export type MiniPlayerStepWalk = { kind: 'list'; name: string } | { kind: 'upNext' } | null;

/** The walk a step takes, as {@link MiniPlayerStepWalk}: the step's own track, and the list's name. */
export function miniPlayerStepWalk(track: StepTrack, listName: string | null | undefined): MiniPlayerStepWalk {
  if (track === 'upNext') return { kind: 'upNext' };
  const name = listName?.trim();
  return track === 'list' && name ? { kind: 'list', name } : null;
}

/**
 * ⏮ / ⏭'s spoken label: "Next in Search results", "Next in your queue", or
 * the plain "Next climb". Spoken only: the buttons look as they always have.
 */
export function describeMiniPlayerStep(
  direction: QueueNavigationDirection,
  walk: MiniPlayerStepWalk,
  t: TFunction<'session'>,
): string {
  const next = direction === 'next';
  if (walk?.kind === 'list') {
    return next ? t('playView.track.nextIn', { name: walk.name }) : t('playView.track.previousIn', { name: walk.name });
  }
  if (walk?.kind === 'upNext') return next ? t('playView.track.nextInQueue') : t('playView.track.previousInQueue');
  return next ? t('playView.actionBar.nextAria') : t('playView.actionBar.previousAria');
}
