import {
  SESSION_GAP_MS,
  type ExistingExplicitSession,
  type ExistingInferredSession,
  type InferenceTick,
  type ReconcileInput,
  type ReconcileResult,
  type ResolvedRun,
  type SessionMerge,
} from './types';

/** Start of the UTC day a timestamp falls in. */
function dayStart(epochMs: number): number {
  const date = new Date(epochMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Separate windows only where neither the gap nor same-UTC-day rules can cross. */
export function isReconciliationBoundary(previousAt: number, nextAt: number): boolean {
  return nextAt - previousAt > SESSION_GAP_MS && dayStart(previousAt) !== dayStart(nextAt);
}

/** Include whole UTC days and every run connected to them, including across midnight. */
export function expandReconciliationWindow(allTicks: InferenceTick[], from: number, to: number): InferenceTick[] {
  let windowFrom = dayStart(from);
  let windowTo = dayStart(to) + 24 * 60 * 60 * 1000 - 1;
  // Each expansion reaches another tick's UTC day; allow one final stable pass.
  // Bound by the input size, so long histories do not hit an arbitrary day limit.
  for (let expansion = 0; expansion <= allTicks.length; expansion++) {
    const ticks = expandWindow(allTicks, windowFrom, windowTo);
    if (ticks.length === 0) return ticks;
    const nextFrom = Math.min(windowFrom, dayStart(ticks[0].climbedAt));
    const nextTo = Math.max(windowTo, dayStart(ticks[ticks.length - 1].climbedAt) + 24 * 60 * 60 * 1000 - 1);
    if (nextFrom === windowFrom && nextTo === windowTo) return ticks;
    windowFrom = nextFrom;
    windowTo = nextTo;
  }
  throw new Error('Reconciliation window did not converge within its tick count');
}

/**
 * Widen `[from, to]` outwards until there is a gap greater than {@link SESSION_GAP_MS}
 * on both sides, and return the ticks inside.
 *
 * This is the blast radius of a single reconciliation, and getting it right is the
 * whole reason back-dated writes are safe here. A window that stops mid-run would
 * split that run in half; expanding to the nearest real gaps guarantees every run it
 * touches is covered end to end, so reconciling a window is a decision about complete
 * runs and never a partial one.
 *
 * v1 had no window at all — `assignInferredSession` compared the incoming tick against
 * only the user's single most recent tick. A back-dated tick more than 4h from that
 * one minted a fresh session even when it sat squarely inside an existing session's
 * span, which is how 96%-back-dated kilter_pull batches shredded session history.
 *
 * `allTicks` must be ascending by `climbedAt` and cover enough either side of the
 * window for the expansion to terminate on real gaps.
 */
export function expandWindow(allTicks: InferenceTick[], from: number, to: number): InferenceTick[] {
  if (allTicks.length === 0) return [];

  let startIndex = allTicks.findIndex((tick) => tick.climbedAt >= from);
  if (startIndex === -1) startIndex = allTicks.length - 1;

  let endIndex = startIndex;
  for (let i = allTicks.length - 1; i >= 0; i--) {
    if (allTicks[i].climbedAt <= to) {
      endIndex = Math.max(i, startIndex);
      break;
    }
  }

  // Walk backwards while the step to the previous tick is within one session.
  while (startIndex > 0 && allTicks[startIndex].climbedAt - allTicks[startIndex - 1].climbedAt <= SESSION_GAP_MS) {
    startIndex--;
  }
  // And forwards likewise.
  while (
    endIndex < allTicks.length - 1 &&
    allTicks[endIndex + 1].climbedAt - allTicks[endIndex].climbedAt <= SESSION_GAP_MS
  ) {
    endIndex++;
  }

  return allTicks.slice(startIndex, endIndex + 1);
}

/** Split ticks into runs wherever the gap to the next tick exceeds the threshold. */
function drawRuns(ticks: InferenceTick[]): InferenceTick[][] {
  if (ticks.length === 0) return [];
  const runs: InferenceTick[][] = [];
  let current: InferenceTick[] = [ticks[0]];

  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i].climbedAt - ticks[i - 1].climbedAt > SESSION_GAP_MS) {
      runs.push(current);
      current = [ticks[i]];
    } else {
      current.push(ticks[i]);
    }
  }
  runs.push(current);
  return runs;
}

/**
 * The explicit session that owns a run, if any.
 *
 * Explicit sessions always win: someone deliberately pressed Start, so their record is
 * authoritative and a run overlapping their day is folded into them rather than
 * standing beside them. This is what stops the "I logged 9 climbs in my session and 2
 * before it, and the 2 vanished" case — those 2 join the session instead of forming a
 * card that the old day-suppression rule then hid entirely.
 *
 * Matching is by calendar day rather than by the session's tick span, because the
 * ticks being absorbed are by definition outside that span. When a day holds more than
 * one explicit session the nearest in time wins, so a morning run does not land in an
 * evening session.
 */
function explicitSessionForRun(run: InferenceTick[], explicitSessions: ExistingExplicitSession[]): string | null {
  // Only an id that belongs to an EXPLICIT session settles this. Ticks normally carry
  // the inferred session they were last assigned to, so accepting any non-null id here
  // would short-circuit anchor and merge resolution on nearly every reconciliation —
  // and, where an inferred run sits next to a party session on the same day, would hand
  // the party session's own ticks to the inferred one.
  const explicitIds = new Set(explicitSessions.map((session) => session.id));
  const assignedExplicit = run.find((tick) => tick.sessionId !== null && explicitIds.has(tick.sessionId));
  if (assignedExplicit) return assignedExplicit.sessionId;

  const runStart = run[0].climbedAt;
  const runEnd = run[run.length - 1].climbedAt;
  const runDays = new Set([dayStart(runStart), dayStart(runEnd)]);

  const sameDay = explicitSessions.filter(
    (session) => runDays.has(dayStart(session.firstTickAt)) || runDays.has(dayStart(session.lastTickAt)),
  );
  if (sameDay.length === 0) return null;

  let best = sameDay[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const session of sameDay) {
    // Zero when the run overlaps the session's span, otherwise the nearer edge gap.
    const distance =
      runEnd < session.firstTickAt
        ? session.firstTickAt - runEnd
        : runStart > session.lastTickAt
          ? runStart - session.lastTickAt
          : 0;
    if (distance < bestDistance) {
      best = session;
      bestDistance = distance;
    }
  }
  return best.id;
}

/**
 * Fold lone ticks into a bigger run on the same day.
 *
 * A single-tick run is usually someone remembering hours later that they forgot to log
 * a climb, not a second trip to the wall — so when the day already has real climbing on
 * it, the stray tick belongs there. When the lone tick is all there is for that day it
 * stays its own session; hiding it would recreate the "where did my climb go" bug that
 * started all this.
 *
 * Fleet-wide this merges 605 runs and leaves 8,694 standing alone, of which only 1,874
 * are natively logged — the rest are bulk logbook imports sitting far back in history.
 */
function absorbLoneRuns(runs: InferenceTick[][]): InferenceTick[][] {
  if (runs.length < 2) return runs;

  const result: InferenceTick[][] = runs.map((run) => [...run]);
  const isLone = (run: InferenceTick[]) => run.length === 1;

  for (let i = 0; i < result.length; i++) {
    if (!isLone(result[i])) continue;
    const day = dayStart(result[i][0].climbedAt);

    // Nearest larger run on the same day, in either direction.
    let target = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let j = 0; j < result.length; j++) {
      if (j === i || result[j].length === 0 || isLone(result[j])) continue;
      const otherStart = result[j][0].climbedAt;
      const otherEnd = result[j][result[j].length - 1].climbedAt;
      if (dayStart(otherStart) !== day && dayStart(otherEnd) !== day) continue;
      const tickAt = result[i][0].climbedAt;
      const distance = tickAt < otherStart ? otherStart - tickAt : tickAt > otherEnd ? tickAt - otherEnd : 0;
      if (distance < bestDistance) {
        target = j;
        bestDistance = distance;
      }
    }

    if (target !== -1) {
      result[target] = [...result[target], ...result[i]].sort((a, b) => a.climbedAt - b.climbedAt);
      result[i] = [];
    }
  }

  return result.filter((run) => run.length > 0);
}

/**
 * Decide which inferred sessions in the window each run inherits.
 *
 * A run inherits the identity of any existing session whose anchor tick it still
 * contains, so renaming a session and then importing a back-dated climb into it keeps
 * the name, the notes and every vote and comment. When a run swallows two anchors —
 * a back-dated tick bridging what used to be two sessions — one has to absorb the
 * other; a session someone has edited outranks one they have not, and otherwise the
 * earlier anchor wins so the outcome does not depend on row order.
 */
function resolveIdentity(
  runs: InferenceTick[][],
  existingInferred: ExistingInferredSession[],
  explicitSessions: ExistingExplicitSession[],
): { resolved: ResolvedRun[]; merges: SessionMerge[] } {
  const byAnchor = new Map<number, ExistingInferredSession>();
  for (const session of existingInferred) {
    if (session.anchorTickId !== null) byAnchor.set(session.anchorTickId, session);
  }

  const resolved: ResolvedRun[] = [];
  const merges: SessionMerge[] = [];

  for (const run of runs) {
    const tickIds = run.map((tick) => tick.id);
    const anchorTickId = Math.min(...tickIds);
    const firstTickAt = run[0].climbedAt;
    const lastTickAt = run[run.length - 1].climbedAt;

    const explicitId = explicitSessionForRun(run, explicitSessions);
    if (explicitId !== null) {
      // A timing run can span several sessions somebody explicitly started. Keep
      // each assigned tick authoritative instead of handing the whole run to its
      // first explicit session. Loose ticks choose the nearest same-day session;
      // a midnight-crossing run can fall back to the session owning the run.
      const explicitIds = new Set(explicitSessions.map((session) => session.id));
      const assignedExplicitIds = new Set(
        run
          .map((tick) => tick.sessionId)
          .filter((sessionId): sessionId is string => sessionId !== null && explicitIds.has(sessionId)),
      );
      if (assignedExplicitIds.size > 1) {
        const ticksBySession = new Map<string, InferenceTick[]>();
        for (const tick of run) {
          const sessionId = explicitSessionForRun([tick], explicitSessions) ?? explicitId;
          const assignedTicks = ticksBySession.get(sessionId) ?? [];
          assignedTicks.push(tick);
          ticksBySession.set(sessionId, assignedTicks);
        }
        for (const [sessionId, assignedTicks] of ticksBySession) {
          resolved.push({
            sessionId,
            tickIds: assignedTicks.map((tick) => tick.id),
            anchorTickId: Math.min(...assignedTicks.map((tick) => tick.id)),
            firstTickAt: assignedTicks[0].climbedAt,
            lastTickAt: assignedTicks[assignedTicks.length - 1].climbedAt,
          });
        }
        continue;
      }
      // Any inferred sessions anchored in here lose their ticks to the explicit
      // session; the caller drops them via `emptiedSessionIds`.
      resolved.push({ sessionId: explicitId, tickIds, anchorTickId, firstTickAt, lastTickAt });
      continue;
    }

    const claimants = tickIds
      .map((id) => byAnchor.get(id))
      .filter((session): session is ExistingInferredSession => session !== undefined);

    if (claimants.length === 0) {
      resolved.push({ sessionId: null, tickIds, anchorTickId, firstTickAt, lastTickAt });
      continue;
    }

    const survivor = claimants.reduce((best, candidate) => {
      if (best.userEdited !== candidate.userEdited) return best.userEdited ? best : candidate;
      return (best.anchorTickId ?? 0) <= (candidate.anchorTickId ?? 0) ? best : candidate;
    });
    for (const claimant of claimants) {
      if (claimant.id !== survivor.id) merges.push({ survivorId: survivor.id, loserId: claimant.id });
    }

    resolved.push({ sessionId: survivor.id, tickIds, anchorTickId, firstTickAt, lastTickAt });
  }

  return { resolved, merges };
}

/**
 * Work out which session every tick in a window belongs to.
 *
 * Pure: it reads the window the caller loaded and returns the writes to apply. Running
 * it twice over the same window produces the same answer, so every tick writer — save,
 * edit, delete, importer, offline drain — can call it freely.
 *
 * That idempotency is **sequential**, not a concurrency guarantee. Two writers
 * reconciling the same previously-unassigned run both see `sessionId: null` and both
 * decide to create a session. The unique partial index on
 * `board_sessions.anchor_tick_id` is what settles the race: the second insert fails, and
 * the caller retries the window, this time finding the anchor and inheriting the row.
 *
 * The caller must, in one transaction: apply `merges` (re-point social rows from loser
 * to survivor, then delete the loser), delete `emptiedSessionIds`, create a session for
 * every run with a null `sessionId`, and write `session_id` onto each run's ticks.
 */
export function reconcileWindow({ ticks, existingInferred, existingExplicit }: ReconcileInput): ReconcileResult {
  if (ticks.length === 0) {
    return { runs: [], merges: [], emptiedSessionIds: existingInferred.map((session) => session.id) };
  }

  const ordered = [...ticks].sort((a, b) => a.climbedAt - b.climbedAt || a.id - b.id);
  let runs = absorbLoneRuns(drawRuns(ordered));
  let explicitSpans = existingExplicit;
  let { resolved, merges } = resolveIdentity(runs, existingInferred, explicitSpans);

  // Absorbing a midnight-crossing run can extend an explicit session onto another
  // day. Settle that day's loose runs in this plan too, rather than minting inferred
  // sessions that the next reconciliation would immediately empty. Each iteration
  // must reach a new UTC day from this finite window; assignments already made to
  // explicit sessions stay fixed, just as they would after a committed pass.
  for (let expansion = 0; expansion <= ordered.length; expansion++) {
    const expandedById = new Map(explicitSpans.map((session) => [session.id, { ...session }]));
    for (const run of resolved) {
      const session = run.sessionId === null ? undefined : expandedById.get(run.sessionId);
      if (!session) continue;
      session.firstTickAt = Math.min(session.firstTickAt, run.firstTickAt);
      session.lastTickAt = Math.max(session.lastTickAt, run.lastTickAt);
    }
    const expanded = explicitSpans.some((session) => {
      const next = expandedById.get(session.id)!;
      return (
        dayStart(next.firstTickAt) !== dayStart(session.firstTickAt) ||
        dayStart(next.lastTickAt) !== dayStart(session.lastTickAt)
      );
    });
    if (!expanded) break;
    // Expanding a span must claim at least one previously unclaimed tick. Once
    // assigned, that tick's explicit ownership is fixed in subsequent passes.
    if (expansion === ordered.length)
      throw new Error('Explicit session spans did not converge within their tick count');

    const explicitAssignments = new Map<number, string>();
    for (const run of resolved) {
      if (run.sessionId === null || !expandedById.has(run.sessionId)) continue;
      for (const tickId of run.tickIds) explicitAssignments.set(tickId, run.sessionId);
    }
    runs = runs.map((run) =>
      run.map((tick) => ({ ...tick, sessionId: explicitAssignments.get(tick.id) ?? tick.sessionId })),
    );
    explicitSpans = [...expandedById.values()];
    ({ resolved, merges } = resolveIdentity(runs, existingInferred, explicitSpans));
  }

  // Anything that kept no run of its own has been emptied — either absorbed by an
  // explicit session or merged away.
  const survivingIds = new Set(resolved.map((run) => run.sessionId).filter((id): id is string => id !== null));
  const mergedAway = new Set(merges.map((merge) => merge.loserId));
  const emptiedSessionIds = existingInferred
    .filter((session) => !survivingIds.has(session.id) && !mergedAway.has(session.id))
    .map((session) => session.id);

  return { runs: resolved, merges, emptiedSessionIds };
}
