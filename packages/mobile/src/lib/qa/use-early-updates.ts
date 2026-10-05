import { useQuery } from '@tanstack/react-query';
import { useSetting } from '../../settings/hooks';
import { useEarlyUpdatesFlagState } from '../../providers/feature-flags-provider';
import { useOtaBranchSurfingState } from '../ota-branch-surfing-state';
import { listQaBranches } from './qa-surf';

/**
 * Shared with the preview picker on purpose: one `/branch_lists` answer serves
 * both, so opening the picker after More (or the other way round) inside the
 * stale window costs no second request.
 */
export const QA_BRANCHES_QUERY_KEY = ['qaPrBranches'] as const;
export const QA_BRANCHES_STALE_TIME_MS = 30_000;

/**
 * - `offered`: the server has an early update this binary can run.
 * - `waiting`: it answered, and has none. Usual right after a native release,
 *   until the first merge publishes for the new binary.
 * - `unknown`: no answer yet, or the update server could not be reached.
 */
export type EarlyUpdatesAvailability = 'offered' | 'waiting' | 'unknown';

export type EarlyUpdatesState = {
  /** Offer the switch: a build that can surf, with the feature turned on. */
  show: boolean;
  /** Opted in AND the feature is on. What every "is this phone on the track" check reads. */
  member: boolean;
  availability: EarlyUpdatesAvailability;
  /** When the branch last published for this binary. Null unless `offered`. */
  lastUpdateAt: string | null;
};

export function useEarlyUpdatesMember(): boolean {
  const [earlyUpdates] = useSetting('earlyUpdates');
  return useEarlyUpdatesFlagState() === 'on' && earlyUpdates;
}

/** What the More screen needs to draw the "Get updates early" row. */
export function useEarlyUpdates(): EarlyUpdatesState {
  const { surfingBuild } = useOtaBranchSurfingState();
  const show = useEarlyUpdatesFlagState() === 'on' && surfingBuild;
  const [earlyUpdates] = useSetting('earlyUpdates');
  const member = show && earlyUpdates;

  // Only a member needs the answer, so everyone else's More screen stays off
  // the network. A surfing-off answer flips the stored choice inside
  // `listQaBranches`, which disables this query on the next render.
  const branchesQuery = useQuery({
    queryKey: QA_BRANCHES_QUERY_KEY,
    queryFn: ({ signal }) => listQaBranches(signal),
    staleTime: QA_BRANCHES_STALE_TIME_MS,
    retry: 1,
    enabled: member,
  });

  const branchList = member && branchesQuery.isSuccess ? branchesQuery.data : null;
  const lastUpdateAt = branchList?.earlyUpdates?.lastUpdateAt ?? null;
  let availability: EarlyUpdatesAvailability = 'unknown';
  if (branchList !== null) availability = lastUpdateAt === null ? 'waiting' : 'offered';

  return { show, member, availability, lastUpdateAt };
}
