// Where each way to add a board leads, for the picker's + menu, its empty
// state, "Where do you climb?" and Manage boards' + menu. Pure, so the params
// every route needs are a table in the tests.

import type { BoardPickerAddKind } from '../../lib/boards/board-picker-add-analytics';

export type AddBoardRoute = {
  pathname: '/boards/create' | '/boards/spray/new' | '/gyms';
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
};

export function addBoardRoute(kind: BoardPickerAddKind, context: AddBoardRouteContext): AddBoardRoute {
  const params: Record<string, string> = {};
  if (context.returnTo !== undefined) params.returnTo = context.returnTo;
  if (context.source !== undefined) params.source = context.source;
  switch (kind) {
    case 'board':
      if (context.preset !== undefined) params.preset = context.preset;
      return { pathname: '/boards/create', params };
    case 'spraywall':
      return { pathname: '/boards/spray/new', params };
    case 'gym_map':
      if (context.fromPicker) params.from = 'picker';
      return { pathname: '/gyms', params };
  }
}
