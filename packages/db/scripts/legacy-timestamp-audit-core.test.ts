import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_IANA_UTC_OFFSET_SECONDS,
  analyzeTickGroup,
  anchorTimestampEvidence,
  assertPrivacySafeRecord,
  canonicalJson,
  candidateTimestampEvidence,
  classifyCandidate,
  inferAllowedOffset,
  isAnchorEligibleForAmbiguityGraph,
  originEvidence,
  pseudonymize,
  redactSmallCell,
  type AuditPolicy,
  type AuditTick,
} from './legacy-timestamp-audit-core.js';

const HOUR = 3600;
const policy: AuditPolicy = {
  policyId: 'test-policy',
  liveOldCodeActiveThroughEpochSeconds: 100,
  liveFixedCodeActiveFromEpochSeconds: 200,
  jsonOldCodeActiveThroughEpochSeconds: 100,
  jsonFixedCodeActiveFromEpochSeconds: 200,
  originWritersActiveFromEpochSeconds: 50,
  nativeSafeGenerationActiveFromEpochSeconds: 60,
};

function tick(overrides: Partial<AuditTick> = {}): AuditTick {
  return {
    id: '1',
    uuid: 'tick-1',
    userId: 'user-1',
    boardType: 'kilter',
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    origin: 'json_import',
    status: 'send',
    attemptCount: 2,
    climbedAtEpochSeconds: 20 * HOUR,
    createdAtEpochSeconds: 1,
    updatedAtEpochSeconds: 1,
    createdAtEqualsUpdatedAt: false,
    auroraSyncedAtEpochSeconds: 1,
    auroraIdIsSyntheticJson: true,
    kilterSyncedAtEpochSeconds: null,
    kilterDetachedAtEpochSeconds: null,
    ...overrides,
  };
}

function anchor(overrides: Partial<AuditTick> = {}): AuditTick {
  return tick({
    id: '2',
    uuid: 'anchor-1',
    origin: 'kilter_pull',
    climbedAtEpochSeconds: 10 * HOUR,
    createdAtEpochSeconds: 50,
    kilterSyncedAtEpochSeconds: 50,
    ...overrides,
  });
}

void describe('allowed IANA UTC offsets', () => {
  void it('contains both world bounds and the current quarter-hour zones', () => {
    for (const expected of [
      -12 * HOUR,
      -(2 * HOUR + 30 * 60),
      14 * HOUR,
      5 * HOUR + 45 * 60,
      8 * HOUR + 45 * 60,
      12 * HOUR + 45 * 60,
    ]) {
      assert.ok(ALLOWED_IANA_UTC_OFFSET_SECONDS.includes(expected as never));
    }
  });

  void it('does not treat arbitrary quarter-hour values as a real timezone', () => {
    assert.equal(inferAllowedOffset(7 * HOUR + 15 * 60), null);
  });

  void it('accepts up to sixty seconds of residual and rejects the next second', () => {
    assert.deepEqual(inferAllowedOffset(10 * HOUR + 60), {
      offsetSeconds: 10 * HOUR,
      residualSeconds: 60,
    });
    assert.equal(inferAllowedOffset(10 * HOUR + 61), null);
  });

  void it('handles negative offsets without changing their sign', () => {
    assert.deepEqual(inferAllowedOffset(-3 * HOUR - 30 * 60 - 7), {
      offsetSeconds: -(3 * HOUR + 30 * 60),
      residualSeconds: -7,
    });
  });
});

void describe('cohort and anchor policy', () => {
  void it('keeps a claimed JSON row suspect by origin even after a later live claim', () => {
    const claimed = tick({
      auroraIdIsSyntheticJson: false,
      auroraSyncedAtEpochSeconds: 300,
      updatedAtEpochSeconds: 300,
      createdAtEpochSeconds: 300,
    });
    assert.deepEqual(classifyCandidate(claimed, policy), {
      role: 'suspect',
      cohort: 'json_timing_unknown',
    });
  });

  void it('never uses JSON created_at to prove that an import ran after the fix', () => {
    const exportedAfterFixButImportedAtUnknownTime = tick({
      createdAtEpochSeconds: 300,
      updatedAtEpochSeconds: 10,
      auroraSyncedAtEpochSeconds: 10,
      auroraIdIsSyntheticJson: true,
    });
    assert.equal(classifyCandidate(exportedAfterFixButImportedAtUnknownTime, policy)?.role, 'suspect');
  });

  void it('recognizes only still-synthetic, import-owned stamps as a JSON post-fix control', () => {
    const control = tick({
      createdAtEpochSeconds: 1,
      updatedAtEpochSeconds: 250,
      auroraSyncedAtEpochSeconds: 250,
      auroraIdIsSyntheticJson: true,
    });
    assert.deepEqual(classifyCandidate(control, policy), {
      role: 'post_fix_control',
      cohort: 'json_post_fix_control',
    });
  });

  void it('uses import-owned stamps to separate JSON pre-fix and uncertain rollout cohorts', () => {
    const preFix = tick({
      updatedAtEpochSeconds: 90,
      auroraSyncedAtEpochSeconds: 90,
      auroraIdIsSyntheticJson: true,
    });
    const uncertain = tick({
      updatedAtEpochSeconds: 150,
      auroraSyncedAtEpochSeconds: 150,
      auroraIdIsSyntheticJson: true,
    });
    assert.deepEqual(classifyCandidate(preFix, policy), { role: 'suspect', cohort: 'json_pre_fix' });
    assert.deepEqual(classifyCandidate(uncertain, policy), {
      role: 'uncertain',
      cohort: 'json_rollout_uncertain',
    });
  });

  void it('requires exact still-synthetic JSON import provenance for timestamp evidence', () => {
    assert.equal(candidateTimestampEvidence(tick()), 'json_synthetic_import_owned_timestamps');
    assert.equal(candidateTimestampEvidence(tick({ updatedAtEpochSeconds: 1.5 })), 'json_import_provenance_unverified');
    assert.equal(
      candidateTimestampEvidence(
        tick({
          auroraIdIsSyntheticJson: false,
          updatedAtEpochSeconds: 90,
          auroraSyncedAtEpochSeconds: 250,
        }),
      ),
      'json_import_provenance_unverified',
    );
  });

  void it('treats live Aurora timestamps as unverified after a local edit or without a sync stamp', () => {
    assert.equal(
      candidateTimestampEvidence(
        tick({ origin: 'aurora_pull', updatedAtEpochSeconds: 90, auroraSyncedAtEpochSeconds: 90 }),
      ),
      'aurora_unchanged_since_sync',
    );
    assert.equal(
      candidateTimestampEvidence(
        tick({ origin: 'aurora_pull', updatedAtEpochSeconds: 91, auroraSyncedAtEpochSeconds: 90 }),
      ),
      'aurora_timestamp_edit_cannot_be_excluded',
    );
    assert.equal(
      candidateTimestampEvidence(tick({ origin: 'aurora_pull', auroraSyncedAtEpochSeconds: null })),
      'aurora_sync_stamp_missing',
    );
  });

  void it('abstains inside the verified live rollout gap', () => {
    assert.deepEqual(classifyCandidate(tick({ origin: 'aurora_pull', auroraSyncedAtEpochSeconds: 150 }), policy), {
      role: 'uncertain',
      cohort: 'aurora_rollout_uncertain',
    });
  });

  void it('keeps Kilter and every native row in the ambiguity graph', () => {
    assert.equal(isAnchorEligibleForAmbiguityGraph(anchor()), true);
    assert.equal(isAnchorEligibleForAmbiguityGraph(anchor({ kilterDetachedAtEpochSeconds: 99 })), false);
    assert.equal(
      isAnchorEligibleForAmbiguityGraph(anchor({ origin: 'native', createdAtEpochSeconds: Number.MIN_SAFE_INTEGER })),
      true,
    );
    assert.equal(isAnchorEligibleForAmbiguityGraph(anchor({ origin: 'native', createdAtEpochSeconds: 50 })), true);
  });

  void it('requires a post-boundary native anchor to retain its exact insert-time updated_at', () => {
    const safeNative = anchor({
      origin: 'native',
      createdAtEpochSeconds: 60,
      updatedAtEpochSeconds: 60,
      createdAtEqualsUpdatedAt: true,
    });
    assert.equal(anchorTimestampEvidence(safeNative, policy), 'native_unchanged_since_verified_safe_save');
    assert.equal(
      anchorTimestampEvidence({ ...safeNative, updatedAtEpochSeconds: 61, createdAtEqualsUpdatedAt: false }, policy),
      'native_timestamp_edit_cannot_be_excluded',
    );
    assert.equal(
      anchorTimestampEvidence(
        {
          ...safeNative,
          createdAtEpochSeconds: 59,
          updatedAtEpochSeconds: 59,
          createdAtEqualsUpdatedAt: true,
        },
        policy,
      ),
      'native_before_verified_safe_save',
    );
  });

  void it('requires a Kilter anchor not to be newer than its source sync stamp', () => {
    assert.equal(anchorTimestampEvidence(anchor(), policy), 'kilter_unchanged_since_sync');
    assert.equal(
      anchorTimestampEvidence(anchor({ updatedAtEpochSeconds: 51 }), policy),
      'kilter_timestamp_edit_cannot_be_excluded',
    );
    assert.equal(
      anchorTimestampEvidence(anchor({ kilterSyncedAtEpochSeconds: null }), policy),
      'kilter_sync_stamp_missing',
    );
  });

  void it('distinguishes deployment-proven writer stamps from migration-0156 heuristic Kilter origins', () => {
    assert.equal(originEvidence(anchor({ createdAtEpochSeconds: 49 }), policy), 'legacy_origin_may_be_heuristic');
    assert.equal(originEvidence(anchor({ createdAtEpochSeconds: 50 }), policy), 'writer_stamped');
  });
});

void describe('complete bipartite ambiguity graph', () => {
  void it('subtracts the inferred offset while preserving source seconds and reporting residual separately', () => {
    const analysis = analyzeTickGroup(
      [tick({ climbedAtEpochSeconds: 20 * HOUR + 17 }), anchor({ climbedAtEpochSeconds: 10 * HOUR })],
      policy,
    );
    const [result] = analysis.candidates;
    assert.equal(result.classification, 'correction_evidence');
    assert.equal(result.edge?.offsetSeconds, 10 * HOUR);
    assert.equal(result.edge?.residualSeconds, 17);
    assert.equal(result.edge?.targetEpochSeconds, 10 * HOUR + 17);
  });

  void it('abstains both candidates when two candidates share one anchor', () => {
    const analysis = analyzeTickGroup(
      [
        tick({ id: '1', uuid: 'candidate-a', climbedAtEpochSeconds: 20 * HOUR }),
        tick({ id: '2', uuid: 'candidate-b', climbedAtEpochSeconds: 20 * HOUR + 1 }),
        anchor({ id: '3', uuid: 'anchor' }),
      ],
      policy,
    );
    assert.equal(analysis.edgeCount, 2);
    assert.deepEqual(
      analysis.candidates.map(({ classification }) => classification),
      ['ambiguous_abstention', 'ambiguous_abstention'],
    );
  });

  void it('abstains when one candidate can match two anchors', () => {
    const analysis = analyzeTickGroup(
      [
        tick(),
        anchor({ id: '2', uuid: 'anchor-a', climbedAtEpochSeconds: 10 * HOUR }),
        anchor({ id: '3', uuid: 'anchor-b', climbedAtEpochSeconds: 10 * HOUR + 1 }),
      ],
      policy,
    );
    assert.equal(analysis.edgeCount, 2);
    assert.equal(analysis.candidates[0].candidateDegree, 2);
    assert.equal(analysis.candidates[0].classification, 'ambiguous_abstention');
  });

  void it('builds the graph before rollout filtering, so an uncertain competitor keeps the anchor ambiguous', () => {
    const analysis = analyzeTickGroup(
      [
        tick({ id: '1', uuid: 'suspect' }),
        tick({
          id: '2',
          uuid: 'uncertain',
          origin: 'aurora_pull',
          auroraSyncedAtEpochSeconds: 150,
        }),
        anchor({ id: '3', uuid: 'anchor' }),
      ],
      policy,
    );
    const suspect = analysis.candidates.find(({ candidate }) => candidate.uuid === 'suspect');
    const uncertain = analysis.candidates.find(({ candidate }) => candidate.uuid === 'uncertain');
    assert.equal(suspect?.classification, 'ambiguous_abstention');
    assert.equal(uncertain?.classification, 'rollout_uncertain_abstention');
  });

  void it('does not pair attempts with ascents or tolerate attempt-count/mirror differences', () => {
    for (const incompatible of [
      anchor({ status: 'attempt' }),
      anchor({ attemptCount: 3 }),
      anchor({ isMirror: true }),
    ]) {
      const analysis = analyzeTickGroup([tick(), incompatible], policy);
      assert.equal(analysis.edgeCount, 0);
      assert.equal(analysis.candidates[0].classification, 'no_anchor_abstention');
    }
  });

  void it('flags a reciprocal nonzero post-fix control as an invariant violation', () => {
    const analysis = analyzeTickGroup(
      [
        tick({
          origin: 'aurora_pull',
          auroraSyncedAtEpochSeconds: 250,
          climbedAtEpochSeconds: 20 * HOUR,
        }),
        anchor(),
      ],
      policy,
    );
    assert.equal(analysis.candidates[0].classification, 'post_fix_invariant_violation');
  });

  void it('keeps an edited pre-fix Aurora candidate in the graph but never proposes from it', () => {
    const analysis = analyzeTickGroup(
      [
        tick({
          origin: 'aurora_pull',
          auroraSyncedAtEpochSeconds: 90,
          updatedAtEpochSeconds: 91,
        }),
        anchor(),
      ],
      policy,
    );
    assert.equal(analysis.edgeCount, 1);
    assert.equal(analysis.candidates[0].reciprocal, true);
    assert.equal(analysis.candidates[0].candidateClass.cohort, 'aurora_pre_fix');
    assert.equal(analysis.candidates[0].classification, 'candidate_timestamp_unverified_abstention');
  });

  void it('still allows an unedited pre-fix Aurora candidate to support a proposal', () => {
    const analysis = analyzeTickGroup(
      [
        tick({
          origin: 'aurora_pull',
          auroraSyncedAtEpochSeconds: 90,
          updatedAtEpochSeconds: 90,
        }),
        anchor(),
      ],
      policy,
    );
    assert.equal(analysis.candidates[0].candidateClass.cohort, 'aurora_pre_fix');
    assert.equal(analysis.candidates[0].classification, 'correction_evidence');
  });

  void it('never lets an edited post-fix Aurora candidate create an invariant violation', () => {
    const analysis = analyzeTickGroup(
      [
        tick({
          origin: 'aurora_pull',
          auroraSyncedAtEpochSeconds: 250,
          updatedAtEpochSeconds: 251,
        }),
        anchor(),
      ],
      policy,
    );
    assert.equal(analysis.edgeCount, 1);
    assert.equal(analysis.candidates[0].candidateClass.cohort, 'aurora_post_fix_control');
    assert.equal(analysis.candidates[0].classification, 'candidate_timestamp_unverified_abstention');
  });

  void it('never counts an edited Aurora candidate as an aligned control', () => {
    const analysis = analyzeTickGroup(
      [
        tick({
          origin: 'aurora_pull',
          climbedAtEpochSeconds: 10 * HOUR,
          auroraSyncedAtEpochSeconds: 250,
          updatedAtEpochSeconds: 251,
        }),
        anchor(),
      ],
      policy,
    );
    assert.equal(analysis.candidates[0].classification, 'candidate_timestamp_unverified_abstention');
  });

  void it('keeps an Aurora candidate without a sync stamp in the graph but rollout-abstains', () => {
    const analysis = analyzeTickGroup(
      [tick({ origin: 'aurora_pull', auroraSyncedAtEpochSeconds: null }), anchor()],
      policy,
    );
    assert.equal(analysis.edgeCount, 1);
    assert.equal(analysis.candidates[0].candidateDegree, 1);
    assert.equal(analysis.candidates[0].classification, 'rollout_uncertain_abstention');
  });

  void it('lets an edited Aurora candidate make a clean candidate-to-anchor match ambiguous', () => {
    const analysis = analyzeTickGroup(
      [
        tick({ id: 'valid', uuid: 'valid' }),
        tick({
          id: 'edited',
          uuid: 'edited',
          origin: 'aurora_pull',
          auroraSyncedAtEpochSeconds: 90,
          updatedAtEpochSeconds: 91,
        }),
        anchor(),
      ],
      policy,
    );
    assert.equal(analysis.edgeCount, 2);
    assert.ok(analysis.candidates.every(({ classification }) => classification === 'ambiguous_abstention'));
  });

  void it('keeps an edited synthetic JSON row in the graph but never proposes from it', () => {
    const analysis = analyzeTickGroup(
      [tick({ auroraSyncedAtEpochSeconds: 90, updatedAtEpochSeconds: 91, auroraIdIsSyntheticJson: true }), anchor()],
      policy,
    );
    assert.equal(analysis.edgeCount, 1);
    assert.equal(analysis.candidates[0].candidateClass.cohort, 'json_timing_unknown');
    assert.equal(analysis.candidates[0].classification, 'candidate_timestamp_unverified_abstention');
  });

  void it('keeps a claimed JSON row in the graph but never treats its later claim stamp as edit proof', () => {
    const analysis = analyzeTickGroup(
      [
        tick({
          auroraIdIsSyntheticJson: false,
          updatedAtEpochSeconds: 90,
          auroraSyncedAtEpochSeconds: 250,
        }),
        anchor(),
      ],
      policy,
    );
    assert.equal(analysis.edgeCount, 1);
    assert.equal(analysis.candidates[0].candidateClass.cohort, 'json_timing_unknown');
    assert.equal(analysis.candidates[0].classification, 'candidate_timestamp_unverified_abstention');
  });

  void it('allows exact still-synthetic JSON import stamps to form a post-fix control', () => {
    const analysis = analyzeTickGroup(
      [tick({ updatedAtEpochSeconds: 250, auroraSyncedAtEpochSeconds: 250 }), anchor()],
      policy,
    );
    assert.equal(analysis.candidates[0].candidateClass.cohort, 'json_post_fix_control');
    assert.equal(analysis.candidates[0].classification, 'post_fix_invariant_violation');
  });

  void it('does not extrapolate an offset to another climb for the same user', () => {
    const anchored = analyzeTickGroup([tick(), anchor()], policy);
    const unanchored = analyzeTickGroup([tick({ climbUuid: 'another-climb' })], policy);
    assert.equal(anchored.candidates[0].classification, 'correction_evidence');
    assert.equal(unanchored.candidates[0].classification, 'no_anchor_abstention');
  });

  void it('keeps a heuristic Kilter anchor in the graph but abstains from an otherwise clean proposal', () => {
    const analysis = analyzeTickGroup(
      [tick(), anchor({ createdAtEpochSeconds: policy.originWritersActiveFromEpochSeconds - 1 })],
      policy,
    );
    assert.equal(analysis.edgeCount, 1);
    assert.equal(analysis.candidates[0].reciprocal, true);
    assert.equal(analysis.candidates[0].classification, 'heuristic_only_anchor_abstention');
  });

  void it('lets a heuristic Kilter anchor keep a writer-stamped anchor ambiguous', () => {
    const analysis = analyzeTickGroup(
      [
        tick(),
        anchor({ id: 'writer', uuid: 'writer', createdAtEpochSeconds: policy.originWritersActiveFromEpochSeconds }),
        anchor({
          id: 'heuristic',
          uuid: 'heuristic',
          climbedAtEpochSeconds: 10 * HOUR + 1,
          createdAtEpochSeconds: policy.originWritersActiveFromEpochSeconds - 1,
        }),
      ],
      policy,
    );
    assert.equal(analysis.edgeCount, 2);
    assert.equal(analysis.candidates[0].classification, 'ambiguous_abstention');
  });

  void it('keeps an edited Kilter anchor in the graph but never proposes from it', () => {
    const analysis = analyzeTickGroup(
      [tick(), anchor({ updatedAtEpochSeconds: 51, kilterSyncedAtEpochSeconds: 50 })],
      policy,
    );
    assert.equal(analysis.edgeCount, 1);
    assert.equal(analysis.candidates[0].reciprocal, true);
    assert.equal(analysis.candidates[0].classification, 'kilter_timestamp_unverified_anchor_abstention');
  });

  void it('keeps a Kilter anchor without a sync stamp in the graph but never proposes from it', () => {
    const analysis = analyzeTickGroup([tick(), anchor({ kilterSyncedAtEpochSeconds: null })], policy);
    assert.equal(analysis.edgeCount, 1);
    assert.equal(analysis.candidates[0].reciprocal, true);
    assert.equal(analysis.candidates[0].classification, 'kilter_timestamp_unverified_anchor_abstention');
  });

  void it('never lets an edited Kilter anchor create a post-fix invariant violation', () => {
    const analysis = analyzeTickGroup(
      [
        tick({
          origin: 'aurora_pull',
          auroraSyncedAtEpochSeconds: 250,
          updatedAtEpochSeconds: 250,
        }),
        anchor({ updatedAtEpochSeconds: 51, kilterSyncedAtEpochSeconds: 50 }),
      ],
      policy,
    );
    assert.equal(analysis.candidates[0].classification, 'kilter_timestamp_unverified_anchor_abstention');
  });

  void it('never counts an edited Kilter anchor as an aligned control', () => {
    const analysis = analyzeTickGroup(
      [tick({ climbedAtEpochSeconds: 10 * HOUR }), anchor({ updatedAtEpochSeconds: 51 })],
      policy,
    );
    assert.equal(analysis.candidates[0].classification, 'kilter_timestamp_unverified_anchor_abstention');
  });

  void it('lets an edited Kilter anchor keep a clean Kilter anchor ambiguous', () => {
    const analysis = analyzeTickGroup(
      [
        tick(),
        anchor({ id: 'clean-kilter', uuid: 'clean-kilter' }),
        anchor({
          id: 'edited-kilter',
          uuid: 'edited-kilter',
          climbedAtEpochSeconds: 10 * HOUR + 1,
          updatedAtEpochSeconds: 51,
          kilterSyncedAtEpochSeconds: 50,
        }),
      ],
      policy,
    );
    assert.equal(analysis.edgeCount, 2);
    assert.equal(analysis.candidates[0].classification, 'ambiguous_abstention');
  });

  void it('lets a matching pre-origin native row keep a strong Kilter anchor ambiguous', () => {
    const analysis = analyzeTickGroup(
      [
        tick(),
        anchor({ id: 'strong-kilter', uuid: 'strong-kilter' }),
        anchor({
          id: 'pre-origin-native',
          uuid: 'pre-origin-native',
          origin: 'native',
          climbedAtEpochSeconds: 10 * HOUR + 1,
          createdAtEpochSeconds: policy.originWritersActiveFromEpochSeconds - 1,
          updatedAtEpochSeconds: policy.originWritersActiveFromEpochSeconds - 1,
          createdAtEqualsUpdatedAt: true,
        }),
      ],
      policy,
    );
    assert.equal(analysis.edgeCount, 2);
    assert.equal(analysis.candidates[0].candidateDegree, 2);
    assert.equal(analysis.candidates[0].classification, 'ambiguous_abstention');
    assert.equal(
      analysis.candidates.some(({ classification }) => classification === 'correction_evidence'),
      false,
    );
  });

  void it('never proposes from a reciprocal pre-origin native row', () => {
    const boundary = policy.originWritersActiveFromEpochSeconds - 1;
    const analysis = analyzeTickGroup(
      [
        tick(),
        anchor({
          origin: 'native',
          createdAtEpochSeconds: boundary,
          updatedAtEpochSeconds: boundary,
          createdAtEqualsUpdatedAt: true,
        }),
      ],
      policy,
    );
    assert.equal(analysis.edgeCount, 1);
    assert.equal(analysis.candidates[0].classification, 'heuristic_only_anchor_abstention');
  });

  void it('does not let a heuristic Kilter anchor create a post-fix control violation', () => {
    const analysis = analyzeTickGroup(
      [
        tick({ origin: 'aurora_pull', auroraSyncedAtEpochSeconds: 250 }),
        anchor({ createdAtEpochSeconds: policy.originWritersActiveFromEpochSeconds - 1 }),
      ],
      policy,
    );
    assert.equal(analysis.candidates[0].classification, 'heuristic_only_anchor_abstention');
  });

  void it('allows only an unchanged post-boundary native anchor to support a proposal', () => {
    const unchangedNative = anchor({
      origin: 'native',
      createdAtEpochSeconds: policy.nativeSafeGenerationActiveFromEpochSeconds,
      updatedAtEpochSeconds: policy.nativeSafeGenerationActiveFromEpochSeconds,
      createdAtEqualsUpdatedAt: true,
    });
    const analysis = analyzeTickGroup([tick(), unchangedNative], policy);
    assert.equal(analysis.candidates[0].classification, 'correction_evidence');
  });

  void it('keeps an edited post-boundary native anchor in the graph but abstains', () => {
    const editedNative = anchor({
      origin: 'native',
      createdAtEpochSeconds: policy.nativeSafeGenerationActiveFromEpochSeconds,
      updatedAtEpochSeconds: policy.nativeSafeGenerationActiveFromEpochSeconds + 1,
      createdAtEqualsUpdatedAt: false,
    });
    const analysis = analyzeTickGroup([tick(), editedNative], policy);
    assert.equal(analysis.edgeCount, 1);
    assert.equal(analysis.candidates[0].reciprocal, true);
    assert.equal(analysis.candidates[0].classification, 'native_timestamp_unverified_anchor_abstention');
  });

  void it('lets an edited native anchor keep a clean Kilter anchor ambiguous', () => {
    const analysis = analyzeTickGroup(
      [
        tick(),
        anchor({ id: 'clean', uuid: 'clean' }),
        anchor({
          id: 'edited-native',
          uuid: 'edited-native',
          origin: 'native',
          climbedAtEpochSeconds: 10 * HOUR + 1,
          createdAtEpochSeconds: policy.nativeSafeGenerationActiveFromEpochSeconds,
          updatedAtEpochSeconds: policy.nativeSafeGenerationActiveFromEpochSeconds + 1,
          createdAtEqualsUpdatedAt: false,
        }),
      ],
      policy,
    );
    assert.equal(analysis.edgeCount, 2);
    assert.equal(analysis.candidates[0].classification, 'ambiguous_abstention');
  });

  void it('does not let an edited native anchor create a post-fix control violation', () => {
    const analysis = analyzeTickGroup(
      [
        tick({ origin: 'aurora_pull', auroraSyncedAtEpochSeconds: 250 }),
        anchor({
          origin: 'native',
          createdAtEpochSeconds: policy.nativeSafeGenerationActiveFromEpochSeconds,
          updatedAtEpochSeconds: policy.nativeSafeGenerationActiveFromEpochSeconds + 1,
          createdAtEqualsUpdatedAt: false,
        }),
      ],
      policy,
    );
    assert.equal(analysis.candidates[0].classification, 'native_timestamp_unverified_anchor_abstention');
  });

  void it('does not count an edited native anchor as an aligned control', () => {
    const nativeClimbedAt = 10 * HOUR;
    const analysis = analyzeTickGroup(
      [
        tick({ climbedAtEpochSeconds: nativeClimbedAt }),
        anchor({
          origin: 'native',
          climbedAtEpochSeconds: nativeClimbedAt,
          createdAtEpochSeconds: policy.nativeSafeGenerationActiveFromEpochSeconds,
          updatedAtEpochSeconds: policy.nativeSafeGenerationActiveFromEpochSeconds + 1,
          createdAtEqualsUpdatedAt: false,
        }),
      ],
      policy,
    );
    assert.equal(analysis.candidates[0].classification, 'native_timestamp_unverified_anchor_abstention');
  });

  void it('retains a pre-safe-save native anchor for ambiguity but never proposes from it', () => {
    const analysis = analyzeTickGroup(
      [
        tick(),
        anchor({
          origin: 'native',
          createdAtEpochSeconds: policy.nativeSafeGenerationActiveFromEpochSeconds - 1,
          updatedAtEpochSeconds: policy.nativeSafeGenerationActiveFromEpochSeconds - 1,
          createdAtEqualsUpdatedAt: true,
        }),
      ],
      policy,
    );
    assert.equal(analysis.edgeCount, 1);
    assert.equal(analysis.candidates[0].classification, 'native_timestamp_unverified_anchor_abstention');
  });

  void it('counts a dense ambiguity graph without retaining its quadratic edge set', () => {
    const nodeCount = 300;
    const candidates = Array.from({ length: nodeCount }, (_, index) =>
      tick({ id: `candidate-${index}`, uuid: `candidate-${index}` }),
    );
    const anchors = Array.from({ length: nodeCount }, (_, index) =>
      anchor({ id: `anchor-${index}`, uuid: `anchor-${index}` }),
    );
    const analysis = analyzeTickGroup([...candidates, ...anchors], policy);
    assert.equal(analysis.edgeCount, nodeCount * nodeCount);
    assert.equal('edges' in analysis, false);
    assert.ok(
      analysis.candidates.every(
        (candidate) => candidate.candidateDegree === nodeCount && candidate.classification === 'ambiguous_abstention',
      ),
    );
  });
});

void describe('artifact primitives', () => {
  void it('canonicalizes object keys recursively', () => {
    assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  });

  void it('rejects raw identifiers, comments, session ids, and DSNs', () => {
    for (const unsafe of [
      { userId: 'raw' },
      { user_id: 'raw' },
      { uuid: 'raw' },
      { candidate_uuid: 'raw' },
      { comment: 'beta' },
      { sessionId: 'raw' },
      { note: 'postgres://user:password@host/db' },
    ]) {
      assert.throws(() => assertPrivacySafeRecord(unsafe));
    }
    assert.doesNotThrow(() => assertPrivacySafeRecord({ user_key: 'pseudo', candidate_key: 'pseudo' }));
  });

  void it('redacts nonzero small aggregate cells', () => {
    assert.equal(redactSmallCell(0), 0);
    assert.equal(redactSmallCell(1), '<5');
    assert.equal(redactSmallCell(4), '<5');
    assert.equal(redactSmallCell(5), 5);
  });

  void it('keeps pseudonyms stable only within one run secret', () => {
    const firstRunSecret = new Uint8Array(32).fill(1);
    const secondRunSecret = new Uint8Array(32).fill(2);
    const firstPseudonym = pseudonymize(firstRunSecret, 'tick', 'raw-tick-id');
    assert.equal(pseudonymize(firstRunSecret, 'tick', 'raw-tick-id'), firstPseudonym);
    assert.notEqual(pseudonymize(secondRunSecret, 'tick', 'raw-tick-id'), firstPseudonym);
  });
});
