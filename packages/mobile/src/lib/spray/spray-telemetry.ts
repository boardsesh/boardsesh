import type { SprayWallPayload } from '@boardsesh/analytics';
import { track } from '../analytics';

/**
 * Send one spray wall event, name and properties together.
 *
 * The builders in `@boardsesh/analytics/spray-wall-events` return the pair so a
 * call site cannot hand one event's props to another event's name, and this is
 * the one line that unpacks them. Nothing else in the spray flows calls `track`
 * with a spray event name directly — that is what keeps "outcomes only, and
 * nothing that identifies a wall" a property of the code rather than of whoever
 * wrote the last call site.
 *
 * `Board Created` is the exception and stays a plain `track`: it is the same
 * event every other board type fires, so it belongs to the board-creation
 * funnel, not to this one.
 */
export function trackSprayEvent<TName extends string, TProperties extends Record<string, number | boolean | string>>(
  payload: SprayWallPayload<TName, TProperties>,
): void {
  track(payload.name, payload.properties);
}
