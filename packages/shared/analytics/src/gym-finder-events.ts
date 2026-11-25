// Gym finder telemetry (mobile, from 2026-11): the add-a-board wizard's
// "Which gym?" step, the gym map and the builders' gym picker. The names and what each one means live in
// `SHARED_EVENTS` (events.ts); this file types the PROPERTIES and pairs each
// with its own name, so a call site cannot invent a field or send one event's
// props under another's name.
//
// Nothing here identifies a gym, a place or a climber: every field is a member
// of a closed string union. The question these answer is how climbers find a
// gym (list or pin, town or name, locate) and how often the gym isn't there.

import { SHARED_EVENTS } from './events';

/**
 * Where the event fired: the wizard's "Which gym?" step, the gym map (the root
 * one and the board picker's copy alike), or the builders' gym row (the same
 * step in pick mode).
 */
export type GymFinderSurface = 'wizard_gym_step' | 'gyms_map' | 'builder_gym_picker';

/** How the chosen gym was reached: its row in the list, or its pin on the map. */
export type GymFinderPickSection = 'list' | 'map_pin';

/** What the search field was used for: a town to look around, or a gym's name. */
export type GymFinderSearchKind = 'town' | 'name';

type GymFinderPayload<TName extends string, TProperties extends Record<string, string>> = {
  name: TName;
  properties: TProperties;
};

export type GymFinderGymPickedProps = { surface: GymFinderSurface; section: GymFinderPickSection };

export function gymFinderGymPicked(
  properties: GymFinderGymPickedProps,
): GymFinderPayload<typeof SHARED_EVENTS.GymFinderGymPicked, GymFinderGymPickedProps> {
  return { name: SHARED_EVENTS.GymFinderGymPicked, properties };
}

export type GymFinderSurfaceProps = { surface: GymFinderSurface };

export function gymFinderAddMyGymTapped(
  surface: GymFinderSurface,
): GymFinderPayload<typeof SHARED_EVENTS.GymFinderAddMyGymTapped, GymFinderSurfaceProps> {
  return { name: SHARED_EVENTS.GymFinderAddMyGymTapped, properties: { surface } };
}

export type GymFinderSearchUsedProps = { surface: GymFinderSurface; kind: GymFinderSearchKind };

export function gymFinderSearchUsed(
  properties: GymFinderSearchUsedProps,
): GymFinderPayload<typeof SHARED_EVENTS.GymFinderSearchUsed, GymFinderSearchUsedProps> {
  return { name: SHARED_EVENTS.GymFinderSearchUsed, properties };
}

export function gymFinderLocateTapped(
  surface: GymFinderSurface,
): GymFinderPayload<typeof SHARED_EVENTS.GymFinderLocateTapped, GymFinderSurfaceProps> {
  return { name: SHARED_EVENTS.GymFinderLocateTapped, properties: { surface } };
}

/** Where a gym was created from. Only the add-a-board wizard's "Add your gym" today. */
export type GymCreatedSurface = 'wizard';

/**
 * Where the new gym's location came from: the device fix, the map moved under
 * the dot, or a typed address geocoded. `town` (a picked town, the map not
 * moved yet) is a pin the app holds but never saves, so `Gym Created` never
 * carries it.
 */
export type GymLocationSource = 'device' | 'map' | 'town' | 'address';

export type GymCreatedProps = {
  surface: GymCreatedSurface;
  /** How many different listed gyms were shown as "already listed nearby" before the save went through. */
  similarShown: number;
  /** The save named gyms the climber said were not theirs (`CONFIRMED_SEPARATE`). */
  confirmedSeparate: boolean;
  /** An address was given. Never the address itself. */
  hasAddress: boolean;
  locationSource: GymLocationSource;
};

/** `Gym Created`: a climber added a gym. Counts and flags only, no gym, name or place. */
export function gymCreated(properties: GymCreatedProps): {
  name: typeof SHARED_EVENTS.GymCreated;
  properties: GymCreatedProps;
} {
  return { name: SHARED_EVENTS.GymCreated, properties };
}
