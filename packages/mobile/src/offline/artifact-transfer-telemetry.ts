// `Offline Artifact Transfer` — one event per artifact transfer that actually
// moved bytes (issue #4394).
//
// The download funnel cannot answer "how fast is this device downloading?":
// `Offline Board Download Completed` fires at SCOPE completion, omits
// `downloadMs` whenever the delta pull lands in a later cycle, and carries no
// transport dimension. A reused artifact emits nothing here, so the denominator
// is always real network work.
//
// Every prop is ABSENT when unknown, never zero — a 0 kbit/s row and a row with
// no measurement are different facts, and only one of them is a slow download.

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../lib/analytics';
import { isOfflineEngineEnabled } from '../lib/offline-engine';
import { getLastKnownMetered } from './offline-sync-adapter';
import type { SnapshotDownloadStrategy } from './download-strategy';

export type ArtifactTransferOutcome = 'completed' | 'failed' | 'aborted';

export type ArtifactTransferReport = {
  strategy: SnapshotDownloadStrategy;
  artifact: 'layout' | 'grades';
  /** Layout artifacts only — a grades manifest block carries neither. */
  boardType?: string;
  layoutId?: number;
  outcome: ArtifactTransferOutcome;
  /** The stored object size: the scale the confirm dialog and the progress bar quote. */
  wireBytes: number;
  expectedDecodedBytes?: number;
  bytesOnDisk?: number;
  wallMs: number;
  firstByteMs?: number;
  backgroundedDuringTransfer: boolean;
  /** Reserved for the resume follow-up; always false today. */
  resumed: boolean;
  /** Only ever set when `expectedDecodedBytes` was known and could be compared. */
  sizeMismatch?: boolean;
};

/**
 * Wire throughput in kbit/s, or undefined when it would not mean anything.
 *
 * WIRE scale deliberately: it is the number directly comparable to the
 * ~15 Mbit/s Safari and ~1.3 Mbit/s in-app figures in #4394. Only computed for a
 * completed transfer with a positive duration — a failed transfer moved an
 * unknown number of bytes, and dividing by a zero-ish wall clock produces a
 * headline figure nobody can reproduce.
 */
function wireKbps(report: ArtifactTransferReport): number | undefined {
  if (report.outcome !== 'completed' || report.wallMs <= 0) return undefined;
  return Math.round((report.wireBytes * 8) / report.wallMs);
}

export function reportArtifactTransfer(report: ArtifactTransferReport): void {
  const metered = getLastKnownMetered();
  track(SHARED_EVENTS.OfflineArtifactTransfer, {
    strategy: report.strategy,
    artifact: report.artifact,
    ...(report.boardType !== undefined ? { boardType: report.boardType } : {}),
    ...(report.layoutId !== undefined ? { layoutId: report.layoutId } : {}),
    outcome: report.outcome,
    wireBytes: report.wireBytes,
    ...(report.expectedDecodedBytes !== undefined ? { expectedDecodedBytes: report.expectedDecodedBytes } : {}),
    ...(report.bytesOnDisk !== undefined ? { bytesOnDisk: report.bytesOnDisk } : {}),
    wallMs: report.wallMs,
    ...(report.firstByteMs !== undefined ? { firstByteMs: report.firstByteMs } : {}),
    ...(wireKbps(report) !== undefined ? { wireKbps: wireKbps(report) } : {}),
    backgroundedDuringTransfer: report.backgroundedDuringTransfer,
    resumed: report.resumed,
    ...(report.sizeMismatch !== undefined ? { sizeMismatch: report.sizeMismatch } : {}),
    ...(metered !== null ? { metered } : {}),
    offlineEngineEnabled: isOfflineEngineEnabled(),
  });
}
