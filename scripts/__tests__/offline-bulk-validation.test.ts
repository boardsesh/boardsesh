import { describe, expect, it } from 'vitest';
import {
  evaluateOfflineBulkValidation,
  exactBinomialLowerBound,
  OFFLINE_BULK_TARGETS,
  parseOfflineBulkValidation,
  type BulkValidationInput,
  type BulkValidationRequest,
} from '../offline-bulk-validation';

function fixture(): BulkValidationInput {
  const releases = (['ios', 'android'] as const).map((platform) => ({
    id: `${platform}-candidate`,
    platform,
    nativeVersion: 'test-only',
    nativeBuild: 'fixture',
    runtimeVersion: `${platform}-fixture-runtime`,
    bundle: { kind: 'ota' as const, id: `${platform}-fixture-bundle` },
  }));
  const requests: BulkValidationRequest[] = releases.flatMap((release) =>
    (['automatic', 'deliberate'] as const).flatMap((cohort) =>
      Array.from({ length: 299 }, (_, index) => ({
        requestId: `${release.platform}-${cohort}-${index}`,
        batchId: `${release.platform}-${cohort}-batch-${index}`,
        personKey: `${release.platform}-${cohort}-person-${index}`,
        releaseId: release.id,
        requestedScopeCount: 1,
        scopeKey: index === 0 ? 'kilter:1:5' : 'tension:1:1',
        boardType: index === 0 ? 'kilter' : 'tension',
        trigger:
          cohort === 'deliberate'
            ? ('download-all' as const)
            : index % 2 === 0
              ? ('auto-download-all' as const)
              : ('adopt-auto' as const),
        requestedAt: '2027-01-02T00:00:00Z',
        startedAt: '2027-01-02T00:01:00Z',
        startedReleaseId: release.id,
        completedAt: '2027-01-02T00:02:00Z',
        completedReleaseId: release.id,
        outcome: 'completed' as const,
        restartCount: 0,
      })),
    ),
  );
  for (const platform of ['ios', 'android']) {
    const first = requests.find((request) => request.requestId === `${platform}-automatic-0`);
    if (!first) throw new Error('Fixture missing first request');
    first.requestedScopeCount = 2;
    requests.push({
      ...first,
      requestId: `${first.requestId}-second-scope`,
      scopeKey: 'tension:2:1',
      boardType: 'tension',
    });
  }
  return {
    schemaVersion: 1,
    evidenceType: 'production',
    studyId: 'unit-test-only',
    preregisteredAt: '2026-12-31T00:00:00Z',
    enrollmentStart: '2027-01-01T00:00:00Z',
    enrollmentEnd: '2027-01-03T00:00:00Z',
    observedThrough: '2027-01-10T00:00:00Z',
    releases,
    sourceFiltersVerified: true,
    consentDeliveryCoverageDocumented: true,
    queryEvidence: ['fixture://exact-query-and-rows'],
    requests,
    devices: releases.flatMap((release) =>
      (['auto-download-all', 'adopt-auto', 'download-all'] as const).map((trigger) => ({
        batchId: `${release.platform}-device-${trigger}`,
        releaseId: release.id,
        trigger,
        requestedScopeCount: 2,
        completedScopeCount: 2,
        offlineAvailableAfterRelaunch: true,
        heavyKilter: true,
        foreground: true,
        background: true,
        relaunch: true,
        cellular: true,
        freshDownload: true,
        cellularBytes: 200 * 1024 ** 2,
        retainedBytes: 1024 ** 3,
        peakBytes: 2 * 1024 ** 3,
        peakSampleIntervalMs: 100,
        peakCoverage: 'complete' as const,
        includesAllStorage: true,
        includesRetries: true,
        evidence: ['fixture://device-capture'],
      })),
    ),
    dependencies: [7985, 7986, 7987, 7988, 6689, 6707, 4310, 4394].map((issue) => ({
      issue,
      disposition: 'cleared' as const,
      evidence: [`fixture://disposition-${issue}`],
    })),
  };
}

function automaticIos(report: ReturnType<typeof evaluateOfflineBulkValidation>) {
  const cohort = report.cohorts.find((entry) => entry.platform === 'ios' && entry.cohort === 'automatic');
  if (!cohort) throw new Error('Missing iOS automatic cohort');
  return cohort;
}

describe('exact one-sided binomial confidence', () => {
  it('requires 299 independent all-success scope observations for the 99% lower bound', () => {
    expect(exactBinomialLowerBound(298, 298)).toBeLessThan(0.99);
    expect(exactBinomialLowerBound(299, 299)).toBeGreaterThanOrEqual(0.99);
  });

  it('requires 59 all-success people for the 95% lower bound', () => {
    expect(exactBinomialLowerBound(58, 58)).toBeLessThan(0.95);
    expect(exactBinomialLowerBound(59, 59)).toBeGreaterThanOrEqual(0.95);
  });

  it('solves partial-success bounds and handles empty samples without false confidence', () => {
    expect(exactBinomialLowerBound(1, 2)).toBeCloseTo(1 - Math.sqrt(0.95), 12);
    expect(exactBinomialLowerBound(0, 0)).toBe(0);
    expect(exactBinomialLowerBound(0, 40)).toBe(0);
    expect(() => exactBinomialLowerBound(3, 2)).toThrow();
    expect(() => exactBinomialLowerBound(1, 2, 0)).toThrow();
  });
});

describe('eligible release gate', () => {
  it('permits GO only when both platform populations, costs and dependency gates pass', () => {
    const report = evaluateOfflineBulkValidation(fixture());
    expect(report.decision).toBe('GO');
    expect(report.blockers).toEqual([]);
    expect(report.cohorts).toHaveLength(4);
  });

  it('never treats synthetic evidence as a production decision', () => {
    const input = fixture();
    input.evidenceType = 'synthetic';
    expect(evaluateOfflineBulkValidation(input).blockers).toContain('Synthetic evidence cannot authorize GO.');
  });

  it('uses a lower-inclusive upper-exclusive enrollment window', () => {
    const input = fixture();
    const original = input.requests[0];
    input.requests.push(
      {
        ...original,
        requestId: 'at-start',
        batchId: 'start-batch',
        personKey: 'boundary-person',
        requestedScopeCount: 1,
        requestedAt: input.enrollmentStart,
      },
      { ...original, requestId: 'at-end', requestedAt: input.enrollmentEnd },
      { ...original, requestId: 'before-start', requestedAt: '2026-12-31T23:59:59Z' },
    );
    const report = evaluateOfflineBulkValidation(input);
    expect(report.observations.excludedOutsideEnrollment).toBe(2);
    expect(automaticIos(report).requested).toBe(301);
  });

  it('keeps unknown receiving bundles out of eligible results and blocks GO', () => {
    const input = fixture();
    input.requests[0].releaseId = 'unknown-ota';
    const report = evaluateOfflineBulkValidation(input);
    expect(report.decision).toBe('HOLD');
    expect(report.observations.excludedUnknownRelease).toBe(1);
  });

  it('does not authorize an additional declared release with no production or device evidence', () => {
    const input = fixture();
    input.releases.push({
      ...input.releases[0],
      id: 'untested-ios',
      runtimeVersion: 'other-runtime',
      bundle: { kind: 'ota', id: 'other-ota' },
    });
    const report = evaluateOfflineBulkValidation(input);
    expect(report.decision).toBe('HOLD');
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        'Release untested-ios: fresh automatic production evidence missing.',
        'Release untested-ios: fresh automatic device evidence missing.',
      ]),
    );
  });

  it('requires preregistration, complete follow-up, query receipts and coverage disclosure', () => {
    const input = fixture();
    input.preregisteredAt = input.enrollmentStart;
    input.observedThrough = '2027-01-09T00:00:00Z';
    input.queryEvidence = [];
    input.sourceFiltersVerified = false;
    input.consentDeliveryCoverageDocumented = false;
    const report = evaluateOfflineBulkValidation(input);
    expect(report.decision).toBe('HOLD');
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        'Protocol must be preregistered before enrollment.',
        'Seven-day follow-up after enrollment closes is incomplete.',
        'Exact query evidence is missing.',
        'Consent and event-delivery coverage are undocumented.',
      ]),
    );
  });
});

describe('request-based lifecycle accounting', () => {
  it('deduplicates identical records without counting retries as new requests', () => {
    const input = fixture();
    input.requests[0].restartCount = 3;
    input.requests.push({ ...input.requests[0] });
    const report = evaluateOfflineBulkValidation(input);
    expect(report.decision).toBe('GO');
    expect(report.observations.duplicateRecords).toBe(1);
    expect(automaticIos(report)).toMatchObject({ requested: 300, restarts: 3 });
  });

  it('blocks contradictory records rather than selecting a favorable outcome', () => {
    const input = fixture();
    input.requests.push({ ...input.requests[0], completedAt: undefined });
    expect(evaluateOfflineBulkValidation(input).blockers).toContain(
      `Conflicting observations for request ${input.requests[0].requestId}.`,
    );
  });

  it('retains never-started requests in the denominator as unknown outcomes', () => {
    const input = fixture();
    delete input.requests[0].startedAt;
    delete input.requests[0].completedAt;
    const cohort = automaticIos(evaluateOfflineBulkValidation(input));
    expect(cohort).toMatchObject({ requested: 300, started: 299, completed: 299, unknown: 1, allCompletedPeople: 298 });
  });

  it('allows a recovered failure and reports genuine incomplete failures separately', () => {
    const input = fixture();
    input.requests[0].failure = 'genuine';
    input.requests[1].failure = 'genuine';
    delete input.requests[1].completedAt;
    const cohort = automaticIos(evaluateOfflineBulkValidation(input));
    expect(cohort).toMatchObject({ completed: 299, genuineFailures: 1, unknown: 0 });
  });

  it('anchors seven days to the request and reports late completion despite a restart', () => {
    const input = fixture();
    input.requests[0].startedAt = '2027-01-08T23:59:00Z';
    input.requests[0].completedAt = '2027-01-09T00:00:01Z';
    input.requests[0].restartCount = 1;
    const cohort = automaticIos(evaluateOfflineBulkValidation(input));
    expect(cohort).toMatchObject({ completed: 299, lateCompleted: 1, restarts: 1 });
  });

  it('counts completion at the exact seven-day deadline and cancellation separately', () => {
    const input = fixture();
    input.requests[0].completedAt = '2027-01-09T00:00:00Z';
    input.requests[1].cancelledAt = '2027-01-02T00:01:30Z';
    input.requests[1].outcome = 'cancelled';
    expect(automaticIos(evaluateOfflineBulkValidation(input))).toMatchObject({ completed: 299, cancelled: 1 });
  });

  it('keeps missing batch scopes in the requested denominator and blocks incomplete event delivery', () => {
    const input = fixture();
    input.requests = input.requests.filter((request) => request.requestId !== 'ios-automatic-0-second-scope');
    const report = evaluateOfflineBulkValidation(input);
    expect(report.decision).toBe('HOLD');
    expect(report.blockers).toContain(
      'Batch ios-automatic-batch-0: requested-scope count disagrees with observed unique members.',
    );
    expect(automaticIos(report)).toMatchObject({
      requested: 300,
      observedRequests: 299,
      missingRequestedScopes: 1,
      allCompletedPeople: 298,
    });
  });

  it('holds when siblings disagree about the original requested scope count', () => {
    const input = fixture();
    const sibling = input.requests.find((request) => request.requestId === 'ios-automatic-0-second-scope');
    if (!sibling) throw new Error('Fixture missing sibling');
    sibling.requestedScopeCount = 3;
    expect(evaluateOfflineBulkValidation(input).blockers).toContain(
      'Batch ios-automatic-batch-0: requested-scope count disagrees with observed unique members.',
    );
  });

  it.each(['startedReleaseId', 'completedReleaseId'] as const)(
    'holds missing or unknown %s without counting a fresh success',
    (field) => {
      for (const releaseId of [undefined, 'unlisted-bundle', 'android-candidate']) {
        const input = fixture();
        input.requests[0][field] = releaseId;
        const report = evaluateOfflineBulkValidation(input);
        expect(report.decision).toBe('HOLD');
        expect(report.blockers).toContain(
          `Request ${input.requests[0].requestId}: ${field === 'startedReleaseId' ? 'started' : 'completed'} release is missing, ineligible or on another platform.`,
        );
        expect(automaticIos(report)).toMatchObject({ requested: 300, completed: 299, freshCompleted: 299, unknown: 1 });
      }
    },
  );

  it('does not authorize download health when every fresh Started event is missing', () => {
    const input = fixture();
    for (const request of input.requests) {
      delete request.startedAt;
      delete request.startedReleaseId;
    }
    const report = evaluateOfflineBulkValidation(input);
    expect(report.decision).toBe('HOLD');
    expect(automaticIos(report)).toMatchObject({ requested: 300, started: 0, completed: 0, sampledCompleted: 0 });
    expect(report.blockers).toContain('Request ios-automatic-0: fresh completion lacks Started coverage.');
  });

  it('reports cached availability separately and excludes it from fresh confidence', () => {
    const input = fixture();
    for (const request of input.requests) {
      request.outcome = 'already_available';
      delete request.startedAt;
      delete request.startedReleaseId;
    }
    const report = evaluateOfflineBulkValidation(input);
    expect(report.decision).toBe('HOLD');
    expect(automaticIos(report)).toMatchObject({
      completed: 300,
      alreadyAvailable: 300,
      freshCompleted: 0,
      freshRequested: 0,
      sampledScopes: 0,
      scopeConfidenceLower: 0,
      personConfidenceLower: 0,
    });
    expect(report.blockers).toContain('ios/automatic: scope confidence lower bound below 99%.');
  });

  it('selects one independent scope per person, stable under input reordering', () => {
    const input = fixture();
    const before = automaticIos(evaluateOfflineBulkValidation(input));
    input.requests.reverse();
    const after = automaticIos(evaluateOfflineBulkValidation(input));
    expect(before).toEqual(after);
    expect(before.sampledScopes).toBe(299);
    expect(before.requested).toBe(300);
  });

  it('holds for lifecycle timestamps before request or after observation cutoff', () => {
    const input = fixture();
    input.requests[0].startedAt = '2027-01-01T23:59:00Z';
    input.requests[1].completedAt = '2027-01-10T00:00:01Z';
    expect(evaluateOfflineBulkValidation(input).blockers).toEqual(
      expect.arrayContaining([
        `Request ${input.requests[0].requestId} has started timestamp outside observed lifecycle.`,
        `Request ${input.requests[1].requestId} has completed timestamp outside observed lifecycle.`,
      ]),
    );
  });
});

describe('device costs and integrity disposition', () => {
  it('accepts exact resource limits and holds when any cap is exceeded', () => {
    const input = fixture();
    input.devices[0].cellularBytes = OFFLINE_BULK_TARGETS.cellularBytes;
    input.devices[0].retainedBytes = OFFLINE_BULK_TARGETS.retainedBytes;
    input.devices[0].peakBytes = OFFLINE_BULK_TARGETS.peakBytes;
    expect(evaluateOfflineBulkValidation(input).decision).toBe('GO');
    input.devices[0].cellularBytes++;
    input.devices[0].retainedBytes++;
    input.devices[0].peakBytes++;
    expect(evaluateOfflineBulkValidation(input).blockers).toEqual(
      expect.arrayContaining([
        'Device batch ios-device-auto-download-all: automatic cellular traffic unknown or above 500 MiB.',
        'Device batch ios-device-auto-download-all: retained storage unknown or above 2 GiB.',
        'Device batch ios-device-auto-download-all: peak storage unknown, incompletely observed, or above 4 GiB.',
      ]),
    );
  });

  it('does not substitute omitted measurements or incomplete background sampling with zero', () => {
    const input = fixture();
    input.devices[0].cellularBytes = null;
    input.devices[0].peakCoverage = 'incomplete';
    input.devices[0].includesAllStorage = false;
    input.devices[0].includesRetries = false;
    expect(evaluateOfflineBulkValidation(input).decision).toBe('HOLD');
  });

  it.each([0, 1, null])('holds when a device completes only %s requested scopes', (completedScopeCount) => {
    const input = fixture();
    input.devices[0].completedScopeCount = completedScopeCount;
    const report = evaluateOfflineBulkValidation(input);
    expect(report.decision).toBe('HOLD');
    expect(report.blockers).toContain(
      'Device batch ios-device-auto-download-all: every requested scope must complete and remain available offline after relaunch.',
    );
  });

  it.each([false, null])('holds when offline availability after relaunch is %s', (offlineAvailableAfterRelaunch) => {
    const input = fixture();
    input.devices[0].offlineAvailableAfterRelaunch = offlineAvailableAfterRelaunch;
    const report = evaluateOfflineBulkValidation(input);
    expect(report.decision).toBe('HOLD');
    expect(report.blockers).toContain(
      'Device batch ios-device-auto-download-all: every requested scope must complete and remain available offline after relaunch.',
    );
  });

  it('does not use a cached heavy Kilter case as fresh heavy-transfer coverage', () => {
    const input = fixture();
    for (const device of input.devices) {
      if (device.releaseId !== 'ios-candidate' || device.trigger === 'download-all') continue;
      device.heavyKilter = device.trigger === 'auto-download-all';
      device.freshDownload = device.trigger !== 'auto-download-all';
    }
    expect(evaluateOfflineBulkValidation(input).blockers).toContain('ios: heavy Kilter bulk device evidence missing.');
  });

  it('requires Android device coverage, automatic heavy scopes and each trigger', () => {
    const input = fixture();
    input.devices = input.devices.filter((device) => device.releaseId !== 'android-candidate');
    const report = evaluateOfflineBulkValidation(input);
    expect(report.blockers).toContain('android: missing adopt-auto device evidence.');
    expect(report.blockers).toContain('android: heavy Kilter bulk device evidence missing.');
  });

  it('requires a linked release-specific disposition for every blocker', () => {
    const input = fixture();
    input.dependencies[0].disposition = 'unresolved';
    input.dependencies[1].evidence = [];
    expect(evaluateOfflineBulkValidation(input).blockers).toEqual(
      expect.arrayContaining([
        '#7985: release-specific disposition and evidence required.',
        '#7986: release-specific disposition and evidence required.',
      ]),
    );
  });
});

describe('additional evidence invariants', () => {
  it('requires fresh bulk cellular traffic rather than counting a cached board as a network test', () => {
    const input = fixture();
    for (const device of input.devices) device.freshDownload = false;
    expect(evaluateOfflineBulkValidation(input).blockers).toContain(
      'ios: fresh automatic bulk cellular evidence missing.',
    );
    input.devices[0].freshDownload = true;
    input.devices[0].cellularBytes = 0;
    expect(evaluateOfflineBulkValidation(input).blockers).toContain(
      'Device batch ios-device-auto-download-all: fresh cellular download has no measured traffic.',
    );
  });

  it('requires fresh downloads for background and relaunch scenarios instead of borrowing cached cases', () => {
    const input = fixture();
    const automaticDevices = input.devices.filter((device) => device.trigger !== 'download-all');
    for (const device of automaticDevices) {
      device.background = false;
      device.relaunch = false;
      input.devices.push({
        ...device,
        batchId: `${device.batchId}-cached-lifecycle`,
        freshDownload: false,
        background: true,
        relaunch: true,
      });
    }
    const report = evaluateOfflineBulkValidation(input);
    expect(report.decision).toBe('HOLD');
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        'ios: automatic background device coverage missing.',
        'ios: automatic relaunch device coverage missing.',
        'android: automatic background device coverage missing.',
        'android: automatic relaunch device coverage missing.',
      ]),
    );
  });

  it('requires fresh production and device evidence for each automatic trigger despite sufficient other-trigger confidence', () => {
    const input = fixture();
    const adoptedRequests = input.requests.filter((request) => request.trigger === 'adopt-auto');
    for (const request of adoptedRequests) {
      // Keep 299 independent fresh people per platform, all from the other
      // trigger, so statistical confidence cannot hide missing fresh adoption.
      input.requests.push({
        ...request,
        requestId: `${request.requestId}-fresh-other-trigger`,
        batchId: `${request.batchId}-fresh-other-trigger`,
        personKey: `${request.personKey}-fresh-other-trigger`,
        trigger: 'auto-download-all',
      });
      request.outcome = 'already_available';
      delete request.startedAt;
      delete request.startedReleaseId;
    }
    for (const device of input.devices) {
      if (device.trigger === 'adopt-auto') device.freshDownload = false;
    }
    const report = evaluateOfflineBulkValidation(input);
    expect(report.decision).toBe('HOLD');
    expect(automaticIos(report).scopeConfidenceLower).toBeGreaterThanOrEqual(0.99);
    expect(automaticIos(report).personConfidenceLower).toBeGreaterThanOrEqual(0.95);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        'ios: missing fresh production adopt-auto requests.',
        'android: missing fresh production adopt-auto requests.',
        'ios: missing adopt-auto device evidence.',
        'android: missing adopt-auto device evidence.',
      ]),
    );
  });

  it('rejects repeated scope identities or mixed people inside one random batch identity', () => {
    const input = fixture();
    input.requests.push({ ...input.requests[0], requestId: 'duplicate-scope' });
    input.requests.push({
      ...input.requests[0],
      requestId: 'wrong-person',
      personKey: 'someone-else',
      scopeKey: 'moonboard:1:1',
    });
    expect(evaluateOfflineBulkValidation(input).blockers).toEqual(
      expect.arrayContaining([
        `Batch ${input.requests[0].batchId}: repeated scope with different request IDs.`,
        `Batch ${input.requests[0].batchId}: inconsistent person, release or trigger.`,
      ]),
    );
  });

  it('reports deliberate production requests without adding an automatic-default confidence gate', () => {
    const input = fixture();
    input.requests = input.requests.filter((request) => request.trigger !== 'download-all');
    expect(evaluateOfflineBulkValidation(input).decision).toBe('GO');
  });

  it('rejects multiple cost snapshots masquerading as consolidated evidence for one batch', () => {
    const input = fixture();
    input.devices.push({ ...input.devices[0] });
    expect(evaluateOfflineBulkValidation(input).blockers).toContain(
      'Device batch ios-device-auto-download-all: duplicate batch resource measurements.',
    );
  });
});

describe('untrusted evidence input', () => {
  it('rejects missing native/runtime identity, malformed timestamps and unknown fields', () => {
    const input = fixture();
    expect(() => parseOfflineBulkValidation({ ...input, unexpected: true })).toThrow('unexpected field');
    expect(() => parseOfflineBulkValidation({ ...input, enrollmentStart: '2027-02-30T00:00:00Z' })).toThrow(
      'invalid calendar',
    );
    input.releases[0].runtimeVersion = '';
    expect(() => parseOfflineBulkValidation(input)).toThrow('runtimeVersion');
  });

  it('rejects negative resource counts and malformed booleans', () => {
    const input = fixture();
    input.devices[0].peakBytes = -1;
    expect(() => parseOfflineBulkValidation(input)).toThrow('nonnegative safe integer');
    expect(() => parseOfflineBulkValidation({ ...fixture(), sourceFiltersVerified: 'true' })).toThrow(
      'expected boolean',
    );
  });
});
