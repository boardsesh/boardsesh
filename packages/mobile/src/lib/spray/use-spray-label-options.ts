// The translated word a spray-wall row leads with, in the shape
// `@boardsesh/board-config`'s label builders take.
//
// `formatBoardDisplayName` is deliberately English — it spells brand names, and
// a brand does not translate. "Spray wall" is the one value it returns that is
// not a brand: it names a KIND of wall, and it is what a wall's subtitle leads
// with, so leaving it English would put one English phrase in front of an
// otherwise translated row. The label builders are pure and cannot reach a
// catalogue, so the word is handed to them instead.
//
// Memoised, because these options are a `useMemo` dependency of every board
// list that renders subtitles — a fresh object per render would rebuild the
// whole list on each one.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardLabelOptions } from '@boardsesh/board-config';

/**
 * `{ sprayKindLabel }` for `boardRowSubtitle` / `disambiguateBoardSubtitles`.
 *
 * Pass `scope` through when the list has one — one gym's own board list drops
 * the place and leads with the kind, which is exactly the row this exists for.
 */
export function useSprayLabelOptions(scope?: BoardLabelOptions['scope']): BoardLabelOptions {
  const { t } = useTranslation('boards');
  const sprayKindLabel = t('mobile.boardDetail.spray.kind');
  return useMemo(() => (scope ? { scope, sprayKindLabel } : { sprayKindLabel }), [scope, sprayKindLabel]);
}
