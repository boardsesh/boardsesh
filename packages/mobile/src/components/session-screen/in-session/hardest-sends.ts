import { gradeSortValue } from '../../you/grade-sort-value';

/** One climber's hardest send. `userId` set only for multi-climber parties (so
 *  the solo case renders without an avatar). */
export type HardestSend = {
  userId?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  difficultyId?: number | null;
  grade: string;
  climbName?: string | null;
};

function hardestSendSortValue(send: Pick<HardestSend, 'difficultyId' | 'grade'>): number {
  return send.difficultyId ?? gradeSortValue(send.grade);
}

export function sortHardestSends(hardestSends: HardestSend[]): HardestSend[] {
  return [...hardestSends].sort((first, second) => hardestSendSortValue(second) - hardestSendSortValue(first));
}
