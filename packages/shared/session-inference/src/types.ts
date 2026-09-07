/** Automatic grouping stops at gaps over eight hours; exactly eight hours stays connected. */
export const SESSION_GAP_MS = 8 * 60 * 60 * 1000;

/** The subset of a tick this module needs. Keeps the algorithm free of DB types. */
export type InferenceTick = {
  /** `boardsesh_ticks.id` — bigserial, insertion-ordered, never reassigned. */
  id: number;
  /** Epoch ms of `climbed_at`. */
  climbedAt: number;
  /** `session_id`, or null when the tick belongs to no session yet. */
  sessionId: string | null;
};

/** An existing inferred session that overlaps the window being reconciled. */
export type ExistingInferredSession = {
  id: string;
  /** The `boardsesh_ticks.id` this session's identity is pinned to. */
  anchorTickId: number | null;
  /** True once someone named or annotated it; decides who survives a merge. */
  userEdited: boolean;
};

/** An explicit (someone-pressed-Start) session overlapping the window. */
export type ExistingExplicitSession = {
  id: string;
};

/**
 * A run of ticks with no internal gap greater than {@link SESSION_GAP_MS},
 * resolved to the session it should belong to.
 */
export type ResolvedRun = {
  /**
   * The session id these ticks belong to, or null when a new inferred session
   * must be created for them (the caller mints the id).
   */
  sessionId: string | null;
  /** Ids of the ticks in this run, ascending by `climbedAt`. */
  tickIds: number[];
  /** Lowest `boardsesh_ticks.id` in the run — the anchor for a new session. */
  anchorTickId: number;
  firstTickAt: number;
  lastTickAt: number;
};

/**
 * Two inferred sessions that a single run now spans, so one has to absorb the other.
 * The caller re-points votes/comments from `loserId` to `survivorId` before deleting
 * the loser's row — never the other way round, and never a bare delete. v1 deleted
 * emptied sessions outright, which orphaned their social rows and left migration
 * 0120 to sweep up the debris.
 */
export type SessionMerge = {
  survivorId: string;
  loserId: string;
};

export type ReconcileInput = {
  /** Every tick for this climber inside the expanded window, ascending by climbedAt. */
  ticks: InferenceTick[];
  /** Inferred sessions already covering part of the window. */
  existingInferred: ExistingInferredSession[];
  /** Explicit sessions overlapping the window; these always win. */
  existingExplicit: ExistingExplicitSession[];
};

export type ReconcileResult = {
  /** Every run in the window, with its resolved destination session. */
  runs: ResolvedRun[];
  /** Merges the caller must apply before writing `runs`. */
  merges: SessionMerge[];
  /**
   * Inferred sessions in the window that ended up with no ticks — every one of their
   * ticks was absorbed by an explicit session. Delete after re-pointing their social
   * rows onto the absorbing session.
   */
  emptiedSessionIds: string[];
};
