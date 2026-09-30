/**
 * The workouts Boardz offers. Each `kind` is spelled like the block `type` in
 * Boardsesh's partner workout API (docs/partner-api.md), so a workout written
 * for that API maps onto these one to one.
 */
export type WorkoutKind =
  | 'warmUp'
  | 'pyramid'
  | 'ladder'
  | 'volume'
  | 'gradeFocus'
  | 'onTheMinute'
  | 'fourByFour'
  | 'limitBouldering'
  | 'freeClimbing';

/**
 * How a workout chooses climbs and paces itself.
 * - `generator`: @boardsesh/playlist-generator plans a grade for each climb.
 *   The warm-up uses the generator's `warmUp` option rather than a workout type.
 * - `timed`: a set of climbs run against a clock (intervals, rounds, rests).
 * - `free`: a timer only; the climber picks the climbs.
 */
export type WorkoutEngine = 'generator' | 'timed' | 'free';

export type WorkoutDefinition = {
  kind: WorkoutKind;
  name: string;
  summary: string;
  engine: WorkoutEngine;
};

export const WORKOUTS: readonly WorkoutDefinition[] = [
  {
    kind: 'warmUp',
    name: 'Warm-up',
    summary: 'Step up through easy grades before you try hard.',
    engine: 'generator',
  },
  {
    kind: 'pyramid',
    name: 'Pyramid',
    summary: 'Climb up the grades to your peak, then back down.',
    engine: 'generator',
  },
  {
    kind: 'ladder',
    name: 'Ladder',
    summary: 'Climb up the grades and stop at your peak.',
    engine: 'generator',
  },
  {
    kind: 'volume',
    name: 'Volume',
    summary: 'Lots of climbs around one grade to build mileage.',
    engine: 'generator',
  },
  {
    kind: 'gradeFocus',
    name: 'Grade focus',
    summary: 'Every climb at the same grade.',
    engine: 'generator',
  },
  {
    kind: 'onTheMinute',
    name: 'On the minute',
    summary: 'A new climb every minute. The board moves on by itself.',
    engine: 'timed',
  },
  {
    kind: 'fourByFour',
    name: '4x4',
    summary: 'Four climbs, four rounds, with timed rests in between.',
    engine: 'timed',
  },
  {
    kind: 'limitBouldering',
    name: 'Limit bouldering',
    summary: 'A few hard problems and long rests. Attempts count more than sends.',
    engine: 'timed',
  },
  {
    kind: 'freeClimbing',
    name: 'Free climbing',
    summary: 'A timer runs while you pick your own climbs.',
    engine: 'free',
  },
];
