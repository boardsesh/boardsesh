// The add-a-board wizard (flag `add-board-wizard`): one flow behind the +.
//
//   /boards/add             "Where's the board?"  at a gym | at home | a spray wall
//   /boards/add/gym         "Which gym?"          the map and search (GymStep)
//   /boards/add/gym-boards  "Boards at {gym}"     the gym's walls (GymWallList)
//   /boards/add/new-gym     "Add your gym"        a gym that isn't listed (NewGymStep)
//   /boards/add/board       "Which board?"        the board type tiles
//   /boards/create          Set up                the builder, restyled
//
// Gym path: Where → Which gym? → Boards at {gym} → Set up, or, for a gym that
// isn't listed, Where → Which gym? → Add your gym → (Which board?, when no type
// was chosen on the map) → Set up, with the new gym locked. Home path: Where →
// Which board? → Set up. A spray wall hands off to /boards/spray/new, which has
// its own steps. An entry that already knows the answer skips ahead: a gym
// page opens on its boards, the In range slot's "It's my own board" on Set up
// (the type was heard), first run's inline "At home" on Which board?.
//
// Every step route carries the steps the climber came through (`trail`), so
// "Step N of M" counts what they actually see: a gym page's Set up is step 2
// of 2, not 4 of 4. Pure, so the counting and the routes are tables in tests.

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';

/** One screen of the wizard. `spray` is the hand-off to the add-a-wall wizard. */
export type AddBoardWizardStep = 'where' | 'gym' | 'gym_boards' | 'new_gym' | 'board' | 'setup' | 'spray';

/** Which branch of the wizard: the gym's boards, the climber's own board, or a spray wall. */
export type AddBoardWizardPath = 'gym' | 'home' | 'spray';

/**
 * How the climber reached the wizard: the + in the picker or on Manage boards,
 * the picker's empty state, first run's inline choices, a gym page's "Set up a
 * board", the In range slot's "It's my own board", or an old link
 * (`/boards/where`, `/boards/find-wall`, a bare `/boards/create`) redirected in.
 */
export type AddBoardWizardEntry = 'picker' | 'manage' | 'empty_state' | 'first_run' | 'gym_page' | 'in_range' | 'link';

const ENTRIES: ReadonlySet<string> = new Set<AddBoardWizardEntry>([
  'picker',
  'manage',
  'empty_state',
  'first_run',
  'gym_page',
  'in_range',
  'link',
]);

const COUNTED_STEPS: ReadonlySet<string> = new Set<AddBoardWizardStep>([
  'where',
  'gym',
  'gym_boards',
  'new_gym',
  'board',
  'setup',
]);

/** Read an `entry` route param defensively: anything else is an old link. */
export function parseWizardEntry(value: unknown): AddBoardWizardEntry {
  return typeof value === 'string' && ENTRIES.has(value) ? (value as AddBoardWizardEntry) : 'link';
}

/** Read a `path` route param defensively: null when the builder wasn't opened from the wizard. */
export function parseWizardPath(value: unknown): AddBoardWizardPath | null {
  return value === 'gym' || value === 'home' || value === 'spray' ? value : null;
}

/** Read a `trail` route param: the counted steps before this one, in order. Unknown names are dropped. */
export function parseWizardTrail(value: unknown): AddBoardWizardStep[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  return value.split(',').filter((step): step is AddBoardWizardStep => COUNTED_STEPS.has(step));
}

/**
 * How many counted screens follow `step` on its path: every path ends on Set
 * up. `boardTypeKnown` only matters on Add your gym: with no type chosen on the
 * map, Which board? comes before Set up.
 */
function stepsAfter(step: AddBoardWizardStep, boardTypeKnown: boolean): number {
  switch (step) {
    case 'where':
      // Not knowable before the answer; step 1 shows no counter (see below).
      return 0;
    case 'gym':
      // Then Boards at {gym} (or, for a gym that isn't listed, Add your gym)
      // and Set up. Which gym? can't know the climber will add a gym with no
      // type chosen, which is one screen longer: Add your gym says so.
      return 2;
    case 'new_gym':
      return boardTypeKnown ? 1 : 2;
    case 'gym_boards':
    case 'board':
      return 1;
    case 'setup':
    case 'spray':
      return 0;
  }
}

/** "Step N of M" for a screen, or null when it isn't counted. */
export type WizardStepPosition = { current: number; total: number } | null;

/**
 * Where `step` sits, counting the steps the climber came through (`trail`) and
 * the ones still ahead. Null for step 1 (the path, and so the total, is not
 * chosen yet: a guess would change under the climber), for the spray hand-off,
 * and for a flow of one screen (the In range slot's Set up), where "Step 1 of
 * 1" says nothing.
 */
export function wizardStepPosition(
  step: AddBoardWizardStep,
  trail: readonly AddBoardWizardStep[],
  { boardTypeKnown = false }: { boardTypeKnown?: boolean } = {},
): WizardStepPosition {
  if (step === 'where' || step === 'spray') return null;
  const current = trail.length + 1;
  const total = current + stepsAfter(step, boardTypeKnown);
  return total > 1 ? { current, total } : null;
}

/** What every wizard route passes on: where the flow returns to, and how it was entered. */
export type WizardRouteContext = {
  /** The tab the picker dismisses back to. */
  returnTo?: string;
  /** The picker's own `source`, so a bind closes out first run as a pick there would. */
  source?: string;
  entry: AddBoardWizardEntry;
  /** The counted steps before the next one. */
  trail: readonly AddBoardWizardStep[];
};

type WizardHref = { pathname: string; params: Record<string, string> };

function baseParams(context: WizardRouteContext): Record<string, string> {
  const params: Record<string, string> = { entry: context.entry };
  if (context.returnTo !== undefined) params.returnTo = context.returnTo;
  if (context.source !== undefined) params.source = context.source;
  if (context.trail.length > 0) params.trail = context.trail.join(',');
  return params;
}

/** Step 1, "Where's the board?". */
export function wizardWhereHref(context: Omit<WizardRouteContext, 'trail'>): WizardHref {
  return { pathname: '/boards/add', params: baseParams({ ...context, trail: [] }) };
}

/** "Which gym?". `boardType` opens it filtered to that type. */
export function wizardGymHref(context: WizardRouteContext, boardType?: string | null): WizardHref {
  const params = baseParams(context);
  if (boardType) params.boardType = boardType;
  return { pathname: '/boards/add/gym', params };
}

/** "Boards at {gym}". `boardType` opens its walls of that type. */
export function wizardGymBoardsHref(
  context: WizardRouteContext,
  gymUuid: string,
  boardType?: string | null,
): WizardHref {
  const params = baseParams(context);
  params.gymUuid = gymUuid;
  if (boardType) params.boardType = boardType;
  return { pathname: '/boards/add/gym-boards', params };
}

/**
 * "Add your gym": the gym isn't listed, so the climber adds it (name and a
 * pin) before its board. `boardType` is the type chosen on the map, carried
 * on to Set up; without one, Which board? comes next.
 */
export function wizardNewGymHref(context: WizardRouteContext, boardType?: string | null): WizardHref {
  const params = baseParams(context);
  if (boardType) params.boardType = boardType;
  return { pathname: '/boards/add/new-gym', params };
}

/**
 * "Which board?". On the gym path it follows Add your gym, carrying the gym
 * just added (`gymUuid`) on to Set up, where it is locked.
 */
export function wizardBoardHref(
  context: WizardRouteContext,
  path: 'gym' | 'home',
  options: { gymUuid?: string } = {},
): WizardHref {
  const params = baseParams(context);
  params.path = path;
  if (options.gymUuid) params.gymUuid = options.gymUuid;
  return { pathname: '/boards/add/board', params };
}

/** The builder's `preset` value: open with the board type's most used setup chosen. */
const PRESET_PARAM_VALUE = '1';

/**
 * Set up, from the wizard. A home board opens on the type's most used setup
 * (`preset`). A gym board opens on its type only (`boardType`), with nothing
 * below it chosen, and with the gym locked when it was picked: a gym's wall is
 * shared by everyone who climbs there, so it must never save a guessed layout
 * or size its owner didn't pick.
 */
export function wizardSetupHref(
  context: WizardRouteContext,
  setup: {
    path: 'gym' | 'home';
    boardType?: string | null;
    gymUuid?: string;
  },
): WizardHref {
  const params = baseParams(context);
  params.path = setup.path;
  params.kind = setup.path;
  if (setup.boardType && setup.path === 'home') {
    params.preset = PRESET_PARAM_VALUE;
    params.presetBoardType = setup.boardType;
  } else if (setup.boardType) {
    params.boardType = setup.boardType;
  }
  if (setup.gymUuid) params.gymUuid = setup.gymUuid;
  return { pathname: '/boards/create', params };
}

/** `trail` with `step` added: what the next screen is handed. */
export function trailThrough(trail: readonly AddBoardWizardStep[], step: AddBoardWizardStep): AddBoardWizardStep[] {
  return [...trail, step];
}

/** `Add Board Wizard Step Viewed`. See SHARED_EVENTS. */
export function trackWizardStepViewed(event: {
  step: AddBoardWizardStep;
  path: AddBoardWizardPath | null;
  entry: AddBoardWizardEntry;
}): void {
  track(SHARED_EVENTS.AddBoardWizardStepViewed, event);
}
