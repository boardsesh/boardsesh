import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BoardRouteHandoff } from '../../../../src/components/BoardRouteRedirect';
import { boardQrScanMedium } from '../../../../src/lib/board-qr-scan';
import { buildSlugListTarget } from '../../../../src/lib/routing/board-route-target';

type NamedBoardListRouteParams = {
  board_slug?: string;
  angle?: string;
  /** A spray share link's capability — resolved during the board handoff. */
  wall?: string;
  /** A home board share link's token — redeemed during the board handoff. */
  invite?: string;
  /** `qr` on a printed code's link; counted with `medium` once the board opens. */
  src?: string | string[];
  medium?: string | string[];
};

/** `/b/{slug}/{angle}/list` — a named board's climb list at a given angle. */
export default function NamedBoardListRoute() {
  const { board_slug, angle, wall, invite, src, medium } = useLocalSearchParams<NamedBoardListRouteParams>();
  const target = useMemo(() => buildSlugListTarget(board_slug, angle), [board_slug, angle]);
  const qrMedium = boardQrScanMedium({ src, medium });

  return <BoardRouteHandoff target={target} wallUuid={wall} inviteToken={invite} qrMedium={qrMedium} />;
}
