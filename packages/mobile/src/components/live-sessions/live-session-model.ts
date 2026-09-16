// Pure model + rules for the "Climbing now" rail (Home) and the "Climbing here
// now" block (board sheet). No React, no i18n, no theme: everything here is
// unit-tested in `__tests__/live-session-model.test.ts`, and the components only
// turn these decisions into views.

import type { LiveSession, LiveSessionReason } from '@boardsesh/shared-schema';

export type LiveCardPerson = {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
};

/**
 * One live session, reduced to what a card draws. `lastActivity` is dropped on
 * purpose: it moves on every poll, and a field that always changes would defeat
 * React Query's structural sharing and every `React.memo` row downstream.
 */
export type LiveCardModel = {
  sessionId: string;
  startedAtMs: number;
  host: LiveCardPerson | null;
  participants: LiveCardPerson[];
  participantCount: number;
  followedParticipantIds: string[];
  viewerIsMember: boolean;
  boardName: string | null;
  boardType: string | null;
  gymName: string | null;
  angle: number | null;
  sendCount: number;
  hardestSendGrade: string | null;
  currentClimbName: string | null;
  currentClimbGrade: string | null;
  reasons: LiveSessionReason[];
};

function toPerson(user: LiveSession['host']): LiveCardPerson | null {
  if (!user) return null;
  return { userId: user.userId, displayName: user.displayName, avatarUrl: user.avatarUrl };
}

export function toLiveCardModel(session: LiveSession): LiveCardModel {
  const startedAtMs = Date.parse(session.startedAt);
  return {
    sessionId: session.sessionId,
    startedAtMs: Number.isNaN(startedAtMs) ? 0 : startedAtMs,
    host: toPerson(session.host),
    participants: session.participants.map((participant) => ({
      userId: participant.userId,
      displayName: participant.displayName,
      avatarUrl: participant.avatarUrl,
    })),
    participantCount: session.participantCount,
    followedParticipantIds: session.followedParticipantIds,
    viewerIsMember: session.viewerIsMember,
    boardName: session.board?.name ?? null,
    boardType: session.board?.boardType ?? session.boardType,
    gymName: session.board?.gymName ?? null,
    angle: session.angle,
    sendCount: session.sendCount,
    hardestSendGrade: session.hardestSendGrade,
    currentClimbName: session.currentClimb?.name ?? null,
    currentClimbGrade: session.currentClimb?.grade ?? null,
    reasons: session.reasons,
  };
}

/**
 * Keeps cards where the climber last saw them. The backend sorts by roster size
 * and activity, so a straight render would shuffle cards under a thumb on every
 * poll. Known ids keep their previous position, new ids append in backend
 * order, and the viewer's own session always leads.
 */
export function orderLiveCards(previousOrder: readonly string[], cards: readonly LiveCardModel[]): LiveCardModel[] {
  const pending = new Map(cards.map((card) => [card.sessionId, card]));
  const ordered: LiveCardModel[] = [];
  for (const sessionId of previousOrder) {
    const card = pending.get(sessionId);
    if (!card) continue;
    ordered.push(card);
    pending.delete(sessionId);
  }
  for (const card of cards) {
    if (pending.has(card.sessionId)) ordered.push(card);
  }
  const own = ordered.filter((card) => card.viewerIsMember);
  if (own.length === 0) return ordered;
  return [...own, ...ordered.filter((card) => !card.viewerIsMember)];
}

/** "Priya Nair" → "Priya N."; a one-word name or handle stays as it is. */
export function shortPersonName(displayName: string | null | undefined): string | null {
  const trimmed = displayName?.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return parts[0] ?? null;
  const last = parts[parts.length - 1] ?? '';
  return `${parts[0]} ${last.charAt(0).toUpperCase()}.`;
}

export type LiveNamesDescriptor =
  /** Viewer's own session with nobody else on it. */
  | { kind: 'justYou' }
  /** Viewer's own session with exactly one other, named climber. */
  | { kind: 'youAnd'; name: string }
  /** Viewer's own session with `others` more climbers. */
  | { kind: 'you'; others: number }
  /** Somebody else's session: one name, plus `others` more (0 = none). */
  | { kind: 'one'; name: string | null; others: number }
  /** Somebody else's session with exactly two named climbers. */
  | { kind: 'two'; first: string; second: string };

/**
 * Who a card names. Followed climbers first, then the rest of the roster; the
 * host is only a fallback for a roster with no named climber on it (the host
 * may have left, and naming them would misreport who is there).
 */
export function describeLiveNames(card: LiveCardModel, viewerUserId: string | null): LiveNamesDescriptor {
  const followed = new Set(card.followedParticipantIds);
  const roster = card.participants.filter((person) => person.userId !== viewerUserId);
  const named = [
    ...roster.filter((person) => followed.has(person.userId)),
    ...roster.filter((person) => !followed.has(person.userId)),
  ]
    .map((person) => shortPersonName(person.displayName))
    .filter((name): name is string => name !== null);
  const total = Math.max(card.participantCount, card.participants.length);

  if (card.viewerIsMember) {
    const others = total - 1;
    if (others <= 0) return { kind: 'justYou' };
    const [onlyOther] = named;
    if (others === 1 && onlyOther) return { kind: 'youAnd', name: onlyOther };
    return { kind: 'you', others };
  }

  const [first, second] = named;
  if (!first) {
    return { kind: 'one', name: shortPersonName(card.host?.displayName), others: Math.max(0, total - 1) };
  }
  if (total === 2 && second) return { kind: 'two', first, second };
  return { kind: 'one', name: first, others: Math.max(0, total - 1) };
}

export type LiveCardAction = 'join' | 'open' | 'invite';

/**
 * Join lights the wall for everyone in the session, so it is only offered on a
 * board the viewer follows or has selected. Every other stranger's card says
 * Open (the preview names the gym). The viewer's own solo session gets Invite.
 */
export function liveCardAction(
  card: Pick<LiveCardModel, 'viewerIsMember' | 'participantCount' | 'reasons'>,
): LiveCardAction {
  if (card.viewerIsMember) return card.participantCount <= 1 ? 'invite' : 'open';
  const onViewersBoard = card.reasons.includes('FOLLOWED_BOARD') || card.reasons.includes('SELECTED_BOARD');
  return onViewersBoard ? 'join' : 'open';
}

/** Listed because of a followed board alone: nobody the viewer follows is on it. */
export function isListedForFollowedBoardOnly(card: Pick<LiveCardModel, 'reasons' | 'followedParticipantIds'>): boolean {
  return (
    card.reasons.includes('FOLLOWED_BOARD') &&
    !card.reasons.includes('FOLLOWING_USER') &&
    card.followedParticipantIds.length === 0
  );
}

export type ElapsedParts = { hours: number; minutes: number };

export function elapsedParts(startedAtMs: number, nowMs: number): ElapsedParts {
  const totalMinutes = Math.max(0, Math.floor((nowMs - startedAtMs) / 60_000));
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

export type RailEntry =
  | { kind: 'session'; key: string; card: LiveCardModel }
  | { kind: 'start'; key: 'start' }
  | { kind: 'find'; key: 'find' };

export type RailPlan = {
  entries: RailEntry[];
  /** The Start tile has been ignored for days: render the 56pt row instead. */
  compactStart: boolean;
  /** The full Start tile is in `entries` (drives the quiet-days impression). */
  showsStartTile: boolean;
};

export type RailPlanInput = {
  cards: readonly LiveCardModel[];
  /** The local queue holds a session (it may be private, so not in `cards`). */
  viewerInSession: boolean;
  /** True only once we KNOW the viewer follows nobody; unknown is false. */
  followsNobody: boolean;
  /** Quiet-days verdict from the impression store. */
  startCollapsed: boolean;
};

export function planLiveRail({ cards, viewerInSession, followsNobody, startCollapsed }: RailPlanInput): RailPlan {
  const inSession = viewerInSession || cards.some((card) => card.viewerIsMember);
  // A session already on the selected board: a second solo session on the same
  // wall is the outcome the rail exists to prevent.
  const liveOnSelectedBoard = cards.some((card) => !card.viewerIsMember && card.reasons.includes('SELECTED_BOARD'));
  const showStart = !inSession && !liveOnSelectedBoard;
  const compactStart = showStart && startCollapsed && cards.length === 0;
  const showFind = !inSession && (followsNobody || cards.length === 0) && !(compactStart && !followsNobody);
  const findLeads = showFind && followsNobody;

  const entries: RailEntry[] = [];
  if (findLeads) entries.push({ kind: 'find', key: 'find' });
  for (const card of cards) entries.push({ kind: 'session', key: card.sessionId, card });
  const showsStartTile = showStart && !compactStart;
  if (showsStartTile) entries.push({ kind: 'start', key: 'start' });
  if (showFind && !findLeads) entries.push({ kind: 'find', key: 'find' });

  return { entries, compactStart, showsStartTile };
}

/** Rail tile geometry. Width is fixed; height follows Dynamic Type. */
export const LIVE_TILE_WIDTH = 272;
export const LIVE_TILE_GAP = 12;
export const LIVE_TILE_BASE_HEIGHT = 192;

const TILE_PADDING = 12;
const AVATAR_ROW = 40;
const AVATAR_GAP = 6;
const ACTION_HEIGHT = 44;
const FOOTER_GAP = 8;
// names (headline 22) + board (subheadline 20) + gym (footnote 18) + climb (footnote 18)
const TEXT_BLOCK_AT_1X = 78;
const STATS_LINE_AT_1X = 18;
const MAX_TEXT_SCALE = 1.5;

export type LiveTileLayout = { height: number; stacked: boolean };

/**
 * 192pt at the default text size. Above 1.2× the action drops under the stats
 * so neither truncates, and every tile in the rail shares the height (a cell
 * that is not mounted cannot be measured, so "match the tallest" would jump).
 */
export function liveTileLayout(fontScale: number): LiveTileLayout {
  const scale = Math.min(Math.max(fontScale, 1), MAX_TEXT_SCALE);
  const stacked = fontScale > 1.2;
  const chrome = TILE_PADDING * 2 + AVATAR_ROW + AVATAR_GAP + ACTION_HEIGHT;
  const text = TEXT_BLOCK_AT_1X * scale + (stacked ? STATS_LINE_AT_1X * scale + FOOTER_GAP : 0);
  return { height: Math.max(LIVE_TILE_BASE_HEIGHT, Math.ceil(chrome + text)), stacked };
}
