// Where each way to add a board leads, for the picker's + menu, its empty
// state, "Where do you climb?" and Manage boards' + menu. Pure, so the params
// every route needs are a table in the tests.

import type { BoardKind, BoardPickerAddKind } from '../../lib/boards/board-picker-add-analytics';
import { BUILDER_PRESET_PARAM_VALUE } from '../../lib/boards/first-board-mode';

export type AddBoardRoute = {
  pathname: '/boards/create' | '/boards/spray/new' | '/gyms' | '/boards/where' | '/boards/find-wall';
  params: Record<string, string>;
};

export type AddBoardRouteContext = {
  /** The tab the picker dismisses back to; absent leaves the route's default. */
  returnTo?: string;
  /**
   * The picker's own `source` param. It rides along so a board made or picked
   * on the route closes out first run (`onboarding`) and keeps its analytics
   * entry, exactly as a pick in the picker would.
   */
  source?: string;
  /** Opens the builder with the board type's most used setup chosen ("My own board"). */
  preset?: string;
  /**
   * The board picker itself is opening the gym map, and has already counted
   * this picker session's opening (`useBoardPickerAnalytics`), so the map must
   * not count another. Manage boards leaves it off: the map counts its own.
   */
  fromPicker?: boolean;
  /**
   * The gym-first flow (#8151, `create-board-gym-first`). Only read for the
   * builder: `home` opens it preset, as "My own board" does; `gym` opens the
   * gym search, or the gym's wall list with `gymUuid`; `ask` opens "Where's
   * this board?" for an entry that hasn't said. Absent is the builder as it was.
   */
  boardKind?: BoardKind | 'ask';
  /** With `boardKind: 'gym'`: open on this gym's walls (a gym page's "Set up a board"). */
  gymUuid?: string;
};

export function addBoardRoute(kind: BoardPickerAddKind, context: AddBoardRouteContext): AddBoardRoute {
  const params: Record<string, string> = {};
  if (context.returnTo !== undefined) params.returnTo = context.returnTo;
  if (context.source !== undefined) params.source = context.source;
  switch (kind) {
    case 'board':
      switch (context.boardKind) {
        case 'ask':
          return { pathname: '/boards/where', params };
        case 'gym':
          if (context.gymUuid !== undefined) {
            params.gymUuid = context.gymUuid;
            params.entry = 'gym_page';
          }
          return { pathname: '/boards/find-wall', params };
        case 'home':
          params.kind = 'home';
          params.preset = context.preset ?? BUILDER_PRESET_PARAM_VALUE;
          return { pathname: '/boards/create', params };
        case undefined:
          if (context.preset !== undefined) params.preset = context.preset;
          return { pathname: '/boards/create', params };
      }
      break;
    case 'spraywall':
      return { pathname: '/boards/spray/new', params };
    case 'gym_map':
      if (context.fromPicker) params.from = 'picker';
      return { pathname: '/gyms', params };
  }
}
