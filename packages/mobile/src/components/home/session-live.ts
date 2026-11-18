// What Home's Session card shows when climbers are in a live session (#7689).
// Pure: no React, no i18n. The card leads with one session and offers Join and
// Start my own; the rest fold into one "+ N more climbing now" line.

import { isQuietSession, type LiveCardModel } from '../live-sessions/live-session-model';

/**
 * Past this many characters the Join label drops the name and reads a plain
 * "Join". Two equal-width buttons on a 375pt phone leave each label about
 * 128pt, which is 14 characters of a 16pt semibold label. The budget covers the
 * whole label, so a locale with a longer verb ("Rejoindre Anna") gets the same
 * room, and the verb is never the part that gets cut.
 */
export const MAX_JOIN_LABEL_LENGTH = 14;

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
 * The Join button's label: "Join Anna" when it fits on one line beside Start
 * my own, else the plain "Join". Lengths count code points, so an emoji or an
 * accented name is not counted twice.
 */
export function joinButtonTitle(name: string | null, withName: (name: string) => string, withoutName: string): string {
  if (!name) return withoutName;
  const named = withName(name);
  return Array.from(named).length <= MAX_JOIN_LABEL_LENGTH ? named : withoutName;
}
