// The name of each pinnable filter control, as the Filters sheet shows it. One
// wording for a control wherever a climber picks it: the sheet's pin switches
// and the Settings › Climbs & grades › Quick filters rows. Pure, so both read it
// without pulling in React or native code.

import type { TFunction } from 'i18next';
import type { FilterChipKind } from './pinnable-chips';

/** The control's name (and its chip's resting label where it has one). */
export function filterChipLabel(kind: FilterChipKind, t: TFunction<'climbs'>): string {
  switch (kind) {
    case 'recent':
      return t('mobile.search.recentFilters');
    case 'grade':
      return t('mobile.filter.gradeRange');
    case 'accuracy':
      return t('mobile.filter.accuracy.label');
    case 'progress':
      return t('mobile.filter.progress.label');
    case 'collection':
      return t('mobile.filter.collection.label');
    case 'climbType':
      return t('mobile.filter.climbType.label');
    case 'tall':
      return t('mobile.search.chips.tall');
    case 'wide':
      return t('mobile.search.chips.wide');
    case 'beta':
      return t('mobile.filter.betaVideos');
    case 'popularity':
      return t('mobile.filter.popularity');
    case 'rating':
      return t('mobile.filter.minRating');
    case 'sort':
      return t('mobile.filter.sortBy');
    case 'boardFit':
      return t('mobile.filter.boardFit.label');
  }
}
