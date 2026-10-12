import type { ComponentProps } from 'react';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { randomUUID } from 'expo-crypto';
import { useMountedOnFirstOpen } from '../../hooks/use-mounted-on-first-open';
import { resolveTickDefaultGradeName } from '../../lib/boardsesh-grade-display';
import { LogAscentSheet } from '../LogAscentSheet';
import { PlayDrawerSectionsSheet } from './PlayDrawerSectionsSheet';
import { ClimbActionsSheet } from '../ClimbActionsSheet';
import { AddBetaVideoSheet } from '../AddBetaVideoSheet';
import { LogbookFullSheet } from './logbook/LogbookFullSheet';
import { ClimberLogsSheet } from './ClimberLogsSheet';
import { ReportClimbSheet } from '../report-climb/ReportClimbSheet';
import { AngleSelectorSheet } from './AngleSelectorSheet';
import { BleControlSheetHost } from '../ble/BleControlSheetHost';
import { canReportDisplayedClimb } from './can-report-climb';
import type { BoardConfig, PlayDrawerProps } from './play-drawer-types';
import type { useQueueActions } from '../../providers/queue-provider';

type ComposerTarget = { climb: Climb; boardConfig: BoardConfig } | null;

export type PlayCoreSheetHostsProps = {
  displayedClimb: Climb | null | undefined;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  boardConfig: BoardConfig;
  activeAngle: number;
  climbBoardMismatch: boolean;
  sectionsSettingsOpen: boolean;
  climbActionsVisible: boolean;
  addBetaVideoOpen: boolean;
  fullLogbookClimbUuid: string | null;
  climberLogsOpen: boolean;
  reportClimbOpen: boolean;
  angleSelectorVisible: boolean;
  isTickBarActive: boolean;
  bleControlVisible: boolean;
  composerCredentialScope: number;
  betaVideoTarget: ComposerTarget;
  reportTarget: ComposerTarget;
  tickTarget: ComposerTarget;
  currentUserId: string | null;
  isAuthenticated: boolean;
  moderationEnabled: boolean;
  showConnectPill: boolean;
  displayedClimbIsDraft: boolean;
  isMirrored: boolean;
  boardseshActive: boolean;
  sessionId: string | null;
  addToQueue: ReturnType<typeof useQueueActions>['addToQueue'];
  dismissPlayerAndWait: PlayDrawerProps['dismissPlayerAndWait'];
  onAngleChange: PlayDrawerProps['onAngleChange'];
  handleCloseSectionsSettings: () => void;
  handleToggleFavoriteFromMenu: () => void;
  handleOpenAddBetaVideo: () => void;
  handleOpenReportClimb: () => void;
  openQueueFromActions: ComponentProps<typeof ClimbActionsSheet>['onOpenQueue'];
  handleShare: ComponentProps<typeof ClimbActionsSheet>['onShare'];
  handleDismiss: () => void;
  handleCloseSubDrawer: () => void;
  handleCloseAddBetaVideo: () => void;
  handleCloseFullLogbook: () => void;
  handleCloseClimberLogs: () => void;
  handleOpenClimberProfile: (userId: string) => void;
  handleCloseReportClimb: () => void;
  handleTickBarDismiss: () => void;
  handleCloseBleControl: () => void;
};

/**
 * These first-use hosts stay under the player's existing view controller. A
 * Fragment preserves the native tree; visibility and pinned targets remain in
 * Core, and each opened host survives closing until the player itself leaves.
 */
export function PlayCoreSheetHosts({
  displayedClimb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  boardConfig,
  activeAngle,
  climbBoardMismatch,
  sectionsSettingsOpen,
  climbActionsVisible,
  addBetaVideoOpen,
  fullLogbookClimbUuid,
  climberLogsOpen,
  reportClimbOpen,
  angleSelectorVisible,
  isTickBarActive,
  bleControlVisible,
  composerCredentialScope,
  betaVideoTarget,
  reportTarget,
  tickTarget,
  currentUserId,
  isAuthenticated,
  moderationEnabled,
  showConnectPill,
  displayedClimbIsDraft,
  isMirrored,
  boardseshActive,
  sessionId,
  addToQueue,
  dismissPlayerAndWait,
  onAngleChange,
  handleCloseSectionsSettings,
  handleToggleFavoriteFromMenu,
  handleOpenAddBetaVideo,
  handleOpenReportClimb,
  openQueueFromActions,
  handleShare,
  handleDismiss,
  handleCloseSubDrawer,
  handleCloseAddBetaVideo,
  handleCloseFullLogbook,
  handleCloseClimberLogs,
  handleOpenClimberProfile,
  handleCloseReportClimb,
  handleTickBarDismiss,
  handleCloseBleControl,
}: PlayCoreSheetHostsProps) {
  const mountSectionsSettings = useMountedOnFirstOpen(sectionsSettingsOpen);
  const mountClimbActions = useMountedOnFirstOpen(climbActionsVisible);
  const mountAddBetaVideo = useMountedOnFirstOpen(addBetaVideoOpen);
  const fullLogbookOpen = fullLogbookClimbUuid !== null;
  const mountFullLogbook = useMountedOnFirstOpen(fullLogbookOpen);
  const mountClimberLogs = useMountedOnFirstOpen(climberLogsOpen);
  const mountReportClimb = useMountedOnFirstOpen(reportClimbOpen);
  const mountAngleSelector = useMountedOnFirstOpen(angleSelectorVisible);
  const mountLogAscent = useMountedOnFirstOpen(isTickBarActive);
  const mountBleControl = useMountedOnFirstOpen(bleControlVisible);
  // Resolve once, retaining the pinned identity through dismiss animations.
  const tickClimb = tickTarget?.climb ?? displayedClimb;

  return (
    <>
      {mountSectionsSettings && (
        <PlayDrawerSectionsSheet visible={sectionsSettingsOpen} onClose={handleCloseSectionsSettings} />
      )}
      {/* Sub-drawers: @expo/ui native .sheet()s presented from within the player
          route's view controller, so they stack ABOVE it. On iOS the ellipsis
          routes to ClimbReactionMenu via onOpenClimbActions, so activeSubDrawer
          never becomes 'actions' there. Mounted on first open, then kept. */}
      {mountClimbActions && (
        <ClimbActionsSheet
          visible={climbActionsVisible}
          climb={displayedClimb ?? null}
          boardName={boardName as BoardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          angle={angle}
          currentUserId={currentUserId}
          onAddToQueue={() => {
            if (displayedClimb) {
              void addToQueue({
                uuid: randomUUID(),
                climb: displayedClimb,
              });
            }
          }}
          onToggleFavorite={handleToggleFavoriteFromMenu}
          onAddBetaVideo={isAuthenticated ? handleOpenAddBetaVideo : undefined}
          onReportClimb={
            canReportDisplayedClimb({
              isAuthenticated,
              moderationEnabled,
              climb: displayedClimb,
              currentUserId,
              boardName,
            })
              ? handleOpenReportClimb
              : undefined
          }
          onOpenQueue={openQueueFromActions}
          onShare={showConnectPill && !displayedClimbIsDraft ? handleShare : undefined}
          dismissPlayerAndWait={dismissPlayerAndWait}
          onClimbDeleted={handleDismiss}
          onClose={handleCloseSubDrawer}
        />
      )}

      {/* Sub-drawer: Share your beta — opened from the action sheet's "Add beta
          video" row or the Beta Videos section "+" button. Mounted on first open. */}
      {mountAddBetaVideo && (
        <AddBetaVideoSheet
          key={`beta-${composerCredentialScope}`}
          visible={addBetaVideoOpen}
          climb={betaVideoTarget?.climb ?? displayedClimb ?? null}
          boardName={(betaVideoTarget?.boardConfig.boardName ?? boardName) as BoardName}
          layoutId={betaVideoTarget?.boardConfig.layoutId ?? layoutId}
          angle={betaVideoTarget?.boardConfig.angle ?? angle}
          onClose={handleCloseAddBetaVideo}
        />
      )}

      {/* Sub-drawer: the climber's full history on this climb, opened from the
          Logbook card when it has more than the card shows. Mounted on first open. */}
      {mountFullLogbook && (
        <LogbookFullSheet
          visible={fullLogbookOpen}
          climbUuid={fullLogbookClimbUuid}
          boardName={boardName as BoardName}
          layoutId={layoutId}
          angle={angle}
          onClose={handleCloseFullLogbook}
        />
      )}

      {/* Sub-drawer: every followed climber's logs on this climb, opened from the
          Climber logs card's "See all logs" row. Mounted on first open. */}
      {mountClimberLogs && (
        <ClimberLogsSheet
          visible={climberLogsOpen}
          climb={displayedClimb ?? null}
          boardName={boardName}
          angle={angle}
          onClose={handleCloseClimberLogs}
          onOpenProfile={handleOpenClimberProfile}
        />
      )}

      {/* Sub-drawer: Report climb — opened from the reaction menu (iOS) or the
          actions sheet's "Report climb" row (Android). Mounted on first open and
          then kept, so it never unmounts between reports — which is why it
          resets its own form on each fresh open rather than on unmount. */}
      {mountReportClimb && (
        <ReportClimbSheet
          key={`report-${composerCredentialScope}`}
          visible={reportClimbOpen}
          climb={reportTarget?.climb ?? displayedClimb ?? null}
          boardName={(reportTarget?.boardConfig.boardName ?? boardName) as BoardName}
          layoutId={reportTarget?.boardConfig.layoutId ?? layoutId}
          sizeId={reportTarget?.boardConfig.sizeId ?? sizeId}
          setIds={reportTarget?.boardConfig.setIds ?? setIds}
          angle={reportTarget?.boardConfig.angle ?? angle}
          onClose={handleCloseReportClimb}
        />
      )}

      {/* Sub-drawer: Angle selector. Mounted on first open, then toggled via `visible`. */}
      {mountAngleSelector && (
        <AngleSelectorSheet
          visible={angleSelectorVisible}
          onClose={handleCloseSubDrawer}
          boardName={boardConfig.boardName}
          layoutId={boardConfig.layoutId}
          // Per-angle stats are read against the board above; a climb from
          // another board has none there, so ask for none.
          climbUuid={climbBoardMismatch ? undefined : displayedClimb?.uuid}
          currentAngle={activeAngle}
          onAngleChange={(newAngle) => {
            onAngleChange?.(newAngle);
            handleCloseSubDrawer();
          }}
        />
      )}

      {/* Tick sheet — a 60% sub-drawer so the climb image stays visible while
          logging. Presents over the player route. The displayedClimb guard stays;
          the host is mounted on first open. */}
      {mountLogAscent && tickClimb && (
        <LogAscentSheet
          key={`tick-${composerCredentialScope}`}
          climb={tickClimb}
          visible={isTickBarActive}
          onClose={handleTickBarDismiss}
          climbUuid={tickClimb.uuid}
          climbName={tickClimb.name}
          boardName={tickTarget?.boardConfig.boardName ?? boardName}
          angle={tickTarget?.boardConfig.angle ?? angle}
          isMirror={isMirrored}
          isBenchmark={tickClimb.benchmark_difficulty != null}
          baseAscensionistCount={tickClimb.ascensionist_count ?? 0}
          layoutId={tickTarget?.boardConfig.layoutId ?? layoutId}
          sizeId={tickTarget?.boardConfig.sizeId ?? sizeId}
          setIds={tickTarget?.boardConfig.setIds ?? setIds}
          sessionId={sessionId}
          // The tick picker opens on the Boardsesh grade (when the toggle is on and
          // a trusted one exists) instead of the Aurora consensus, so a logged grade
          // defaults to what the app now shows. Only the DEFAULT changes — the saved
          // tick value stays on the Aurora scale and null until the climber picks.
          consensusGradeName={
            resolveTickDefaultGradeName(tickClimb, boardseshActive, tickTarget?.boardConfig.boardName ?? boardName) ??
            tickClimb.difficulty
          }
        />
      )}

      {/* BLE controls (Re-light / Turn off all lights / Disconnect), opened by the
          lightbulb long-press. Hosted here so it presents ABOVE the player route
          (the app-root instance would land behind it). Mounted on first open. */}
      {mountBleControl && <BleControlSheetHost visible={bleControlVisible} onClose={handleCloseBleControl} />}
    </>
  );
}
