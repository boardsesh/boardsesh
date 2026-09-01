import { createHash, createHmac } from 'node:crypto';

export const AUDIT_POLICY_VERSION = 'legacy-timestamp-audit/v1' as const;
export const RESIDUAL_TOLERANCE_SECONDS = 60;
export const SMALL_CELL_THRESHOLD = 5;

// Current civil UTC offsets represented by the IANA timezone database. This is
// intentionally an explicit allowlist, not "any multiple of 15 minutes": most
// quarter-hour values are not real zones. It includes the current quarter-hour
// zones (Eucla, Nepal and the Chatham Islands) and the -12:00/+14:00 bounds.
export const ALLOWED_IANA_UTC_OFFSET_SECONDS = [
  -12 * 3600,
  -11 * 3600,
  -10 * 3600,
  -(9 * 3600 + 30 * 60),
  -9 * 3600,
  -8 * 3600,
  -7 * 3600,
  -6 * 3600,
  -5 * 3600,
  -4 * 3600,
  -(3 * 3600 + 30 * 60),
  -3 * 3600,
  -(2 * 3600 + 30 * 60),
  -2 * 3600,
  -1 * 3600,
  0,
  1 * 3600,
  2 * 3600,
  3 * 3600,
  3 * 3600 + 30 * 60,
  4 * 3600,
  4 * 3600 + 30 * 60,
  5 * 3600,
  5 * 3600 + 30 * 60,
  5 * 3600 + 45 * 60,
  6 * 3600,
  6 * 3600 + 30 * 60,
  7 * 3600,
  8 * 3600,
  8 * 3600 + 45 * 60,
  9 * 3600,
  9 * 3600 + 30 * 60,
  10 * 3600,
  10 * 3600 + 30 * 60,
  11 * 3600,
  12 * 3600,
  12 * 3600 + 45 * 60,
  13 * 3600,
  13 * 3600 + 45 * 60,
  14 * 3600,
] as const;

export type TickOrigin = 'native' | 'aurora_pull' | 'kilter_pull' | 'json_import';
export type TickStatus = 'flash' | 'send' | 'attempt';

export type AuditPolicy = {
  policyId: string;
  liveOldCodeActiveThroughEpochSeconds: number;
  liveFixedCodeActiveFromEpochSeconds: number;
  jsonOldCodeActiveThroughEpochSeconds: number;
  jsonFixedCodeActiveFromEpochSeconds: number;
  originWritersActiveFromEpochSeconds: number;
  nativeSafeGenerationActiveFromEpochSeconds: number;
};

/** Private scan row. Raw identifiers must never cross the output mapper. */
export type AuditTick = {
  id: string;
  uuid: string;
  userId: string;
  boardType: string;
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  origin: TickOrigin;
  status: TickStatus;
  attemptCount: number;
  climbedAtEpochSeconds: number;
  createdAtEpochSeconds: number;
  updatedAtEpochSeconds: number;
  createdAtEqualsUpdatedAt: boolean;
  auroraSyncedAtEpochSeconds: number | null;
  auroraIdIsSyntheticJson: boolean;
  kilterSyncedAtEpochSeconds: number | null;
  kilterDetachedAtEpochSeconds: number | null;
};

export type CandidateCohort =
  | 'json_timing_unknown'
  | 'json_pre_fix'
  | 'json_rollout_uncertain'
  | 'aurora_pre_fix'
  | 'aurora_rollout_uncertain'
  | 'aurora_post_fix_control'
  | 'json_post_fix_control';

export type CandidateRole = 'suspect' | 'post_fix_control' | 'uncertain';

export type CandidateClassification = {
  role: CandidateRole;
  cohort: CandidateCohort;
};

export type OriginEvidence = 'writer_stamped' | 'legacy_origin_may_be_heuristic';

export type CandidateTimestampEvidence =
  | 'aurora_unchanged_since_sync'
  | 'aurora_sync_stamp_missing'
  | 'aurora_timestamp_edit_cannot_be_excluded'
  | 'json_synthetic_import_owned_timestamps'
  | 'json_import_provenance_unverified';

export type AnchorTimestampEvidence =
  | 'kilter_unchanged_since_sync'
  | 'kilter_sync_stamp_missing'
  | 'kilter_timestamp_edit_cannot_be_excluded'
  | 'native_unchanged_since_verified_safe_save'
  | 'native_before_verified_safe_save'
  | 'native_timestamp_edit_cannot_be_excluded';

export type OffsetMatch = {
  offsetSeconds: number;
  residualSeconds: number;
  targetEpochSeconds: number;
};

export type OffsetInference = Omit<OffsetMatch, 'targetEpochSeconds'>;

export type MatchEdge = OffsetMatch & {
  candidateIndex: number;
  anchorIndex: number;
};

export type CandidateGraphResult = {
  candidate: AuditTick;
  candidateClass: CandidateClassification;
  candidateDegree: number;
  edge: MatchEdge | null;
  reciprocal: boolean;
  classification:
    | 'correction_evidence'
    | 'aligned_control'
    | 'post_fix_invariant_violation'
    | 'ambiguous_abstention'
    | 'heuristic_only_anchor_abstention'
    | 'candidate_timestamp_unverified_abstention'
    | 'kilter_timestamp_unverified_anchor_abstention'
    | 'native_timestamp_unverified_anchor_abstention'
    | 'no_anchor_abstention'
    | 'rollout_uncertain_abstention';
};

export type GroupAnalysis = {
  candidates: CandidateGraphResult[];
  anchors: AuditTick[];
  edgeCount: number;
};

function hasExactSyntheticJsonImportProvenance(tick: AuditTick): boolean {
  return (
    tick.origin === 'json_import' &&
    tick.auroraIdIsSyntheticJson &&
    tick.auroraSyncedAtEpochSeconds !== null &&
    tick.updatedAtEpochSeconds === tick.auroraSyncedAtEpochSeconds
  );
}

export function classifyCandidate(tick: AuditTick, policy: AuditPolicy): CandidateClassification | null {
  if (tick.origin === 'json_import') {
    // created_at is Aurora export content, not the import execution time. A
    // claimed JSON row also carries a real aurora_id and a later sync stamp
    // while keeping the original bad climbed_at. Only a still-synthetic row
    // whose import-owned updated/synced stamps agree can enter a verified JSON
    // deployment cohort; every other JSON row stays timing-unknown.
    const hasImportOwnedExecutionStamp = hasExactSyntheticJsonImportProvenance(tick);
    if (!hasImportOwnedExecutionStamp || tick.auroraSyncedAtEpochSeconds === null) {
      return { role: 'suspect', cohort: 'json_timing_unknown' };
    }
    if (tick.auroraSyncedAtEpochSeconds <= policy.jsonOldCodeActiveThroughEpochSeconds) {
      return { role: 'suspect', cohort: 'json_pre_fix' };
    }
    if (tick.auroraSyncedAtEpochSeconds >= policy.jsonFixedCodeActiveFromEpochSeconds) {
      return { role: 'post_fix_control', cohort: 'json_post_fix_control' };
    }
    return { role: 'uncertain', cohort: 'json_rollout_uncertain' };
  }

  if (tick.origin !== 'aurora_pull') return null;
  if (
    tick.auroraSyncedAtEpochSeconds !== null &&
    tick.auroraSyncedAtEpochSeconds <= policy.liveOldCodeActiveThroughEpochSeconds
  ) {
    return { role: 'suspect', cohort: 'aurora_pre_fix' };
  }
  if (
    tick.auroraSyncedAtEpochSeconds !== null &&
    tick.auroraSyncedAtEpochSeconds >= policy.liveFixedCodeActiveFromEpochSeconds
  ) {
    return { role: 'post_fix_control', cohort: 'aurora_post_fix_control' };
  }
  return { role: 'uncertain', cohort: 'aurora_rollout_uncertain' };
}

/**
 * Prove that a candidate's stored climbed_at still represents its source
 * timestamp. Rows failing this check remain graph vertices, but cannot support
 * a correction, aligned control, or post-fix invariant result.
 */
export function candidateTimestampEvidence(tick: AuditTick): CandidateTimestampEvidence {
  if (tick.origin === 'json_import') {
    return hasExactSyntheticJsonImportProvenance(tick)
      ? 'json_synthetic_import_owned_timestamps'
      : 'json_import_provenance_unverified';
  }
  if (tick.origin !== 'aurora_pull') {
    throw new Error(`Candidate timestamp evidence requested for non-candidate origin: ${tick.origin}`);
  }
  if (tick.auroraSyncedAtEpochSeconds === null) return 'aurora_sync_stamp_missing';
  if (tick.updatedAtEpochSeconds > tick.auroraSyncedAtEpochSeconds) {
    return 'aurora_timestamp_edit_cannot_be_excluded';
  }
  return 'aurora_unchanged_since_sync';
}

function candidateTimestampIsEligible(tick: AuditTick): boolean {
  const evidence = candidateTimestampEvidence(tick);
  return evidence === 'aurora_unchanged_since_sync' || evidence === 'json_synthetic_import_owned_timestamps';
}

/**
 * Keep every plausible anchor in the graph so a migration-0156 heuristic row,
 * including any historical native row, can still make an otherwise-clean
 * match ambiguous. Eligibility for the graph does not by itself make an anchor
 * strong enough to support a proposal.
 */
export function isAnchorEligibleForAmbiguityGraph(tick: AuditTick): boolean {
  if (tick.origin === 'kilter_pull') return tick.kilterDetachedAtEpochSeconds === null;
  return tick.origin === 'native';
}

export function originEvidence(tick: AuditTick, policy: AuditPolicy): OriginEvidence {
  // JSON created_at is never consulted here: it is export data. For native and
  // Kilter rows created_at is generated by their writer. Migration 0156 did
  // not persist whether a Kilter origin was backfilled, so created_at is useful
  // only after an independently verified instant when 0156 had completed and
  // every active writer stamped origin itself. Without that deployment proof,
  // a historical Kilter origin remains heuristic and can only add ambiguity.
  if (tick.origin !== 'json_import' && tick.createdAtEpochSeconds >= policy.originWritersActiveFromEpochSeconds) {
    return 'writer_stamped';
  }
  return 'legacy_origin_may_be_heuristic';
}

export function anchorTimestampEvidence(tick: AuditTick, policy: AuditPolicy): AnchorTimestampEvidence {
  if (tick.origin === 'kilter_pull') {
    if (tick.kilterSyncedAtEpochSeconds === null) return 'kilter_sync_stamp_missing';
    if (tick.updatedAtEpochSeconds > tick.kilterSyncedAtEpochSeconds) {
      return 'kilter_timestamp_edit_cannot_be_excluded';
    }
    return 'kilter_unchanged_since_sync';
  }
  if (tick.origin !== 'native') {
    throw new Error(`Anchor timestamp evidence requested for non-anchor origin: ${tick.origin}`);
  }
  if (tick.createdAtEpochSeconds < policy.nativeSafeGenerationActiveFromEpochSeconds) {
    return 'native_before_verified_safe_save';
  }
  if (!tick.createdAtEqualsUpdatedAt) return 'native_timestamp_edit_cannot_be_excluded';
  return 'native_unchanged_since_verified_safe_save';
}

export function inferAllowedOffset(rawDeltaSeconds: number): OffsetInference | null {
  if (!Number.isFinite(rawDeltaSeconds)) return null;
  let bestOffset: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let tied = false;

  for (const offsetSeconds of ALLOWED_IANA_UTC_OFFSET_SECONDS) {
    const distance = Math.abs(rawDeltaSeconds - offsetSeconds);
    if (distance < bestDistance) {
      bestOffset = offsetSeconds;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance) {
      tied = true;
    }
  }

  if (bestOffset === null || tied || bestDistance > RESIDUAL_TOLERANCE_SECONDS) return null;
  return {
    offsetSeconds: bestOffset,
    residualSeconds: rawDeltaSeconds - bestOffset,
  };
}

function ascentSemantics(status: TickStatus): 'attempt' | 'ascent' {
  return status === 'attempt' ? 'attempt' : 'ascent';
}

export function areSemanticsCompatible(candidate: AuditTick, anchor: AuditTick): boolean {
  return (
    ascentSemantics(candidate.status) === ascentSemantics(anchor.status) &&
    candidate.attemptCount === anchor.attemptCount &&
    candidate.isMirror === anchor.isMirror
  );
}

function compareTickIdentity(first: AuditTick, second: AuditTick): number {
  return (
    first.climbedAtEpochSeconds - second.climbedAtEpochSeconds ||
    first.origin.localeCompare(second.origin) ||
    first.id.localeCompare(second.id)
  );
}

function semanticsKey(tick: AuditTick): string {
  return `${ascentSemantics(tick.status)}\0${tick.attemptCount}\0${tick.isMirror ? '1' : '0'}`;
}

function lowerBoundByClimbedAt(
  rows: Array<{ anchor: AuditTick; anchorIndex: number }>,
  targetEpochSeconds: number,
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].anchor.climbedAtEpochSeconds < targetEpochSeconds) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Analyze the complete candidate↔anchor graph for one exact
 * (user, board, climb, angle) key before deciding which edges are usable.
 * Degrees are counted as edges stream past; only a candidate's sole edge is
 * retained. This preserves reciprocal/ambiguity decisions without materializing
 * a potentially quadratic edge array.
 */
export function analyzeTickGroup(rows: AuditTick[], policy: AuditPolicy): GroupAnalysis {
  const candidates = rows
    .map((candidate) => ({ candidate, candidateClass: classifyCandidate(candidate, policy) }))
    .filter(
      (entry): entry is { candidate: AuditTick; candidateClass: CandidateClassification } =>
        entry.candidateClass !== null,
    )
    .sort((first, second) => compareTickIdentity(first.candidate, second.candidate));
  const anchors = rows.filter(isAnchorEligibleForAmbiguityGraph).sort(compareTickIdentity);
  const candidateDegrees = Array.from({ length: candidates.length }, () => 0);
  const anchorDegrees = Array.from({ length: anchors.length }, () => 0);
  const soleCandidateEdges = Array<MatchEdge | null>(candidates.length).fill(null);
  let edgeCount = 0;

  const anchorsBySemantics = new Map<string, Array<{ anchor: AuditTick; anchorIndex: number }>>();
  anchors.forEach((anchor, anchorIndex) => {
    const key = semanticsKey(anchor);
    const existing = anchorsBySemantics.get(key);
    if (existing) existing.push({ anchor, anchorIndex });
    else anchorsBySemantics.set(key, [{ anchor, anchorIndex }]);
  });

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex].candidate;
    const compatibleAnchors = anchorsBySemantics.get(semanticsKey(candidate)) ?? [];
    for (const offsetSeconds of ALLOWED_IANA_UTC_OFFSET_SECONDS) {
      const expectedAnchorEpochSeconds = candidate.climbedAtEpochSeconds - offsetSeconds;
      let compatibleIndex = lowerBoundByClimbedAt(
        compatibleAnchors,
        expectedAnchorEpochSeconds - RESIDUAL_TOLERANCE_SECONDS,
      );
      while (
        compatibleIndex < compatibleAnchors.length &&
        compatibleAnchors[compatibleIndex].anchor.climbedAtEpochSeconds <=
          expectedAnchorEpochSeconds + RESIDUAL_TOLERANCE_SECONDS
      ) {
        const { anchor, anchorIndex } = compatibleAnchors[compatibleIndex];
        if (candidate.uuid !== anchor.uuid && areSemanticsCompatible(candidate, anchor)) {
          const rawDeltaSeconds = candidate.climbedAtEpochSeconds - anchor.climbedAtEpochSeconds;
          const inferred = inferAllowedOffset(rawDeltaSeconds);
          // The closest-allowlisted-offset check prevents overlapping windows
          // from emitting the same pair twice.
          if (inferred?.offsetSeconds === offsetSeconds) {
            const edge: MatchEdge = {
              candidateIndex,
              anchorIndex,
              offsetSeconds,
              residualSeconds: inferred.residualSeconds,
              // Subtract only the civil offset. Do not snap to the anchor:
              // source seconds remain visible in the target and residual.
              targetEpochSeconds: candidate.climbedAtEpochSeconds - offsetSeconds,
            };
            edgeCount += 1;
            candidateDegrees[candidateIndex] += 1;
            anchorDegrees[anchorIndex] += 1;
            soleCandidateEdges[candidateIndex] = candidateDegrees[candidateIndex] === 1 ? edge : null;
          }
        }
        compatibleIndex += 1;
      }
    }
  }

  const results: CandidateGraphResult[] = candidates.map(({ candidate, candidateClass }, candidateIndex) => {
    if (candidateClass.role === 'uncertain') {
      return {
        candidate,
        candidateClass,
        candidateDegree: candidateDegrees[candidateIndex],
        edge: null,
        reciprocal: false,
        classification: 'rollout_uncertain_abstention',
      };
    }
    const candidateDegree = candidateDegrees[candidateIndex];
    const onlyEdge = candidateDegree === 1 ? soleCandidateEdges[candidateIndex] : null;
    const reciprocal = onlyEdge !== null && anchorDegrees[onlyEdge.anchorIndex] === 1;
    if (!onlyEdge) {
      return {
        candidate,
        candidateClass,
        candidateDegree,
        edge: null,
        reciprocal: false,
        classification: candidateDegree === 0 ? 'no_anchor_abstention' : 'ambiguous_abstention',
      };
    }
    if (!reciprocal) {
      return {
        candidate,
        candidateClass,
        candidateDegree: 1,
        edge: onlyEdge,
        reciprocal: false,
        classification: 'ambiguous_abstention',
      };
    }
    const anchor = anchors[onlyEdge.anchorIndex];
    if (originEvidence(anchor, policy) !== 'writer_stamped') {
      return {
        candidate,
        candidateClass,
        candidateDegree: 1,
        edge: onlyEdge,
        reciprocal: true,
        classification: 'heuristic_only_anchor_abstention',
      };
    }
    if (
      anchor.origin === 'native' &&
      anchorTimestampEvidence(anchor, policy) !== 'native_unchanged_since_verified_safe_save'
    ) {
      return {
        candidate,
        candidateClass,
        candidateDegree: 1,
        edge: onlyEdge,
        reciprocal: true,
        classification: 'native_timestamp_unverified_anchor_abstention',
      };
    }
    if (anchor.origin === 'kilter_pull' && anchorTimestampEvidence(anchor, policy) !== 'kilter_unchanged_since_sync') {
      return {
        candidate,
        candidateClass,
        candidateDegree: 1,
        edge: onlyEdge,
        reciprocal: true,
        classification: 'kilter_timestamp_unverified_anchor_abstention',
      };
    }
    if (!candidateTimestampIsEligible(candidate)) {
      return {
        candidate,
        candidateClass,
        candidateDegree: 1,
        edge: onlyEdge,
        reciprocal: true,
        classification: 'candidate_timestamp_unverified_abstention',
      };
    }
    if (onlyEdge.offsetSeconds === 0) {
      return {
        candidate,
        candidateClass,
        candidateDegree: 1,
        edge: onlyEdge,
        reciprocal: true,
        classification: 'aligned_control',
      };
    }
    return {
      candidate,
      candidateClass,
      candidateDegree: 1,
      edge: onlyEdge,
      reciprocal: true,
      classification:
        candidateClass.role === 'post_fix_control' ? 'post_fix_invariant_violation' : 'correction_evidence',
    };
  });

  return { candidates: results, anchors, edgeCount };
}

export function groupKey(tick: AuditTick): string {
  return `${tick.userId}\0${tick.boardType}\0${tick.angle}\0${tick.climbUuid}`;
}

export function pseudonymize(secret: Uint8Array, namespace: string, rawIdentifier: string): string {
  return createHmac('sha256', secret).update(namespace).update('\0').update(rawIdentifier).digest('hex').slice(0, 24);
}

export function epochSecondsToIso(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) throw new Error('Cannot render a non-finite epoch value');
  return new Date(epochSeconds * 1000).toISOString();
}

export function redactSmallCell(count: number): number | '<5' {
  return count > 0 && count < SMALL_CELL_THRESHOLD ? '<5' : count;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

const FORBIDDEN_OUTPUT_KEYS = new Set([
  'id',
  'userid',
  'rawuserid',
  'comment',
  'comments',
  'sessionid',
  'dsn',
  'databaseurl',
]);
const DSN_PATTERN = /(?:postgres(?:ql)?:\/\/|password\s*=)/i;

export function assertPrivacySafeRecord(value: unknown, path = '$'): void {
  if (typeof value === 'string' && DSN_PATTERN.test(value)) {
    throw new Error(`Audit output contains a database credential/DSN at ${path}`);
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPrivacySafeRecord(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FORBIDDEN_OUTPUT_KEYS.has(normalizedKey) || normalizedKey.endsWith('uuid')) {
      throw new Error(`Audit output contains forbidden raw field ${path}.${key}`);
    }
    assertPrivacySafeRecord(nested, `${path}.${key}`);
  }
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
