import type { AuroraLiveDisplay } from '@boardsesh/aurora-sync/api';

export type AuroraCatchupCheckpoint = {
  binding: string;
  completeThrough: string | null;
  pending: { before: string; targetNewest: string; lowerBound: string } | null;
};
export function parseAuroraCheckpoint(encoded: string | null, binding: string): AuroraCatchupCheckpoint {
  const empty: AuroraCatchupCheckpoint = { binding, completeThrough: null, pending: null };
  try {
    const parsed: unknown = encoded ? JSON.parse(encoded) : null;
    if (!parsed || typeof parsed !== 'object') return empty;
    const checkpoint = parsed as Record<string, unknown>;
    const timestamp = (input: unknown): input is string =>
      typeof input === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(input) &&
      Number.isFinite(Date.parse(input));
    if (
      checkpoint.binding !== binding ||
      (checkpoint.completeThrough !== null && !timestamp(checkpoint.completeThrough))
    )
      return empty;
    if (checkpoint.pending !== null) {
      if (!checkpoint.pending || typeof checkpoint.pending !== 'object') return empty;
      const pending = checkpoint.pending as Record<string, unknown>;
      if (typeof pending.before !== 'string' || !timestamp(pending.targetNewest) || !timestamp(pending.lowerBound))
        return empty;
    }
    return checkpoint as AuroraCatchupCheckpoint;
  } catch {
    return empty;
  }
}

/** Always read the newest page, then resume at most two older pages per run. */
export async function catchUpAuroraHistory(options: {
  checkpoint: AuroraCatchupCheckpoint;
  fetchPage: (before?: string) => Promise<AuroraLiveDisplay[]>;
  importPage: (displays: AuroraLiveDisplay[]) => Promise<void>;
  isCurrent: () => Promise<boolean>;
  onGap: () => void;
}): Promise<AuroraCatchupCheckpoint | null> {
  const { checkpoint } = options;
  let state: AuroraCatchupCheckpoint = { ...checkpoint, pending: checkpoint.pending && { ...checkpoint.pending } };
  const newestPage = await options.fetchPage();
  if (!(await options.isCurrent())) return null;
  await options.importPage(newestPage);
  if (!(await options.isCurrent())) return null;
  const newestFirst = [...newestPage].sort((left, right) => right.displayedAt.localeCompare(left.displayedAt));
  const newest = newestFirst[0];
  const oldest = newestFirst.at(-1);
  if (!newest || !oldest) return state;
  // Bootstrap is deliberately the sampled latest page, not a claim to full upstream retention.
  if (!state.completeThrough) return { ...state, completeThrough: newest.displayedAt, pending: null };
  if (!state.pending && newest.displayedAt > state.completeThrough) {
    if (oldest.displayedAt <= state.completeThrough) return { ...state, completeThrough: newest.displayedAt };
    state.pending = {
      before: oldest.rawTimestamp,
      targetNewest: newest.displayedAt,
      lowerBound: state.completeThrough,
    };
  }
  for (let pages = 0; state.pending && pages < 2; pages++) {
    if (!(await options.isCurrent())) return null;
    const page = await options.fetchPage(state.pending.before);
    if (!(await options.isCurrent())) return null;
    await options.importPage(page);
    if (!(await options.isCurrent())) return null;
    const ordered = [...page].sort((left, right) => right.displayedAt.localeCompare(left.displayedAt));
    const last = ordered.at(-1);
    if (!last || last.displayedAt <= state.pending.lowerBound) {
      if (!last) options.onGap();
      state = { ...state, completeThrough: state.pending.targetNewest, pending: null };
      break;
    }
    if (last.rawTimestamp === state.pending.before) {
      // No tie-breaker exists: don't spin or mark the missing interval complete.
      options.onGap();
      return state;
    }
    state.pending = { ...state.pending, before: last.rawTimestamp };
  }
  if (state.pending) options.onGap();
  return state;
}
