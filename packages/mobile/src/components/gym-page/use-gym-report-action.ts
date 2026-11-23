// The seam for "Report a problem" on the gym page.
//
// The report sheet arrives in a separate change (the app's report and review
// sheets). Until it does this returns null, and the page draws neither the
// header ⋯ row nor the row at the foot of the page, so nothing on screen
// promises a report that can't be sent.
//
// To wire it: return `{ open, sheet }`. The page mounts `sheet` inside its own
// route (the in-tree opener rule in docs/mobile/mobile-sheets-vs-routes.md) and
// calls `open` from both entry points. Return null for viewers who can fix the
// gym themselves (they get Edit gym details instead) and when the report
// feature flag is off.

import type { ReactNode } from 'react';
import type { Gym } from '@boardsesh/shared-schema';

export type GymReportAction = {
  /** Opens the report sheet for this gym. */
  open: () => void;
  /** The sheet, mounted by the gym page route. */
  sheet: ReactNode;
};

export function useGymReportAction(_gym: Pick<Gym, 'uuid' | 'name' | 'canEdit'> | null): GymReportAction | null {
  return null;
}
