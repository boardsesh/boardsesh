import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { useMountedOnFirstOpen } from '../../hooks/use-mounted-on-first-open';
import { resolveTickDefaultGradeName } from '../../lib/boardsesh-grade-display';
import { LogAscentSheet } from '../LogAscentSheet';
import { PlayDrawerSectionsSheet } from './PlayDrawerSectionsSheet';
import { AddBetaVideoSheet } from '../AddBetaVideoSheet';
import { AddToPlaylistSheet } from '../AddToPlaylistSheet';
import { LogbookFullSheet } from './logbook/LogbookFullSheet';
import { ClimberLogsSheet } from './ClimberLogsSheet';
import { ReportClimbSheet } from '../report-climb/ReportClimbSheet';
import { AngleSelectorSheet } from './AngleSelectorSheet';
import { BleControlSheetHost } from '../ble/BleControlSheetHost';
import type { BoardConfig, PlayDrawerProps } from './play-drawer-types';
import type { PlayerButtonsPreviewBoard } from '../player-buttons/PlayerButtonsPreview';

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
  /** View options lists the Active holds switch: the climb on screen or the active board is a MoonBoard. */
  sectionsListActiveHolds: boolean;
  /** The board on screen, for View options' buttons preview. */
  buttonsPreviewBoard: PlayerButtonsPreviewBoard;
  addBetaVideoOpen: boolean;
  addToPlaylistOpen: boolean;
  fullLogbookClimbUuid: string | null;
  climberLogsOpen: boolean;
  reportClimbOpen: boolean;
  angleSelectorVisible: boolean;
  isTickBarActive: boolean;
  bleControlVisible: boolean;
  composerCredentialScope: number;
  betaVideoTarget: ComposerTarget;
  playlistTarget: ComposerTarget;
  reportTarget: ComposerTarget;
  tickTarget: ComposerTarget;
  isMirrored: boolean;
  boardseshActive: boolean;
  sessionId: string | null;
  onAngleChange: PlayDrawerProps['onAngleChange'];
  handleCloseSectionsSettings: () => void;
  handleCloseSubDrawer: () => void;
  handleCloseAddBetaVideo: () => void;
  handleCloseAddToPlaylist: () => void;
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
  sectionsListActiveHolds,
  buttonsPreviewBoard,
  addBetaVideoOpen,
  addToPlaylistOpen,
  fullLogbookClimbUuid,
  climberLogsOpen,
  reportClimbOpen,
  angleSelectorVisible,
  isTickBarActive,
  bleControlVisible,
  composerCredentialScope,
  betaVideoTarget,
  playlistTarget,
  reportTarget,
  tickTarget,
  isMirrored,
  boardseshActive,
  sessionId,
  onAngleChange,
  handleCloseSectionsSettings,
  handleCloseSubDrawer,
  handleCloseAddBetaVideo,
  handleCloseAddToPlaylist,
  handleCloseFullLogbook,
  handleCloseClimberLogs,
  handleOpenClimberProfile,
  handleCloseReportClimb,
  handleTickBarDismiss,
  handleCloseBleControl,
}: PlayCoreSheetHostsProps) {
  const mountSectionsSettings = useMountedOnFirstOpen(sectionsSettingsOpen);
  const mountAddBetaVideo = useMountedOnFirstOpen(addBetaVideoOpen);
  const mountAddToPlaylist = useMountedOnFirstOpen(addToPlaylistOpen);
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
        <PlayDrawerSectionsSheet
          visible={sectionsSettingsOpen}
          onClose={handleCloseSectionsSettings}
          previewBoard={buttonsPreviewBoard}
          listsActiveHolds={sectionsListActiveHolds}
        />
      )}
      {/* Sub-drawers: @expo/ui native .sheet()s presented from within the player
          route's view controller, so they stack ABOVE it. Every one of them is
          mounted on first open, then kept. */}

      {/* Sub-drawer: Share your beta — opened from ⋯ → "Add beta video" or the
          Beta Videos section "+" button. */}
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

      {/* Sub-drawer: Add to playlist — opened from ⋯. The player's own host,
          because the root one presents under `/play` and flashes closed (#3294).
          Pinned to the climb ⋯ was opened on, and keyed on the credential scope
          like the composers, so a sign-out can't carry a half-typed playlist name
          into the next account. */}
      {mountAddToPlaylist && (
        <AddToPlaylistSheet
          key={`playlist-${composerCredentialScope}`}
          visible={addToPlaylistOpen}
          climb={playlistTarget?.climb ?? displayedClimb ?? null}
          boardName={(playlistTarget?.boardConfig.boardName ?? boardName) as BoardName}
          layoutId={playlistTarget?.boardConfig.layoutId ?? layoutId}
          sizeId={playlistTarget?.boardConfig.sizeId ?? sizeId}
          setIds={playlistTarget?.boardConfig.setIds ?? setIds}
          angle={playlistTarget?.boardConfig.angle ?? angle}
          onClose={handleCloseAddToPlaylist}
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

      {/* Sub-drawer: Report climb — opened from ⋯. Mounted on first open and
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
