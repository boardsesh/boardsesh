// Where the retired gym-first routes (#8151) send an old link now:
// `/boards/where` and `/boards/find-wall` redirect into the add-a-board wizard
// with its flag on, and to the builder with it off. Kept for one release after
// the add-board-wizard flag ships to everyone, then deleted with the routes.

import {
  wizardGymBoardsHref,
  wizardGymHref,
  type AddBoardWizardEntry,
  type WizardRouteContext,
} from './add-board-wizard';

type Href = { pathname: string; params: Record<string, string> };

/** The builder as it was before the wizard, carrying only the picker's return and source. */
export function legacyBuilderHref({ returnTo, source }: { returnTo?: string; source?: string }): Href {
  const params: Record<string, string> = {};
  if (returnTo !== undefined) params.returnTo = returnTo;
  if (source !== undefined) params.source = source;
  return { pathname: '/boards/create', params };
}

/**
 * `/boards/find-wall` in the wizard: a gym's boards when it names a gym (a gym
 * page's old link keeps its `gym_page` entry), else Which gym?. Counted as
 * the steps the old flow had shown before it, so "Step N of M" still adds up.
 */
export function findWallRedirectHref(params: {
  gymUuid?: string;
  boardType?: string;
  returnTo?: string;
  source?: string;
  entry?: string;
}): Href {
  const gymUuid = typeof params.gymUuid === 'string' && params.gymUuid.length > 0 ? params.gymUuid : null;
  const entry: AddBoardWizardEntry = params.entry === 'gym_page' ? 'gym_page' : 'link';
  const base = { returnTo: params.returnTo, source: params.source, entry };
  if (!gymUuid) {
    const context: WizardRouteContext = { ...base, trail: ['where'] };
    return wizardGymHref(context, params.boardType);
  }
  const context: WizardRouteContext = { ...base, trail: entry === 'gym_page' ? [] : ['where', 'gym'] };
  return wizardGymBoardsHref(context, gymUuid, params.boardType);
}
