import { execute } from '@boardsesh/graphql-client';
import { detectMoonboardLinkMode, type MoonboardLinkMode } from '@boardsesh/board-config';
import { REPORT_MOONBOARD_LINK_DETECTED } from '@boardsesh/graphql/operations/board-presence';

/**
 * MoonBoard link-mode detection (#7220). After an iOS connect, the native
 * adapter reports the write characteristic's CoreBluetooth properties: the
 * original box is write-with-response only (relay), V3 onwards adds
 * write-without-response (several phones). Android reports no properties, so
 * Android-only walls keep the default.
 *
 * Reported over the presence socket on purpose: the backend checks the board
 * presence stamp, which is keyed by this connection for an anonymous climber.
 */
export type MoonboardLinkDetectionInput = {
  enabled: boolean;
  boardType: string | null | undefined;
  boardId: number | null | undefined;
  characteristicProperties: number | null | undefined;
};

/** The detected mode to report, or null when nothing should be sent. */
export function moonboardLinkDetectionToReport(input: MoonboardLinkDetectionInput): MoonboardLinkMode | null {
  if (!input.enabled || input.boardType !== 'moonboard' || input.boardId == null) return null;
  return detectMoonboardLinkMode(input.characteristicProperties);
}

type ReportMoonboardLinkDetectedData = { reportMoonboardLinkDetected: boolean };

const reportedThisLaunch = new Set<string>();

/**
 * Fire-and-forget. Once per (board, mode) per launch: a box doesn't change
 * generation between connects, and the server ignores repeats anyway.
 */
export function reportMoonboardLinkDetection(input: MoonboardLinkDetectionInput): void {
  const detected = moonboardLinkDetectionToReport(input);
  if (detected === null || input.boardId == null) return;
  const key = `${input.boardId}:${detected}`;
  if (reportedThisLaunch.has(key)) return;
  reportedThisLaunch.add(key);
  const boardId = input.boardId;
  // Loaded lazily: the socket module pulls in the app's network stack, which
  // the provider's import graph (and its tests) should not need for this.
  import('../graphql/ws-client')
    .then(({ getWsClient }) =>
      execute<ReportMoonboardLinkDetectedData>(getWsClient, {
        query: REPORT_MOONBOARD_LINK_DETECTED,
        variables: { boardId, detected },
      }),
    )
    .catch(() => {
      // Best effort: a later connect retries. Never surface this to the climber.
      reportedThisLaunch.delete(key);
    });
}

/** Test seam. */
export function resetMoonboardLinkDetectionForTests(): void {
  reportedThisLaunch.clear();
}
