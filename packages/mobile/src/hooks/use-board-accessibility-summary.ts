import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { boardRoleCounts } from '../lib/board-accessibility';
export function useBoardAccessibilitySummary(board: BoardName, frames: string): string {
  const { t } = useTranslation('climbs');
  return useMemo(() => t('mobile.boardAccessibility.summary', boardRoleCounts(board, frames)), [board, frames, t]);
}
