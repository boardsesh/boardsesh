// "Report a problem" on the gym page: the header ⋯ row and the row at the foot
// of the page, for the gym itself. The board rows' reports go through the
// page's board menu (`useGymBoardReports`).
//
// The page mounts `sheet` inside its own route (the in-tree opener rule in
// docs/mobile/mobile-sheets-vs-routes.md) and calls `open` from both entry
// points. Null for viewers who can fix the gym themselves (they get Edit gym
// details instead) and while the `directory-reports` flag is off, so nothing on
// screen promises a report that can't be sent. Once a report or the claim sheet
// it hands over to is up, it stays non-null until that sheet closes, so a gym
// read that changes mid-report never unmounts the sheet being filled in.

import { useMemo } from 'react';
import type { Gym } from '@boardsesh/shared-schema';
import { useReportProblem, type ReportProblemAction } from '../report-problem/use-report-problem';

export type GymReportAction = ReportProblemAction;

export function useGymReportAction(gym: Gym | null): GymReportAction | null {
  const target = useMemo(() => (gym ? { kind: 'gym' as const, gym } : null), [gym]);
  return useReportProblem({ target });
}
