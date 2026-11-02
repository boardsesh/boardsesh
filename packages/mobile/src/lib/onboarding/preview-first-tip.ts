// The one-shot "what changed and what the frost means" card in the player (2.7,
// design brief B5), and the queued screen-reader line that goes with it (B1).
//
// Since 2.7 a tap on a climb opens it as a preview and the board stays dark until
// the climber taps Put on board. That is new to everyone, upgrading or not, and
// so is the frosted "You are driving the wall" button. The card says both once,
// docked under the wall button, the first time a climber opens a preview on a
// board with lights.
//
// Seen state: one SecureStore flag (`ONBOARDING_TIP_PREVIEW_FIRST_KEY`) through
// `hasSeenTip` / `markTipSeen`. It is written the first time the card shows, the
// quick-actions tip's rule, so the card can never show on a later cold start.
// Within that same app run it comes back on up to `PREVIEW_FIRST_TIP_MAX_OPENS`
// player opens, because the climber may close the player before reading it,
// until they dismiss it, open Lighting settings or start a drive. The screen-
// reader line is spoken on the first of those opens only.
//
// This module holds the store and the pure rules; `use-preview-first-tip.ts`
// in the player wires them to the screen.

import { useSyncExternalStore } from 'react';
import { ONBOARDING_TIP_PREVIEW_FIRST_KEY } from '@boardsesh/key-value-storage';
import { driveLengthWords, resolveKeepLightingReach, type KeepLightingPlan } from '../keep-lighting';

/**
 * `hasSeenTip` / `markTipSeen`, loaded on first use rather than at import: the
 * player imports this module, and SecureStore stays out of its module graph (and
 * out of every suite that renders the player) until the flag is actually read.
 */
function onboardingStorage(): Promise<typeof import('./onboarding-storage')> {
  return import('./onboarding-storage');
}

function persistSeen(): void {
  void onboardingStorage()
    .then(({ markTipSeen }) => markTipSeen(ONBOARDING_TIP_PREVIEW_FIRST_KEY))
    .catch(() => undefined);
}

/** The card shows on at most this many player opens, all in the app run where it first showed. */
export const PREVIEW_FIRST_TIP_MAX_OPENS = 3;

/**
 * - `unknown` — the seen flag hasn't been read yet.
 * - `unseen` — never shown on this device.
 * - `showing` — first shown in this app run; it may come back on a later open.
 * - `retired` — seen in an earlier run, dismissed, or out of opens.
 */
export type PreviewFirstTipStatus = 'unknown' | 'unseen' | 'showing' | 'retired';

export type PreviewFirstTipState = {
  status: PreviewFirstTipStatus;
  /** Player opens that showed the card in this app run. */
  opens: number;
  /** The card made its first-ever show and its screen-reader line hasn't been spoken yet. */
  announcePending: boolean;
};

const INITIAL_STATE: PreviewFirstTipState = { status: 'unknown', opens: 0, announcePending: false };

let state: PreviewFirstTipState = INITIAL_STATE;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: PreviewFirstTipState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPreviewFirstTipState(): PreviewFirstTipState {
  return state;
}

/** The card's state, for the player. */
export function usePreviewFirstTipState(): PreviewFirstTipState {
  return useSyncExternalStore(subscribe, getPreviewFirstTipState, getPreviewFirstTipState);
}

/**
 * Read the seen flag once per app run. Safe to call on every player mount: a
 * read in flight is shared, and a known status is never read again. A read error
 * reports "seen" (`hasSeenTip`), so a flaky store never nags, and screenshot mode
 * reports seen too.
 */
export function loadPreviewFirstTip(): Promise<void> {
  if (state.status !== 'unknown') return Promise.resolve();
  if (loading) return loading;
  loading = onboardingStorage()
    .then(({ hasSeenTip }) => hasSeenTip(ONBOARDING_TIP_PREVIEW_FIRST_KEY))
    // Can't read it at all: treat it as seen, like a read error.
    .catch(() => true)
    .then((seen) => {
      loading = null;
      // A claim or a retire can't land before the read, but a reset in tests can.
      if (state.status !== 'unknown') return;
      setState({ ...state, status: seen ? 'retired' : 'unseen' });
    });
  return loading;
}

/**
 * A player open is about to show the card: count it. True when it may show.
 * The first-ever show writes the seen flag and queues the screen-reader line.
 */
export function claimPreviewFirstTipOpen(): boolean {
  if (state.status === 'unseen') {
    persistSeen();
    setState({ status: 'showing', opens: 1, announcePending: true });
    return true;
  }
  if (state.status === 'showing' && state.opens < PREVIEW_FIRST_TIP_MAX_OPENS) {
    setState({ ...state, opens: state.opens + 1 });
    return true;
  }
  return false;
}

/** Got it, close, Lighting settings, or a drive started: the card never shows again. */
export function retirePreviewFirstTip(): void {
  if (state.status === 'retired') return;
  persistSeen();
  // A line not yet spoken goes with the card: the climber already moved on.
  setState({ ...state, status: 'retired', announcePending: false });
}

/** The screen-reader line was spoken, or another sentence already covered the moment. */
export function consumePreviewFirstAnnouncement(): void {
  if (!state.announcePending) return;
  setState({ ...state, announcePending: false });
}

/**
 * Replay walkthrough (Settings › General): the card may show again, on the next
 * preview. It is the one in-app place that explains previews and the frost, and
 * the What's New spotlight retires after 30 days, so replaying the tour brings
 * it back too. Clears the seen flag, then reads it again on the next player open.
 */
export async function forgetPreviewFirstTip(): Promise<void> {
  const { clearTipSeen } = await onboardingStorage();
  await clearTipSeen(ONBOARDING_TIP_PREVIEW_FIRST_KEY);
  loading = null;
  setState(INITIAL_STATE);
}

/** Test-only: the store outlives an individual test. */
export function _resetPreviewFirstTipForTests(): void {
  state = INITIAL_STATE;
  loading = null;
  listeners.clear();
}

export type PreviewFirstTipGateInput = {
  state: PreviewFirstTipState;
  /** This player open already showed the card: it stays while nothing else needs the slot. */
  claimedThisOpen: boolean;
  /** A signed-in climber, not the web export's anonymous reader. */
  signedIn: boolean;
  /**
   * The board on screen has lights this phone can put a climb on: not a spray
   * wall, not a board with no lights, not Set active (no wall in reach).
   */
  boardHasLights: boolean;
  /** The climb on screen is a preview: the moment the card explains. */
  previewShowing: boolean;
  /** The Climbs list's first-connect card is on screen: it goes first. */
  connectCardVisible: boolean;
  /**
   * The one-time "Connected to {{board}}" confirmation is about to show or is
   * up. It says what Put on board keeps lighting too, and it comes once per
   * phone, so it goes first; the card can come back once it closes.
   */
  connectConfirmationShowing: boolean;
  /** The Climbs list's board-reveal tip or quick-actions tip is on screen (a tablet's pane beside the list). */
  listTipShowing: boolean;
  /**
   * Something else owns the moment in the player: the busy-wall question, a card
   * over the board (end of list, switch board) or Fell / Sent.
   */
  playerBusy: boolean;
  /**
   * The card's slot is on the first screen: the Logbook peek's place under the
   * board. False when every section is hidden or the board is fitted to the
   * screen's height, where the card would sit unseen below the fold and still
   * spend its seen flag and its screen-reader line.
   */
  slotInView: boolean;
  screenshotMode: boolean;
};

/**
 * Whether the card is on screen. One card at a time, like `shouldShowQuickActionsTip`:
 * it waits for the first-connect card and its confirmation, the Climbs list's
 * tips and anything in the player that is asking the climber something.
 */
export function shouldShowPreviewFirstTip(input: PreviewFirstTipGateInput): boolean {
  if (input.screenshotMode || !input.signedIn || !input.boardHasLights) return false;
  if (input.connectCardVisible || input.connectConfirmationShowing) return false;
  if (input.listTipShowing || input.playerBusy || !input.slotInView) return false;
  const { status, opens } = input.state;
  if (input.claimedThisOpen) return status === 'showing';
  if (!input.previewShowing) return false;
  return status === 'unseen' || (status === 'showing' && opens < PREVIEW_FIRST_TIP_MAX_OPENS);
}

/**
 * Whether the card's screen-reader line belongs to this moment: the card is
 * making its first-ever show (`unseen`, about to be claimed), or made it and the
 * line is still waiting. Read in render, so the browse notice in the same commit
 * can stand down for it.
 */
export function previewFirstAnnouncementDue(state: PreviewFirstTipState, visible: boolean): boolean {
  if (!visible) return false;
  return state.status === 'unseen' || state.announcePending;
}

/** A drive, as the card's retire rule reads it. */
export type PreviewFirstTipDrive = {
  /** `Date.now()` when it started. */
  startedAt: number;
  /**
   * It lights every pick until the climber stops it: a swipe, Light every
   * climb, the board sheet's row, or Put on board set to keep lighting until
   * stopped. Not Put on board's timed window.
   */
  openEnded: boolean;
};

/**
 * Whether the drive on this board retires the card: the climber started driving
 * the wall after the card showed, so the frost has been learned. Put on board's
 * timed window is what the card describes, so the card stays through it until
 * the window turns open-ended (a swipe or Light every climb during it).
 *
 * `previous` is the drive as the card last saw it, so a window that was already
 * running when the card showed still retires it once it turns open-ended.
 */
export function previewFirstTipRetiredByDrive({
  drive,
  previous,
  shownAt,
}: {
  drive: PreviewFirstTipDrive | null;
  previous: PreviewFirstTipDrive | null;
  shownAt: number;
}): boolean {
  if (drive === null || !drive.openEnded) return false;
  if (drive.startedAt >= shownAt) return true;
  return previous !== null && previous.startedAt === drive.startedAt && !previous.openEnded;
}

/** The card's second line: what Put on board's drive does, for the board on screen. */
export type PreviewFirstWindowLine =
  | { key: 'windowSeconds'; seconds: number }
  | { key: 'windowMinute' }
  | { key: 'windowMinutes'; minutes: number }
  | { key: 'untilStop' }
  | null;

/**
 * Read by the same rule as the first-connect confirmation
 * (`resolveKeepLightingReach`): where Always drive the wall drives, every pick
 * lights until the climber stops, on any board, whatever Stop driving after
 * says. A timed drive says how long it lasts after each climb, in whole
 * minutes from one minute up. A MoonBoard reads the same, Stop driving after
 * being one choice for every board.
 */
export function resolvePreviewFirstWindowLine({
  plan,
  alwaysDrive = false,
}: {
  /**
   * What Put on board's drive does here (`resolveKeepLightingPlan`), or null
   * when it lights one climb: the choice is Right away, or the press can't
   * start a drive here (a session with In a session too off, the swipe flag off).
   */
  plan: KeepLightingPlan | null;
  /** Always drive the wall drives here (`alwaysDriveApplies`). */
  alwaysDrive?: boolean;
}): PreviewFirstWindowLine {
  const reach = resolveKeepLightingReach({ plan, alwaysDrive });
  switch (reach.kind) {
    // One climb lights and nothing after it: the headline already says so.
    case 'one_climb':
      return null;
    case 'until_stop':
      return { key: 'untilStop' };
    case 'window': {
      const length = driveLengthWords(reach.seconds);
      if (length.unit === 'seconds') return { key: 'windowSeconds', seconds: length.count };
      return length.count === 1 ? { key: 'windowMinute' } : { key: 'windowMinutes', minutes: length.count };
    }
  }
}

/**
 * Which sentence the card says about the frost, read by the same rule as its
 * second line (`resolveKeepLightingReach`): the one about Put on board's drive
 * stopping after the chosen time, and the frost shrinking as it runs out, only
 * where that drive has a clock (`window`). Until I stop and Right away (or no
 * drive here at all) say the frost means
 * driving until you stop, with nothing about a clock.
 */
export type PreviewFirstFrostLine = 'timed' | 'open_ended';

export function resolvePreviewFirstFrostLine({
  plan,
  alwaysDrive = false,
}: {
  /** As `resolvePreviewFirstWindowLine`'s. */
  plan: KeepLightingPlan | null;
  alwaysDrive?: boolean;
}): PreviewFirstFrostLine {
  return resolveKeepLightingReach({ plan, alwaysDrive }).kind === 'window' ? 'timed' : 'open_ended';
}
