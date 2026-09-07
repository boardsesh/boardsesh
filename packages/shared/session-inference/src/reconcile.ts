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

/** Partition broad read windows, including legacy same-day assignments that may need splitting. */
export function isReconciliationBoundary(previousAt: number, nextAt: number): boolean {
  return nextAt - previousAt > SESSION_GAP_MS && dayStart(previousAt) !== dayStart(nextAt);
}

/**
 * Load whole UTC days and connected runs so legacy same-day assignments include their anchors.
 * This padding controls reads only: automatic grouping always stops at gaps over eight hours.
 */
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

  const explicitIds = new Set(explicitSessions.map((session) => session.id));
  const resolved: ResolvedRun[] = [];
  const merges: SessionMerge[] = [];

  for (const run of runs) {
    const tickIds = run.map((tick) => tick.id);
    const anchorTickId = Math.min(...tickIds);
    const firstTickAt = run[0].climbedAt;
    const lastTickAt = run[run.length - 1].climbedAt;

    const explicitTicks = run.filter((tick) => tick.sessionId !== null && explicitIds.has(tick.sessionId));
    if (explicitTicks.length > 0) {
      // Preserve assigned explicit ticks. Loose ticks choose the nearest explicit
      // tick inside this connected run, never a session on an unrelated UTC day.
      const ticksBySession = new Map<string, InferenceTick[]>();
      let nextExplicitIndex = 0;
      for (const tick of run) {
        while (
          nextExplicitIndex < explicitTicks.length &&
          explicitTicks[nextExplicitIndex].climbedAt < tick.climbedAt
        ) {
          nextExplicitIndex++;
        }
        const previous = explicitTicks[nextExplicitIndex - 1];
        const next = explicitTicks[nextExplicitIndex];
        const nearest = !previous
          ? next
          : !next || tick.climbedAt - previous.climbedAt <= next.climbedAt - tick.climbedAt
            ? previous
            : next;
        const sessionId =
          tick.sessionId !== null && explicitIds.has(tick.sessionId) ? tick.sessionId : nearest.sessionId!;
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
  const { resolved, merges } = resolveIdentity(drawRuns(ordered), existingInferred, existingExplicit);

  // Anything that kept no run of its own has been emptied — either absorbed by an
  // explicit session or merged away.
  const survivingIds = new Set(resolved.map((run) => run.sessionId).filter((id): id is string => id !== null));
  const mergedAway = new Set(merges.map((merge) => merge.loserId));
  const emptiedSessionIds = existingInferred
    .filter((session) => !survivingIds.has(session.id) && !mergedAway.has(session.id))
    .map((session) => session.id);

  return { runs: resolved, merges, emptiedSessionIds };
}
