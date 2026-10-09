// Board demand telemetry (issue #6062): the signal that a climber looked for a
// board and stopped finding one.
//
// Every spray-wall event in `./spray-wall-events` starts AFTER somebody has
// already decided to put a wall on their wall. Nothing in the funnel records
// the visitor who opened the board picker, scrolled past every gym, and left —
// and that visitor is the whole next-board argument. This event is the top
// edge: one record per submitted "Can't find your board?" form, from either
// platform, with exactly two fields.
//
// The contract, in two sentences: a name from `SHARED_EVENTS` is paired with
// its typed properties by the builder below, and the properties are members of
// closed string unions only. The form's free-text box never reaches PostHog —
// whatever the climber typed goes to the feedback pipeline instead (mobile's
// bug-mode sheet, web's support page), so this event can stay safe to count in
// bulk even though a demand note can name a person, a gym, or a town.

import { SHARED_EVENTS } from './events';

/** A name paired with the exact properties that name expects. */
export type BoardDemandPayload = {
  name: typeof SHARED_EVENTS.BoardDemandReported;
  properties: BoardDemandReportedProps;
};

/**
 * Why the climber says the boards we support are not enough.
 *
 * `gym_board_not_listed` — their gym has a board we drive but the directory
 * does not show it. `unsupported_brand` — the gym has a board we cannot drive
 * at all. `spray_wall` — they want the spray feature for a wall we cannot
 * light. `no_board_yet` — no board anywhere yet; a demand signal for the app
 * itself, worth counting separately. `other` — none of the above, and the free
 * text they typed (not the text) is why the follow-up conversation matters.
 */
export const BOARD_DEMAND_REASONS = [
  'gym_board_not_listed',
  'unsupported_brand',
  'spray_wall',
  'no_board_yet',
  'other',
] as const;
export type BoardDemandReason = (typeof BOARD_DEMAND_REASONS)[number];

/**
 * Which surface handed the form over. The three read differently on a chart:
 * `board_picker` is somebody who has an account and a wall in mind,
 * `first_board` is a brand-new user choosing what to buy or join, and
 * `gym_directory` is search without a match — the purest unmet-demand edge.
 */
export const BOARD_DEMAND_SURFACES = ['board_picker', 'first_board', 'gym_directory'] as const;
export type BoardDemandSurface = (typeof BOARD_DEMAND_SURFACES)[number];

export type BoardDemandReportedProps = {
  reason: BoardDemandReason;
  surface: BoardDemandSurface;
};

/**
 * Which reasons imply a nameable board — a gym's wall we don't list, a brand
 * we don't drive, an answer none of the set covers. Both platforms route those
 * three into a follow-up conversation (mobile opens its bug-mode sheet, www
 * links to the support page): the count is only half the signal, and the
 * WHICH belongs to the feedback pipeline, never to PostHog. `spray_wall` and
 * `no_board_yet` are asks for the feature or for the app itself — the event
 * alone is the record.
 */
export function needsBoardDemandFollowUp(reason: BoardDemandReason): boolean {
  return reason === 'gym_board_not_listed' || reason === 'unsupported_brand' || reason === 'other';
}

/**
 * Build the `Board Demand Reported` payload. Fires once per submitted form —
 * never per tap, never per keystroke — so a weekly count is a count of people
 * who asked, not of how long the sheet stayed open.
 */
export function boardDemandReported(reason: BoardDemandReason, surface: BoardDemandSurface): BoardDemandPayload {
  return { name: SHARED_EVENTS.BoardDemandReported, properties: { reason, surface } };
}
