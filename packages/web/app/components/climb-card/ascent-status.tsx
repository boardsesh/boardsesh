'use client';

import React, { useMemo } from 'react';
import type { LogbookEntry } from '@boardsesh/board-react';
import { boardSupportsMirroring } from '@boardsesh/play-view';
import { AscentStatusIcon } from '@/app/components/ascent-status/ascent-status-icon';
import {
  normalizeAscentStatus,
  pickHighestAscentStatus,
  type AscentStatusValue,
} from '@/app/components/ascent-status/ascent-status-utils';
import type { BoardName, ClimbUuid } from '@/app/lib/types';

const EMPTY_LOGBOOK: readonly LogbookEntry[] = [];

type AscentStatusProps = {
  climbUuid: ClimbUuid;
  /** Currently selected board angle. Badges only reflect ticks logged at this angle
   *  so a send at 30° doesn't display when the user is viewing the climb at 50°. */
  angle: number;
  /** The viewer's ticks. Optional: anonymous SSR — crawlers and the front door —
   *  renders no badge at all, and every caller that has a logbook passes it in. */
  logbook?: readonly LogbookEntry[];
  /** Board being viewed; decides whether mirrored ticks get their own badge. */
  boardName?: BoardName;
  /** Layout on that board — only matters for Tension's non-mirroring layout 11.
   *  Omit when the caller doesn't have it; every other board/layout mirrors
   *  the same regardless. */
  layoutId?: number;
  fontSize?: number;
  /** Class for the badge wrapper (e.g. positioning on a thumbnail).
   *  For mirroring boards this is applied to each individual badge. */
  className?: string;
  /** Additional class for the mirrored ascent badge (bottom-left positioning). */
  mirroredClassName?: string;
};

function getHighestStatus(entries: readonly LogbookEntry[]): AscentStatusValue | null {
  return pickHighestAscentStatus(
    entries.map((entry) =>
      normalizeAscentStatus({
        status: entry.status,
        isAscent: entry.is_ascent,
        tries: entry.tries,
      }),
    ),
  );
}

export const AscentStatus = ({
  climbUuid,
  angle,
  logbook,
  // 'kilter' keeps the pre-props behaviour for a caller that has no board in
  // hand: a non-mirroring board, so one badge.
  boardName = 'kilter',
  layoutId,
  fontSize,
  className,
  mirroredClassName,
}: AscentStatusProps) => {
  const entries = logbook ?? EMPTY_LOGBOOK;

  const ascentsForClimb = useMemo(
    () => entries.filter((ascent) => ascent.climb_uuid === climbUuid && ascent.angle === angle),
    [entries, climbUuid, angle],
  );

  const overallStatus = useMemo(() => getHighestStatus(ascentsForClimb), [ascentsForClimb]);
  const regularStatus = useMemo(
    () => getHighestStatus(ascentsForClimb.filter(({ is_mirror }) => !is_mirror)),
    [ascentsForClimb],
  );
  const mirroredStatus = useMemo(
    () => getHighestStatus(ascentsForClimb.filter(({ is_mirror }) => is_mirror)),
    [ascentsForClimb],
  );
  // layoutId only matters for Tension's non-mirroring layout 11; a caller
  // without it (no layout in scope) gets the common case for every board.
  const supportsMirroring = boardSupportsMirroring(boardName, layoutId ?? 1);

  if (supportsMirroring) {
    if (!regularStatus && !mirroredStatus) return null;

    return (
      <>
        {regularStatus && (
          <AscentStatusIcon
            status={regularStatus}
            variant="badge"
            fontSize={fontSize}
            className={className}
            testId="ascent-badge"
          />
        )}
        {mirroredStatus && (
          <AscentStatusIcon
            status={mirroredStatus}
            variant="badge"
            fontSize={fontSize}
            className={mirroredClassName ?? className}
            mirrored
            testId="ascent-badge-mirrored"
          />
        )}
      </>
    );
  }

  if (!overallStatus) return null;

  return (
    <AscentStatusIcon
      status={overallStatus}
      variant="badge"
      fontSize={fontSize}
      className={className}
      testId="ascent-badge"
    />
  );
};
