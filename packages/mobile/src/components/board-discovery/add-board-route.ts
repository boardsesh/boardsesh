// Where each way to add a board leads, for the picker's + (or + menu), its
// empty state, "Where do you climb?" and Manage boards' +. Pure, so the params
// every route needs are a table in the tests.
//
// With the `add-board-wizard` flag on, the builder is reached through the
// wizard (`wizardEntry`): the + pushes its step 1. Off, the + menu's rows open
// the builder, the add-a-wall wizard and the gym map as before. Every route
// here is in the picker's own stack, the gym map included.

import type { BoardPickerAddKind } from '../../lib/boards/board-picker-add-analytics';
import { wizardWhereHref, type AddBoardWizardEntry } from '../../lib/boards/add-board-wizard';
import { gymMapHref, type GymMapHref } from '../gym-page/gym-page-route';

export type AddBoardRoute = {
  pathname: '/boards/create' | '/boards/spray/new' | GymMapHref['pathname'] | '/boards/add';
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
   * The add-a-board wizard is on: `board` opens its step 1, "Where's the
   * board?", counted as entered from here. Only read for `board`.
   */
  wizardEntry?: AddBoardWizardEntry;
};

export function addBoardRoute(kind: BoardPickerAddKind, context: AddBoardRouteContext): AddBoardRoute {
  const params: Record<string, string> = {};
  if (context.returnTo !== undefined) params.returnTo = context.returnTo;
  if (context.source !== undefined) params.source = context.source;
  switch (kind) {
    case 'board':
      if (context.wizardEntry !== undefined) {
        const where = wizardWhereHref({
          returnTo: context.returnTo,
          source: context.source,
          entry: context.wizardEntry,
        });
        return { pathname: '/boards/add', params: where.params };
      }
      if (context.preset !== undefined) params.preset = context.preset;
      return { pathname: '/boards/create', params };
    case 'spraywall':
      return { pathname: '/boards/spray/new', params };
    case 'gym_map': {
      if (context.fromPicker) params.from = 'picker';
      // Every caller stands in the picker's stack, so the map is the picker's
      // own copy: the root `/gyms` pushed from in there would stack a second
      // sheet on the picker (gym-page-route.ts).
      return gymMapHref('boards', params);
    }
  }
}

/** The serial field's own limit (BoardForm's `maxLength`). */
const SERIAL_MAX_LENGTH = 100;

/**
 * The builder's `serial` param as its serial field takes it: trimmed, and only
 * within the field's 100 characters. Anything else opens with the field empty,
 * as before the param existed.
 */
export function builderSerialParam(value: string | string[] | undefined): string | undefined {
  const serial = typeof value === 'string' ? value.trim() : '';
  return serial.length > 0 && serial.length <= SERIAL_MAX_LENGTH ? serial : undefined;
}
