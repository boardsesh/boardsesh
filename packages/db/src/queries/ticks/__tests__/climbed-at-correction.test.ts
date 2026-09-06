import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOffsetProfiles,
  bucketKeyOf,
  calendarQuarterOf,
  classifyAllSuspects,
  classifySuspect,
  indexAnchorsByNaturalKey,
  suspectAnchorLookupKey,
  type AnchorTick,
  type SuspectTick,
} from '../climbed-at-correction';

const HOUR_SECONDS = 60 * 60;

function anchor(climb: string, iso: string, overrides: Partial<AnchorTick> = {}): AnchorTick {
  return {
    userId: 'u1',
    boardType: 'kilter',
    canonicalClimbUuid: climb,
    angle: 40,
    climbedAtMs: Date.parse(iso),
    trust: 'native',
    ...overrides,
  };
}

function suspect(uuid: string, climb: string, iso: string, overrides: Partial<SuspectTick> = {}): SuspectTick {
  return {
    uuid,
    userId: 'u1',
    boardType: 'kilter',
    canonicalClimbUuid: climb,
    angle: 40,
    climbedAtMs: Date.parse(iso),
    origin: 'json_import',
    isAuroraTwinMember: false,
    ...overrides,
  };
}

/** Shift an ISO instant by whole hours, for building a +Xh shifted suspect. */
function shifted(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * HOUR_SECONDS * 1000).toISOString();
}

function verdictOf(suspects: SuspectTick[], anchors: AnchorTick[], uuid: string) {
  const decision = classifyAllSuspects(anchors, suspects).find((entry) => entry.suspect.uuid === uuid);
  assert.ok(decision, `no decision for ${uuid}`);
  return decision.verdict;
}

describe('classifySuspect — the per-row already-correct guard', () => {
  // THE case. inferUserUtcOffsetSeconds is documented as robust to a bucket of
  // mixed honest+shifted history, which is exactly what makes a bucket median
  // dangerous as a blanket correction: an already-correct row survives the
  // median and would then be shifted BY it. #3909 measured ~3% already aligned.
  it('leaves a row that already matches its own anchor alone, even in a +10h bucket', () => {
    const base = '2026-02-01T10:00:00Z';
    const anchors = [
      anchor('c1', base),
      anchor('c2', '2026-02-02T10:00:00Z'),
      anchor('c3', '2026-02-03T10:00:00Z'),
      anchor('c4', '2026-02-04T10:00:00Z'),
    ];
    const suspects = [
      // Three genuinely shifted rows drive the bucket median to +10h…
      suspect('s2', 'c2', shifted('2026-02-02T10:00:00Z', 10)),
      suspect('s3', 'c3', shifted('2026-02-03T10:00:00Z', 10)),
      suspect('s4', 'c4', shifted('2026-02-04T10:00:00Z', 10)),
      // …and this one is already correct, 3 seconds off its own anchor.
      suspect('s1', 'c1', new Date(Date.parse(base) + 3000).toISOString()),
    ];

    const verdict = verdictOf(suspects, anchors, 's1');
    assert.equal(verdict.verdict, 'already-correct');
    assert.equal(verdict.verdict === 'already-correct' ? verdict.reason : null, 'row-matches-own-anchor');
  });

  it('still corrects the genuinely shifted members of that same bucket', () => {
    const anchors = [
      anchor('c1', '2026-02-01T10:00:00Z'),
      anchor('c2', '2026-02-02T10:00:00Z'),
      anchor('c3', '2026-02-03T10:00:00Z'),
      anchor('c4', '2026-02-04T10:00:00Z'),
    ];
    const suspects = [
      suspect('s2', 'c2', shifted('2026-02-02T10:00:00Z', 10)),
      suspect('s3', 'c3', shifted('2026-02-03T10:00:00Z', 10)),
      suspect('s4', 'c4', shifted('2026-02-04T10:00:00Z', 10)),
      suspect('s1', 'c1', new Date(Date.parse('2026-02-01T10:00:00Z') + 3000).toISOString()),
    ];

    const verdict = verdictOf(suspects, anchors, 's3');
    assert.equal(verdict.verdict, 'shift');
    if (verdict.verdict !== 'shift') return;
    assert.equal(verdict.offsetSeconds, 10 * HOUR_SECONDS);
    assert.equal(verdict.correctedMs, Date.parse(shifted('2026-02-03T10:00:00Z', 10)) - 10 * HOUR_SECONDS * 1000);
    assert.equal(new Date(verdict.correctedMs).toISOString(), '2026-02-03T10:00:00.000Z');
  });

  it('checks the guard before the profile, not after', () => {
    // Direct call with a hand-built +10h profile, to prove the ordering rather
    // than relying on classifyAllSuspects to build a bucket that happens to.
    const target = suspect('s1', 'c1', '2026-02-01T10:00:30Z');
    const anchors = [anchor('c1', '2026-02-01T10:00:00Z')];
    const verdict = classifySuspect(
      target,
      {
        userId: 'u1',
        boardType: 'kilter',
        quarter: '2026-Q1',
        offsetSeconds: 10 * HOUR_SECONDS,
        anchorKeyCount: 9,
        medianAbsoluteDeviationSeconds: 0,
        anchorTrust: 'native',
        perKeyDeltasSeconds: [],
      },
      anchors,
    );
    assert.equal(verdict.verdict, 'already-correct');
  });
});

describe('classifySuspect — abstain rules', () => {
  it('abstains with no-anchor when the climber has no honest rows at all', () => {
    const suspects = [suspect('s1', 'c1', '2026-02-01T20:00:00Z')];
    const verdict = verdictOf(suspects, [], 's1');
    assert.deepEqual(verdict, { verdict: 'abstain', reason: 'no-anchor' });
  });

  it('abstains with too-few-anchor-keys below three overlapping keys', () => {
    const anchors = [anchor('c1', '2026-02-01T10:00:00Z'), anchor('c2', '2026-02-02T10:00:00Z')];
    const suspects = [
      suspect('s1', 'c1', shifted('2026-02-01T10:00:00Z', 10)),
      suspect('s2', 'c2', shifted('2026-02-02T10:00:00Z', 10)),
    ];
    assert.deepEqual(verdictOf(suspects, anchors, 's1'), { verdict: 'abstain', reason: 'too-few-anchor-keys' });
  });

  it('abstains with profile-offset-zero when the bucket rounds to no shift', () => {
    const anchors = [
      anchor('c1', '2026-02-01T10:00:00Z'),
      anchor('c2', '2026-02-02T10:00:00Z'),
      anchor('c3', '2026-02-03T10:00:00Z'),
    ];
    // Every suspect is ~2 minutes off — real, but far under the 15-minute grid.
    const suspects = [
      suspect('s1', 'c1', '2026-02-01T10:02:00Z'),
      suspect('s2', 'c2', '2026-02-02T10:02:00Z'),
      suspect('s3', 'c3', '2026-02-03T10:02:00Z'),
    ];
    assert.deepEqual(verdictOf(suspects, anchors, 's1'), { verdict: 'abstain', reason: 'profile-offset-zero' });
  });

  it('abstains with inconsistent-offset when the per-key deltas disagree', () => {
    const days = ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04'];
    const anchors = days.map((day, index) => anchor(`c${index}`, `${day}T10:00:00Z`));
    const offsets = [10, 10, 3, -7];
    const suspects = days.map((day, index) =>
      suspect(`s${index}`, `c${index}`, shifted(`${day}T10:00:00Z`, offsets[index])),
    );
    assert.deepEqual(verdictOf(suspects, anchors, 's0'), { verdict: 'abstain', reason: 'inconsistent-offset' });
  });

  it('abstains with offset-implausible rather than applying a 20h shift', () => {
    const days = ['2026-02-01', '2026-02-02', '2026-02-03'];
    const anchors = days.map((day, index) => anchor(`c${index}`, `${day}T10:00:00Z`));
    // 20h gaps exceed MAX_USER_UTC_OFFSET_SECONDS so they are dropped from the
    // per-key deltas entirely — the bucket ends up with no usable evidence.
    const suspects = days.map((day, index) => suspect(`s${index}`, `c${index}`, shifted(`${day}T10:00:00Z`, 20)));
    const verdict = verdictOf(suspects, anchors, 's0');
    assert.equal(verdict.verdict, 'abstain');
    assert.equal(verdict.verdict === 'abstain' ? verdict.reason : null, 'too-few-anchor-keys');
  });

  it('abstains on an aurora-twin member so a hidden duplicate is not un-hidden', () => {
    const days = ['2026-02-01', '2026-02-02', '2026-02-03'];
    const anchors = days.map((day, index) => anchor(`c${index}`, `${day}T10:00:00Z`));
    const suspects = days.map((day, index) =>
      suspect(`s${index}`, `c${index}`, shifted(`${day}T10:00:00Z`, 10), { isAuroraTwinMember: index === 0 }),
    );
    assert.deepEqual(verdictOf(suspects, anchors, 's0'), { verdict: 'abstain', reason: 'aurora-twin-member' });
  });
});

describe('buildOffsetProfiles', () => {
  it('gives a climber whose zone changed one profile per calendar quarter', () => {
    const q1Days = ['2026-01-05', '2026-01-06', '2026-01-07'];
    const q3Days = ['2026-08-05', '2026-08-06', '2026-08-07'];
    const anchors = [
      ...q1Days.map((day, index) => anchor(`a${index}`, `${day}T10:00:00Z`)),
      ...q3Days.map((day, index) => anchor(`b${index}`, `${day}T10:00:00Z`)),
    ];
    const suspects = [
      ...q1Days.map((day, index) => suspect(`q1-${index}`, `a${index}`, shifted(`${day}T10:00:00Z`, 11))),
      ...q3Days.map((day, index) => suspect(`q3-${index}`, `b${index}`, shifted(`${day}T10:00:00Z`, 10))),
    ];

    const profiles = buildOffsetProfiles(anchors, suspects);
    assert.equal(profiles.size, 2);
    assert.equal(profiles.get(bucketKeyOf(suspects[0]))?.offsetSeconds, 11 * HOUR_SECONDS);
    assert.equal(profiles.get(bucketKeyOf(suspects[3]))?.offsetSeconds, 10 * HOUR_SECONDS);
    assert.equal(calendarQuarterOf(suspects[0].climbedAtMs), '2026-Q1');
    assert.equal(calendarQuarterOf(suspects[3].climbedAtMs), '2026-Q3');
  });

  it('survives 15-minute-grid zones: +5:45 Nepal and +9:30 Adelaide', () => {
    for (const offsetSeconds of [5 * HOUR_SECONDS + 45 * 60, 9 * HOUR_SECONDS + 30 * 60]) {
      const days = ['2026-02-01', '2026-02-02', '2026-02-03'];
      const anchors = days.map((day, index) => anchor(`c${index}`, `${day}T10:00:00Z`));
      const suspects = days.map((day, index) =>
        suspect(
          `s${index}`,
          `c${index}`,
          new Date(Date.parse(`${day}T10:00:00Z`) + offsetSeconds * 1000).toISOString(),
        ),
      );
      const verdict = verdictOf(suspects, anchors, 's0');
      assert.equal(verdict.verdict, 'shift');
      assert.equal(verdict.verdict === 'shift' ? verdict.offsetSeconds : null, offsetSeconds);
    }
  });

  it('builds from native only once a bucket has enough native anchor keys', () => {
    const days = ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04'];
    // Native anchors are honest. The kilter anchors on the SAME climbs are
    // back-dated log-creation instants an hour late; if they were mixed in they
    // would drag the median off the true offset.
    const anchors = [
      ...days.map((day, index) => anchor(`c${index}`, `${day}T10:00:00Z`, { trust: 'native' })),
      ...days.map((day, index) =>
        anchor(`c${index}`, `${day}T11:00:00Z`, { trust: 'kilter_pull', canonicalClimbUuid: `c${index}` }),
      ),
      ...days.map((day, index) => anchor(`k${index}`, `${day}T11:00:00Z`, { trust: 'kilter_pull' })),
    ];
    const suspects = days.map((day, index) => suspect(`s${index}`, `c${index}`, shifted(`${day}T10:00:00Z`, 8)));
    const profile = buildOffsetProfiles(anchors, suspects).get(bucketKeyOf(suspects[0]));
    assert.equal(profile?.anchorTrust, 'native');
    assert.equal(profile?.offsetSeconds, 8 * HOUR_SECONDS);
  });

  it('holds a kilter-only bucket to the tighter 30s consistency bar', () => {
    const days = ['2026-02-01', '2026-02-02', '2026-02-03'];
    const anchors = days.map((day, index) => anchor(`c${index}`, `${day}T10:00:00Z`, { trust: 'kilter_pull' }));
    // Deltas of 10h, 10h+45s, 10h−45s: MAD 45s — fine for a native bucket,
    // over the bar for a kilter-only one, where the gap may be back-dating.
    const jitterSeconds = [0, 45, -45];
    const suspects = days.map((day, index) =>
      suspect(
        `s${index}`,
        `c${index}`,
        new Date(Date.parse(`${day}T10:00:00Z`) + (10 * HOUR_SECONDS + jitterSeconds[index]) * 1000).toISOString(),
      ),
    );
    assert.deepEqual(verdictOf(suspects, anchors, 's0'), { verdict: 'abstain', reason: 'inconsistent-offset' });

    // The same jitter against native anchors is accepted.
    const nativeAnchors = anchors.map((entry) => ({ ...entry, trust: 'native' as const }));
    assert.equal(verdictOf(suspects, nativeAnchors, 's0').verdict, 'shift');
  });

  it('matches a suspect on an alias uuid to an anchor on the canonical uuid', () => {
    // The classifier is fed canonical uuids on BOTH sides; this is the assertion
    // that fails loudly if a caller ever passes raw climb_uuids through.
    const days = ['2026-02-01', '2026-02-02', '2026-02-03'];
    const anchors = days.map((day, index) => anchor(`canonical-${index}`, `${day}T10:00:00Z`));
    const suspects = days.map((day, index) =>
      // Stored on alias-N upstream, resolved to canonical-N before it gets here.
      suspect(`s${index}`, `canonical-${index}`, shifted(`${day}T10:00:00Z`, 10)),
    );
    assert.equal(verdictOf(suspects, anchors, 's0').verdict, 'shift');

    const unresolved = days.map((day, index) =>
      suspect(`s${index}`, `alias-${index}`, shifted(`${day}T10:00:00Z`, 10)),
    );
    assert.deepEqual(verdictOf(unresolved, anchors, 's0'), { verdict: 'abstain', reason: 'too-few-anchor-keys' });
  });
});

describe('indexAnchorsByNaturalKey', () => {
  it('keys anchors the same way suspectAnchorLookupKey looks them up', () => {
    const anchors = [anchor('c1', '2026-02-01T10:00:00Z'), anchor('c1', '2026-02-01T18:00:00Z')];
    const index = indexAnchorsByNaturalKey(anchors);
    const found = index.get(suspectAnchorLookupKey(suspect('s1', 'c1', '2026-02-01T10:00:05Z')));
    assert.equal(found?.length, 2);
  });

  it('does not bridge two different angles on the same climb', () => {
    const index = indexAnchorsByNaturalKey([anchor('c1', '2026-02-01T10:00:00Z', { angle: 45 })]);
    assert.equal(index.get(suspectAnchorLookupKey(suspect('s1', 'c1', '2026-02-01T10:00:00Z'))), undefined);
  });
});
