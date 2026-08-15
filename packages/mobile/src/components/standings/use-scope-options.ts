import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { GLOBAL_SCOPE, RANKED_BOARD_TYPES, layoutScopeKey, type Scope } from '@boardsesh/leaderboard';
import { useMyBoards } from '../../lib/graphql/hooks';

export type ScopeOption = {
  scope: Scope;
  label: string;
};

/**
 * The scopes a climber can switch between.
 *
 * Built from what the app already holds — the board allowlist and the
 * climber's own walls — rather than a new "enumerate every live scope" query.
 * That is a deliberate limit: it means the picker offers the scopes this
 * climber has a reason to care about, and it cannot turn into a browsable
 * directory of strangers' home walls. Someone else's wall is still reachable,
 * but only through the existing gym/board discovery routes, the same as before.
 *
 * Ordered widest-first (Everyone → board type → setup → your walls) so the
 * fallback ladder reads top-to-bottom in the same direction the server walks it.
 */
export function useScopeOptions(): ScopeOption[] {
  const { t } = useTranslation('boards');
  const { data: myBoards } = useMyBoards();

  return useMemo(() => {
    const options: ScopeOption[] = [{ scope: GLOBAL_SCOPE, label: t('standings.scope.global') }];

    for (const boardType of RANKED_BOARD_TYPES) {
      options.push({
        scope: { kind: 'boardType', key: boardType },
        // i18n-keep boards.standings.boardType.kilter
        // i18n-keep boards.standings.boardType.tension
        // i18n-keep boards.standings.boardType.moonboard
        label: t(`standings.boardType.${boardType}`),
      });
    }

    const boards = myBoards?.boards ?? [];

    // The setups this climber actually owns a wall on. Deduped, because two of
    // their walls can share a layout and a repeated row reads as a bug.
    const seenLayouts = new Set<string>();
    for (const board of boards) {
      const key = layoutScopeKey(board.boardType, board.layoutId);
      if (seenLayouts.has(key)) continue;
      seenLayouts.add(key);
      options.push({
        scope: { kind: 'layout', key },
        label: board.layoutName ?? key,
      });
    }

    for (const board of boards) {
      options.push({ scope: { kind: 'board', key: board.uuid }, label: board.name });
    }

    // Gyms the climber's walls belong to, deduped the same way.
    const seenGyms = new Set<string>();
    for (const board of boards) {
      if (!board.gymUuid || seenGyms.has(board.gymUuid)) continue;
      seenGyms.add(board.gymUuid);
      options.push({ scope: { kind: 'gym', key: board.gymUuid }, label: board.gymName ?? board.gymUuid });
    }

    return options;
  }, [myBoards, t]);
}
