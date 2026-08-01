import { createHash } from 'node:crypto';
import {
  HOLD_STATE_MAP,
  isAuroraBoardName,
  parseFramesSegments,
  projectAuroraFramesToStoredRows,
  type StoredClimbHoldRow,
} from '@boardsesh/board-constants/hold-states';

export type RepairHoldRow = {
  holdId: number;
  frameNumber: number;
  holdState: string;
};

export type RepairClimbInput = {
  boardType: string;
  uuid: string;
  layoutId: number;
  frames: string | null;
  framesCount: number | null;
  holdFingerprint: string | null;
  multiFrameTarget: boolean;
  rows: RepairHoldRow[];
};

export type FingerprintClassification =
  | 'null'
  | 'already-current'
  | 'row-derived'
  | 'legacy-frame-derived'
  | 'independent';

export type RepairManifestEntry = {
  boardType: string;
  uuid: string;
  layoutId: number;
  multiFrame: boolean;
  oldRows: RepairHoldRow[];
  projectedRows: RepairHoldRow[] | null;
  invalidRows: RepairHoldRow[];
  changed: boolean;
  blockers: string[];
  diagnostics: {
    skippedUnknownRoleTokens: number;
    skippedNonpositiveHoldIdTokens: number;
    missingPlacementHoldIds: number[];
  };
  fingerprint: {
    classification: FingerprintClassification;
    old: string | null;
    projected: string | null;
    shouldUpdate: boolean;
  };
  rowHashes: { old: string; projected: string };
};

export type RepairManifest = {
  version: 1;
  counts: {
    scannedClimbs: number;
    scannedMultiFrameClimbs: number;
    changedMultiFrameClimbs: number;
    affectedClimbs: number;
    invalidRows: number;
    deleteRows: number;
    insertRows: number;
    fingerprintUpdates: number;
    blockers: number;
    skippedUnknownRoleTokens: number;
    skippedNonpositiveHoldIdTokens: number;
    missingPlacements: number;
  };
  entries: RepairManifestEntry[];
};

export type StrictProjectionResult =
  | { ok: true; rows: StoredClimbHoldRow[]; skippedUnknownRoleTokens: number; skippedNonpositiveHoldIdTokens: number }
  | { ok: false; errors: string[] };

const TOKEN = /p(-?\d+)r(\d+)|x(-?\d+)/y;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

/** Repair-only strict validation layered over the production frame parser. */
export function strictlyProjectStoredRows(
  boardType: string,
  frames: string | null,
  expectedFramesCount: number | null,
): StrictProjectionResult {
  if (!isAuroraBoardName(boardType)) {
    return { ok: false, errors: [`unsupported board_type ${boardType}`] };
  }
  if (typeof frames !== 'string' || frames.length === 0) {
    return { ok: false, errors: ['frames is empty'] };
  }

  const errors: string[] = [];
  const rawSegments = frames.split(',');
  for (const [frameNumber, rawSegment] of rawSegments.entries()) {
    const quotedDelta = frameNumber > 0 && rawSegment.startsWith('"');
    const body = quotedDelta ? rawSegment.slice(1) : rawSegment;
    if (body.length === 0) {
      if (!quotedDelta) errors.push(`frame ${frameNumber} is an empty unquoted absolute frame`);
      continue;
    }
    let offset = 0;
    while (offset < body.length) {
      TOKEN.lastIndex = offset;
      const match = TOKEN.exec(body);
      if (!match || match.index !== offset) {
        errors.push(`frame ${frameNumber} has malformed text at offset ${offset}`);
        break;
      }
      const holdIdText = match[1] ?? match[3];
      const roleCodeText = match[2];
      const holdId = Number(holdIdText);
      if (!Number.isSafeInteger(holdId) || holdId > POSTGRES_INTEGER_MAX) {
        errors.push(`frame ${frameNumber} has a hold ID outside the PostgreSQL integer range at offset ${offset}`);
      }
      if (roleCodeText !== undefined && !Number.isSafeInteger(Number(roleCodeText))) {
        errors.push(`frame ${frameNumber} has a role code outside the safe integer range at offset ${offset}`);
      }
      offset = TOKEN.lastIndex;
    }
  }

  const parsedSegments = parseFramesSegments(frames);
  if (expectedFramesCount == null || !Number.isInteger(expectedFramesCount) || expectedFramesCount <= 0) {
    errors.push(`frames_count is invalid: ${String(expectedFramesCount)}`);
  } else if (parsedSegments.length !== expectedFramesCount) {
    errors.push(`frames_count mismatch: stored=${expectedFramesCount} parsed=${parsedSegments.length}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const projection = projectAuroraFramesToStoredRows(frames, boardType);
  return {
    ok: true,
    rows: projection.rows,
    skippedUnknownRoleTokens: projection.diagnostics.skippedUnknownRoleTokens,
    skippedNonpositiveHoldIdTokens: projection.diagnostics.skippedNonpositiveHoldIdTokens,
  };
}

export function isInvalidStoredRow(row: RepairHoldRow): boolean {
  // Delete only shapes proven to be corrupt. Unknown but well-formed state
  // names may belong to a newer board definition and are preserved; readers
  // that require parser symmetry apply their narrower supported-state filter.
  return row.holdId <= 0 || row.holdState.length === 0 || row.holdState.includes('=');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortRepairRows(rows: ReadonlyArray<RepairHoldRow>): RepairHoldRow[] {
  return [...rows].sort(
    (left, right) =>
      left.holdId - right.holdId ||
      left.frameNumber - right.frameNumber ||
      compareText(left.holdState, right.holdState),
  );
}

export function fingerprintFromRepairRows(rows: ReadonlyArray<RepairHoldRow>): string {
  const tuples = rows
    .map((row) => `${row.holdId}:${row.holdState}:${row.frameNumber}`)
    .sort()
    .join('|');
  return createHash('sha256').update(tuples).digest('hex');
}

/**
 * Reproduce the fingerprint emitted by the historical Kilter Grips decoder.
 * That decoder hashed every raw `p` event, even when a later relight reused a
 * hold ID that the table primary key had already collapsed. Matching this
 * digest proves the existing fingerprint came from the stored frames and is
 * safe to migrate; arbitrary independent fingerprints remain untouched.
 */
export function fingerprintFromLegacyFrameTokens(boardType: string, frames: string | null): string | null {
  if (!isAuroraBoardName(boardType) || !frames) return null;

  const legacyRows: RepairHoldRow[] = [];
  const setToken = /p(-?\d+)r(\d+)/g;
  for (const [frameNumber, segment] of parseFramesSegments(frames).entries()) {
    setToken.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = setToken.exec(segment.body)) !== null) {
      const holdId = Number(match[1]);
      const roleCode = Number(match[2]);
      const holdState = HOLD_STATE_MAP[boardType][roleCode]?.name ?? `${holdId}=${roleCode}`;
      legacyRows.push({ holdId, frameNumber, holdState });
    }
  }
  return legacyRows.length > 0 ? fingerprintFromRepairRows(legacyRows) : null;
}

export function classifyFingerprint(
  current: string | null,
  oldRows: ReadonlyArray<RepairHoldRow>,
  projectedRows: ReadonlyArray<RepairHoldRow>,
  legacyFrameFingerprint: string | null = null,
): FingerprintClassification {
  if (current === null) return 'null';
  const projected = fingerprintFromRepairRows(projectedRows);
  // SHA256(empty) is not a valid climb identity. Treat the exact empty digest
  // as proven empty-derived even when stale materialized rows still exist, so
  // an authoritative empty projection can clear it to NULL.
  if (current === projected) return projectedRows.length === 0 ? 'row-derived' : 'already-current';
  if (current === fingerprintFromRepairRows(oldRows)) return 'row-derived';
  return current === legacyFrameFingerprint ? 'legacy-frame-derived' : 'independent';
}

function sameRows(left: ReadonlyArray<RepairHoldRow>, right: ReadonlyArray<RepairHoldRow>): boolean {
  return JSON.stringify(sortRepairRows(left)) === JSON.stringify(sortRepairRows(right));
}

export function placementKey(boardType: string, layoutId: number, holdId: number): string {
  return `${boardType}\u0000${layoutId}\u0000${holdId}`;
}

export function buildRepairManifest(
  climbs: ReadonlyArray<RepairClimbInput>,
  existingPlacementKeys: ReadonlySet<string>,
): RepairManifest {
  const entries: RepairManifestEntry[] = climbs
    .map((climb): RepairManifestEntry => {
      const oldRows = sortRepairRows(climb.rows);
      const invalidRows = oldRows.filter(isInvalidStoredRow);
      const multiFrame = climb.multiFrameTarget;
      const blockers: string[] = [];
      let projectedRows: RepairHoldRow[] | null = null;
      let skippedUnknownRoleTokens = 0;
      let skippedNonpositiveHoldIdTokens = 0;

      if (multiFrame) {
        const projection = strictlyProjectStoredRows(climb.boardType, climb.frames, climb.framesCount);
        if (!projection.ok) {
          blockers.push(...projection.errors);
        } else {
          projectedRows = sortRepairRows(projection.rows);
          skippedUnknownRoleTokens = projection.skippedUnknownRoleTokens;
          skippedNonpositiveHoldIdTokens = projection.skippedNonpositiveHoldIdTokens;
        }
      }

      const changed = multiFrame && projectedRows !== null && !sameRows(oldRows, projectedRows);
      const invalidOnlyCleanup = !multiFrame && invalidRows.length > 0;
      const rowsAfterRepair = changed
        ? (projectedRows ?? oldRows)
        : invalidOnlyCleanup
          ? oldRows.filter((row) => !isInvalidStoredRow(row))
          : oldRows;
      const fingerprintClassification = classifyFingerprint(
        climb.holdFingerprint,
        oldRows,
        rowsAfterRepair,
        fingerprintFromLegacyFrameTokens(climb.boardType, climb.frames),
      );
      // The canonical backfill leaves no-hold climbs at NULL. SHA256(empty)
      // looks like a real climb identity and can leak into dedup/grade joins.
      const projectedFingerprint = rowsAfterRepair.length > 0 ? fingerprintFromRepairRows(rowsAfterRepair) : null;
      const hasAuthoritativeProjection = multiFrame && projectedRows !== null;
      const fingerprintNeedsUpdate = climb.holdFingerprint !== projectedFingerprint;
      const shouldUpdateFingerprint =
        fingerprintNeedsUpdate &&
        ((fingerprintClassification === 'row-derived' &&
          (changed || invalidOnlyCleanup || hasAuthoritativeProjection)) ||
          (fingerprintClassification === 'legacy-frame-derived' && hasAuthoritativeProjection));
      const missingPlacementHoldIds = Array.from(
        new Set(
          (projectedRows ?? [])
            .filter((row) => !existingPlacementKeys.has(placementKey(climb.boardType, climb.layoutId, row.holdId)))
            .map((row) => row.holdId),
        ),
      ).sort((left, right) => left - right);
      if (missingPlacementHoldIds.length > 0) {
        blockers.push(`missing board placements: ${missingPlacementHoldIds.join(',')}`);
      }

      return {
        boardType: climb.boardType,
        uuid: climb.uuid,
        layoutId: climb.layoutId,
        multiFrame,
        oldRows,
        projectedRows,
        invalidRows,
        changed,
        blockers,
        diagnostics: {
          skippedUnknownRoleTokens,
          skippedNonpositiveHoldIdTokens,
          missingPlacementHoldIds,
        },
        fingerprint: {
          classification: fingerprintClassification,
          old: climb.holdFingerprint,
          projected: projectedFingerprint,
          shouldUpdate: shouldUpdateFingerprint,
        },
        rowHashes: {
          old: fingerprintFromRepairRows(oldRows),
          projected: fingerprintFromRepairRows(rowsAfterRepair),
        },
      };
    })
    .sort((left, right) => compareText(left.boardType, right.boardType) || compareText(left.uuid, right.uuid));

  const affectedEntries = entries.filter(
    (entry) => entry.changed || (!entry.multiFrame && entry.invalidRows.length > 0) || entry.fingerprint.shouldUpdate,
  );
  return {
    version: 1,
    counts: {
      scannedClimbs: entries.length,
      scannedMultiFrameClimbs: entries.filter((entry) => entry.multiFrame).length,
      changedMultiFrameClimbs: entries.filter((entry) => entry.changed).length,
      affectedClimbs: affectedEntries.length,
      invalidRows: entries.reduce((total, entry) => total + entry.invalidRows.length, 0),
      deleteRows: entries.reduce(
        (total, entry) =>
          total + (entry.changed ? entry.oldRows.length : entry.multiFrame ? 0 : entry.invalidRows.length),
        0,
      ),
      insertRows: entries.reduce((total, entry) => total + (entry.changed ? (entry.projectedRows?.length ?? 0) : 0), 0),
      fingerprintUpdates: entries.filter((entry) => entry.fingerprint.shouldUpdate).length,
      blockers: entries.reduce((total, entry) => total + entry.blockers.length, 0),
      skippedUnknownRoleTokens: entries.reduce((total, entry) => total + entry.diagnostics.skippedUnknownRoleTokens, 0),
      skippedNonpositiveHoldIdTokens: entries.reduce(
        (total, entry) => total + entry.diagnostics.skippedNonpositiveHoldIdTokens,
        0,
      ),
      missingPlacements: entries.reduce((total, entry) => total + entry.diagnostics.missingPlacementHoldIds.length, 0),
    },
    entries,
  };
}

export function digestRepairManifest(manifest: RepairManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}
