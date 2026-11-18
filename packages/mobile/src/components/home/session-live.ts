// What Home's Session card shows when climbers are in a live session (#7689).
// Pure: no React, no i18n. The card leads with one session and offers Join and
// Start my own; the rest fold into one "+ N more climbing now" line.

import { isQuietSession, type LiveCardModel } from '../live-sessions/live-session-model';

/**
 * How many characters fit on one line of a half-width button at the default
 * text size: two equal buttons on a 375pt phone leave each label about 128pt,
 * 14 characters of a 16pt semibold label. Larger text fits fewer.
 */
export const MAX_JOIN_LABEL_LENGTH = 14;
/** Past this text size the buttons stack whatever their labels. */
export const STACK_BUTTONS_FONT_SCALE = 1.35;
/** A full-width stacked button has room for about twice as much. */
const STACKED_LABEL_LENGTH = MAX_JOIN_LABEL_LENGTH * 2;

/** Code points: what `Array.from` counts. A combining accent counts on its own, so a name drops a little early. */
function labelLength(label: string): number {
  return Array.from(label).length;
}

export type SessionButtonsLayout = {
  /** Join and Start my own one above the other, full width. */
  stacked: boolean;
  /** The longest Join label that stays on one line in this layout. */
  maxLabelLength: number;
};

/**
 * Join and Start my own sit side by side at equal widths. They stack when the
 * text size is large, or when this locale's Start my own would not fit half a
 * card on one line (the Join label can drop its name instead; Start cannot).
 */
export function sessionButtonsLayout(fontScale: number, startOwnTitle: string): SessionButtonsLayout {
  const scale = Math.max(1, fontScale);
  const sideBySideLength = Math.floor(MAX_JOIN_LABEL_LENGTH / scale);
  const stacked = scale > STACK_BUTTONS_FONT_SCALE || labelLength(startOwnTitle) > sideBySideLength;
  return {
    stacked,
    maxLabelLength: stacked ? Math.floor(STACKED_LABEL_LENGTH / scale) : sideBySideLength,
  };
}

/**
 * The sessions the card can lead with: somebody is connected (a quiet session
 * is not live) and the viewer is not on it. A session this phone runs shows as
 * the running card; one the viewer runs on another device is not someone to join.
 * Sessions with a climber the viewer follows come first, each group in the
 * order the query keeps stable, so the lead does not swap on every poll.
 */
export function joinableLiveSessions(cards: readonly LiveCardModel[]): LiveCardModel[] {
  const joinable = cards.filter((card) => !card.viewerIsMember && !isQuietSession(card));
  return [
    ...joinable.filter((card) => card.followedParticipantIds.length > 0),
    ...joinable.filter((card) => card.followedParticipantIds.length === 0),
  ];
}

/**
 * The first name the Join button carries: a followed climber on the session,
 * then anyone else on it, then the host. Null when nobody has a name.
 */
export function joinButtonName(card: LiveCardModel, viewerUserId: string | null): string | null {
  const followed = new Set(card.followedParticipantIds);
  const roster = card.participants.filter((person) => person.userId !== viewerUserId);
  const candidates = [
    ...roster.filter((person) => followed.has(person.userId)),
    ...roster.filter((person) => !followed.has(person.userId)),
    ...(card.host && card.host.userId !== viewerUserId ? [card.host] : []),
  ];
  for (const person of candidates) {
    const firstName = person.displayName?.trim().split(/\s+/)[0];
    if (firstName) return firstName;
  }
  return null;
}

/**
 * The Join button's label: "Join Anna" when it fits on one line, else the
 * plain "Join". The name is what drops, never the verb.
 */
export function joinButtonTitle(
  name: string | null,
  withName: (name: string) => string,
  withoutName: string,
  maxLabelLength: number = MAX_JOIN_LABEL_LENGTH,
): string {
  if (!name) return withoutName;
  const named = withName(name);
  return labelLength(named) <= maxLabelLength ? named : withoutName;
}
