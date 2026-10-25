import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BoardRouteHandoff } from '../../../src/components/BoardRouteRedirect';
import { boardQrScanMedium } from '../../../src/lib/board-qr-scan';
import { buildSlugListTarget } from '../../../src/lib/routing/board-route-target';

/**
 * `/b/{slug}` — a named board with no angle in the URL, so the board's own
 * stored angle is the one the user lands on.
 *
 * `?invite=` is a home board's share link: the handoff asks the climber to
 * confirm Join, and joins the board before opening it, only if they do
 * (`redeem-board-share-link.ts`).
 *
 * `?src=qr&medium=…` is a printed code (the wall poster, the kiosk). The
 * handoff counts it once the board opens (`board-qr-scan.ts`).
 */
export default function NamedBoardRoute() {
  const { board_slug, wall, invite, src, medium } = useLocalSearchParams<{
    board_slug?: string;
    wall?: string;
    invite?: string;
    src?: string | string[];
    medium?: string | string[];
  }>();
  const target = useMemo(() => buildSlugListTarget(board_slug), [board_slug]);
  const qrMedium = boardQrScanMedium({ src, medium });

  return <BoardRouteHandoff target={target} wallUuid={wall} inviteToken={invite} qrMedium={qrMedium} />;
}
