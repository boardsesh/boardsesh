/// <reference types="node" />

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DAY_MS = 86_400_000;
const FOLLOW_UP_MS = 7 * DAY_MS;
const AUTOMATIC_TRIGGERS = ['auto-download-all', 'adopt-auto'] as const;
const PLATFORMS = ['ios', 'android'] as const;
const REQUIRED_DEPENDENCIES = [7985, 7986, 7987, 7988, 6689, 6707, 4310, 4394] as const;
export const OFFLINE_BULK_TARGETS = {
  scopeCompletion: 0.99,
  personCompletion: 0.95,
  confidence: 0.95,
  cellularBytes: 500 * 1024 ** 2,
  retainedBytes: 2 * 1024 ** 3,
  peakBytes: 4 * 1024 ** 3,
} as const;

type Platform = (typeof PLATFORMS)[number];
type Trigger = (typeof AUTOMATIC_TRIGGERS)[number] | 'download-all';
type Release = {
  id: string;
  platform: Platform;
  nativeVersion: string;
  nativeBuild: string;
  runtimeVersion: string;
  bundle: { kind: 'ota' | 'embedded'; id: string };
};
export type BulkValidationRequest = {
  requestId: string;
  batchId: string;
  personKey: string;
  releaseId: string;
  scopeKey: string;
  boardType: string;
  trigger: Trigger;
  requestedScopeCount: number;
  requestedAt: string;
  startedAt?: string;
  startedReleaseId?: string;
  completedAt?: string;
  completedReleaseId?: string;
  outcome?: 'completed' | 'already_available' | 'cancelled';
  cancelledAt?: string;
  failure?: 'expected' | 'genuine' | 'unknown';
  restartCount: number;
};
type DeviceEvidence = {
  batchId: string;
  releaseId: string;
  trigger: Trigger;
  requestedScopeCount: number;
  completedScopeCount: number | null;
  offlineAvailableAfterRelaunch: boolean | null;
  heavyKilter: boolean;
  foreground: boolean;
  background: boolean;
  relaunch: boolean;
  cellular: boolean;
  freshDownload: boolean;
  cellularBytes: number | null;
  retainedBytes: number | null;
  peakBytes: number | null;
  peakSampleIntervalMs: number | null;
  peakCoverage: 'complete' | 'incomplete' | 'unknown';
  includesAllStorage: boolean;
  includesRetries: boolean;
  evidence: string[];
};
export type BulkValidationInput = {
  schemaVersion: 1;
  evidenceType: 'production' | 'synthetic';
  studyId: string;
  preregisteredAt: string;
  enrollmentStart: string;
  enrollmentEnd: string;
  observedThrough: string;
  releases: Release[];
  sourceFiltersVerified: boolean;
  consentDeliveryCoverageDocumented: boolean;
  queryEvidence: string[];
  requests: BulkValidationRequest[];
  devices: DeviceEvidence[];
  dependencies: { issue: number; disposition: 'cleared' | 'not-applicable' | 'unresolved'; evidence: string[] }[];
};

function record(input: unknown, location: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error(`${location}: expected object`);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new Error(`${location}.${key}: unexpected field`);
  }
  return input as Record<string, unknown>;
}
function string(input: unknown, location: string): string {
  if (typeof input !== 'string' || input.trim() === '') throw new Error(`${location}: expected nonempty string`);
  return input;
}
function boolean(input: unknown, location: string): boolean {
  if (typeof input !== 'boolean') throw new Error(`${location}: expected boolean`);
  return input;
}
function integer(input: unknown, location: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw new Error(`${location}: expected nonnegative safe integer`);
  }
  return input;
}
function nullableInteger(input: unknown, location: string): number | null {
  return input === null ? null : integer(input, location);
}
function timestamp(input: unknown, location: string): string {
  const text = string(input, location);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new Error(`${location}: expected UTC ISO timestamp`);
  }
  if (new Date(text).toISOString().replace('.000Z', 'Z') !== text.replace('.000Z', 'Z')) {
    throw new Error(`${location}: invalid calendar timestamp`);
  }
  return text;
}
function enumeration<const Options extends readonly string[]>(
  input: unknown,
  options: Options,
  location: string,
): Options[number] {
  const text = string(input, location);
  if (!options.includes(text)) throw new Error(`${location}: expected ${options.join(', ')}`);
  return text;
}
function array<T>(input: unknown, location: string, parse: (entry: unknown, location: string) => T): T[] {
  if (!Array.isArray(input)) throw new Error(`${location}: expected array`);
  return input.map((entry: unknown, index: number) => parse(entry, `${location}[${index}]`));
}
const strings = (input: unknown, location: string): string[] => array(input, location, string);

export function parseOfflineBulkValidation(input: unknown): BulkValidationInput {
  const root = record(input, 'input', [
    'schemaVersion',
    'evidenceType',
    'studyId',
    'preregisteredAt',
    'enrollmentStart',
    'enrollmentEnd',
    'observedThrough',
    'releases',
    'sourceFiltersVerified',
    'consentDeliveryCoverageDocumented',
    'queryEvidence',
    'requests',
    'devices',
    'dependencies',
  ]);
  if (root.schemaVersion !== 1) throw new Error('input.schemaVersion: expected 1');
  const triggers = [...AUTOMATIC_TRIGGERS, 'download-all'] as const;
  return {
    schemaVersion: 1,
    evidenceType: enumeration(root.evidenceType, ['production', 'synthetic'] as const, 'input.evidenceType'),
    studyId: string(root.studyId, 'input.studyId'),
    preregisteredAt: timestamp(root.preregisteredAt, 'input.preregisteredAt'),
    enrollmentStart: timestamp(root.enrollmentStart, 'input.enrollmentStart'),
    enrollmentEnd: timestamp(root.enrollmentEnd, 'input.enrollmentEnd'),
    observedThrough: timestamp(root.observedThrough, 'input.observedThrough'),
    sourceFiltersVerified: boolean(root.sourceFiltersVerified, 'input.sourceFiltersVerified'),
    consentDeliveryCoverageDocumented: boolean(
      root.consentDeliveryCoverageDocumented,
      'input.consentDeliveryCoverageDocumented',
    ),
    queryEvidence: strings(root.queryEvidence, 'input.queryEvidence'),
    releases: array(root.releases, 'input.releases', (entry, location) => {
      const release = record(entry, location, [
        'id',
        'platform',
        'nativeVersion',
        'nativeBuild',
        'runtimeVersion',
        'bundle',
      ]);
      const bundle = record(release.bundle, `${location}.bundle`, ['kind', 'id']);
      return {
        id: string(release.id, `${location}.id`),
        platform: enumeration(release.platform, PLATFORMS, `${location}.platform`),
        nativeVersion: string(release.nativeVersion, `${location}.nativeVersion`),
        nativeBuild: string(release.nativeBuild, `${location}.nativeBuild`),
        runtimeVersion: string(release.runtimeVersion, `${location}.runtimeVersion`),
        bundle: {
          kind: enumeration(bundle.kind, ['ota', 'embedded'] as const, `${location}.bundle.kind`),
          id: string(bundle.id, `${location}.bundle.id`),
        },
      };
    }),
    requests: array(root.requests, 'input.requests', (entry, location) => {
      const request = record(entry, location, [
        'requestId',
        'batchId',
        'personKey',
        'releaseId',
        'scopeKey',
        'boardType',
        'trigger',
        'requestedScopeCount',
        'requestedAt',
        'startedAt',
        'startedReleaseId',
        'completedAt',
        'completedReleaseId',
        'outcome',
        'cancelledAt',
        'failure',
        'restartCount',
      ]);
      return {
        requestId: string(request.requestId, `${location}.requestId`),
        batchId: string(request.batchId, `${location}.batchId`),
        personKey: string(request.personKey, `${location}.personKey`),
        releaseId: string(request.releaseId, `${location}.releaseId`),
        scopeKey: string(request.scopeKey, `${location}.scopeKey`),
        boardType: string(request.boardType, `${location}.boardType`),
        trigger: enumeration(request.trigger, triggers, `${location}.trigger`),
        requestedScopeCount: integer(request.requestedScopeCount, `${location}.requestedScopeCount`),
        requestedAt: timestamp(request.requestedAt, `${location}.requestedAt`),
        ...(request.startedAt === undefined
          ? {}
          : { startedAt: timestamp(request.startedAt, `${location}.startedAt`) }),
        ...(request.startedReleaseId === undefined
          ? {}
          : { startedReleaseId: string(request.startedReleaseId, `${location}.startedReleaseId`) }),
        ...(request.completedAt === undefined
          ? {}
          : { completedAt: timestamp(request.completedAt, `${location}.completedAt`) }),
        ...(request.completedReleaseId === undefined
          ? {}
          : { completedReleaseId: string(request.completedReleaseId, `${location}.completedReleaseId`) }),
        ...(request.outcome === undefined
          ? {}
          : {
              outcome: enumeration(
                request.outcome,
                ['completed', 'already_available', 'cancelled'] as const,
                `${location}.outcome`,
              ),
            }),
        ...(request.cancelledAt === undefined
          ? {}
          : { cancelledAt: timestamp(request.cancelledAt, `${location}.cancelledAt`) }),
        ...(request.failure === undefined
          ? {}
          : {
              failure: enumeration(request.failure, ['expected', 'genuine', 'unknown'] as const, `${location}.failure`),
            }),
        restartCount: integer(request.restartCount, `${location}.restartCount`),
      };
    }),
    devices: array(root.devices, 'input.devices', (entry, location) => {
      const device = record(entry, location, [
        'batchId',
        'releaseId',
        'trigger',
        'requestedScopeCount',
        'completedScopeCount',
        'offlineAvailableAfterRelaunch',
        'heavyKilter',
        'foreground',
        'background',
        'relaunch',
        'cellular',
        'freshDownload',
        'cellularBytes',
        'retainedBytes',
        'peakBytes',
        'peakSampleIntervalMs',
        'peakCoverage',
        'includesAllStorage',
        'includesRetries',
        'evidence',
      ]);
      return {
        batchId: string(device.batchId, `${location}.batchId`),
        releaseId: string(device.releaseId, `${location}.releaseId`),
        trigger: enumeration(device.trigger, triggers, `${location}.trigger`),
        requestedScopeCount: integer(device.requestedScopeCount, `${location}.requestedScopeCount`),
        completedScopeCount: nullableInteger(device.completedScopeCount, `${location}.completedScopeCount`),
        offlineAvailableAfterRelaunch:
          device.offlineAvailableAfterRelaunch === null
            ? null
            : boolean(device.offlineAvailableAfterRelaunch, `${location}.offlineAvailableAfterRelaunch`),
        heavyKilter: boolean(device.heavyKilter, `${location}.heavyKilter`),
        foreground: boolean(device.foreground, `${location}.foreground`),
        background: boolean(device.background, `${location}.background`),
        relaunch: boolean(device.relaunch, `${location}.relaunch`),
        cellular: boolean(device.cellular, `${location}.cellular`),
        freshDownload: boolean(device.freshDownload, `${location}.freshDownload`),
        cellularBytes: nullableInteger(device.cellularBytes, `${location}.cellularBytes`),
        retainedBytes: nullableInteger(device.retainedBytes, `${location}.retainedBytes`),
        peakBytes: nullableInteger(device.peakBytes, `${location}.peakBytes`),
        peakSampleIntervalMs: nullableInteger(device.peakSampleIntervalMs, `${location}.peakSampleIntervalMs`),
        peakCoverage: enumeration(
          device.peakCoverage,
          ['complete', 'incomplete', 'unknown'] as const,
          `${location}.peakCoverage`,
        ),
        includesAllStorage: boolean(device.includesAllStorage, `${location}.includesAllStorage`),
        includesRetries: boolean(device.includesRetries, `${location}.includesRetries`),
        evidence: strings(device.evidence, `${location}.evidence`),
      };
    }),
    dependencies: array(root.dependencies, 'input.dependencies', (entry, location) => {
      const dependency = record(entry, location, ['issue', 'disposition', 'evidence']);
      return {
        issue: integer(dependency.issue, `${location}.issue`),
        disposition: enumeration(
          dependency.disposition,
          ['cleared', 'not-applicable', 'unresolved'] as const,
          `${location}.disposition`,
        ),
        evidence: strings(dependency.evidence, `${location}.evidence`),
      };
    }),
  };
}

/** Exact one-sided Clopper–Pearson lower bound, solving P(Binomial(n,p) >= k) = alpha. */
export function exactBinomialLowerBound(successes: number, trials: number, alpha = 0.05): number {
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(trials) ||
    successes < 0 ||
    trials < successes ||
    !(alpha > 0 && alpha < 1)
  ) {
    throw new Error('Invalid binomial confidence inputs');
  }
  if (successes === 0 || trials === 0) return 0;
  if (successes === trials) return alpha ** (1 / trials);
  let logCombination = 0;
  for (let index = 1; index <= Math.min(successes, trials - successes); index++) {
    logCombination += Math.log(trials - index + 1) - Math.log(index);
  }
  const upperTail = (probability: number): number => {
    let logTerm = logCombination + successes * Math.log(probability) + (trials - successes) * Math.log1p(-probability);
    let logSum = logTerm;
    for (let count = successes; count < trials; count++) {
      logTerm += Math.log(trials - count) - Math.log(count + 1) + Math.log(probability) - Math.log1p(-probability);
      const larger = Math.max(logTerm, logSum);
      logSum = larger + Math.log1p(Math.exp(Math.min(logTerm, logSum) - larger));
    }
    return Math.min(1, Math.exp(logSum));
  };
  let lower = 0;
  let upper = successes / trials;
  for (let iteration = 0; iteration < 70; iteration++) {
    const midpoint = (lower + upper) / 2;
    if (upperTail(midpoint) < alpha) lower = midpoint;
    else upper = midpoint;
  }
  return (lower + upper) / 2;
}

function lifecycleReleaseMatches(
  request: BulkValidationRequest,
  executingReleaseId: string | undefined,
  releases: ReadonlyMap<string, Release>,
): boolean {
  const requestingRelease = releases.get(request.releaseId);
  const executingRelease = executingReleaseId === undefined ? undefined : releases.get(executingReleaseId);
  return (
    requestingRelease !== undefined &&
    executingRelease !== undefined &&
    requestingRelease.platform === executingRelease.platform
  );
}
function completesInTime(
  request: BulkValidationRequest,
  observedThrough: number,
  releases: ReadonlyMap<string, Release>,
): boolean {
  if (request.completedAt === undefined || !lifecycleReleaseMatches(request, request.completedReleaseId, releases))
    return false;
  if (request.outcome !== 'completed' && request.outcome !== 'already_available') return false;
  if (
    request.outcome === 'completed' &&
    (request.startedAt === undefined || !lifecycleReleaseMatches(request, request.startedReleaseId, releases))
  )
    return false;
  const completed = Date.parse(request.completedAt);
  const requested = Date.parse(request.requestedAt);
  return (
    completed >= requested &&
    completed <= requested + FOLLOW_UP_MS &&
    completed <= observedThrough &&
    (request.cancelledAt === undefined || completed < Date.parse(request.cancelledAt))
  );
}
function expectedRequests(requests: BulkValidationRequest[]): number {
  const batches = new Map<string, number>();
  for (const request of requests)
    batches.set(request.batchId, Math.max(batches.get(request.batchId) ?? 0, request.requestedScopeCount));
  return [...batches.values()].reduce((total, count) => total + count, 0);
}
function cohortSummary(
  requests: BulkValidationRequest[],
  observedThrough: number,
  releases: ReadonlyMap<string, Release>,
) {
  const people = new Map<string, BulkValidationRequest[]>();
  const freshPeople = new Map<string, BulkValidationRequest[]>();
  const freshRequests = requests.filter((request) => request.outcome !== 'already_available');
  for (const request of requests) {
    const personRequests = people.get(request.personKey) ?? [];
    personRequests.push(request);
    people.set(request.personKey, personRequests);
  }
  for (const request of freshRequests) {
    const personRequests = freshPeople.get(request.personKey) ?? [];
    personRequests.push(request);
    freshPeople.set(request.personKey, personRequests);
  }
  const succeeds = (request: BulkValidationRequest): boolean => completesInTime(request, observedThrough, releases);
  const selected = [...freshPeople.values()].map((personRequests) =>
    personRequests.reduce((chosen, request) => {
      const chosenHash = createHash('sha256').update(chosen.requestId).digest('hex');
      const candidateHash = createHash('sha256').update(request.requestId).digest('hex');
      return candidateHash < chosenHash ? request : chosen;
    }),
  );
  const completed = requests.filter(succeeds).length;
  const requested = Math.max(requests.length, expectedRequests(requests));
  const allCompletedPeople = [...people.values()].filter(
    (personRequests) => personRequests.length === expectedRequests(personRequests) && personRequests.every(succeeds),
  ).length;
  const freshAllCompletedPeople = [...freshPeople.entries()].filter(([personKey, personRequests]) => {
    const allRequests = people.get(personKey) ?? [];
    return allRequests.length === expectedRequests(allRequests) && personRequests.every(succeeds);
  }).length;
  const sampledCompleted = selected.filter(succeeds).length;
  return {
    requested,
    observedRequests: requests.length,
    missingRequestedScopes: requested - requests.length,
    started: requests.filter(
      (request) =>
        request.startedAt !== undefined &&
        Date.parse(request.startedAt) <= observedThrough &&
        lifecycleReleaseMatches(request, request.startedReleaseId, releases),
    ).length,
    completed,
    freshCompleted: freshRequests.filter(succeeds).length,
    alreadyAvailable: requests.filter((request) => request.outcome === 'already_available' && succeeds(request)).length,
    completionRate: requested === 0 ? 0 : completed / requested,
    people: people.size,
    allCompletedPeople,
    allCompletedPeopleRate: people.size === 0 ? 0 : allCompletedPeople / people.size,
    freshRequested: freshRequests.length,
    freshPeople: freshPeople.size,
    freshAllCompletedPeople,
    freshAllCompletedPeopleRate: freshPeople.size === 0 ? 0 : freshAllCompletedPeople / freshPeople.size,
    sampledScopes: selected.length,
    sampledCompleted,
    scopeConfidenceLower: exactBinomialLowerBound(sampledCompleted, selected.length),
    personConfidenceLower: exactBinomialLowerBound(freshAllCompletedPeople, freshPeople.size),
    restarts: requests.reduce((total, request) => total + request.restartCount, 0),
    cancelled: requests.filter(
      (request) =>
        request.outcome === 'cancelled' &&
        request.cancelledAt !== undefined &&
        Date.parse(request.cancelledAt) <= observedThrough,
    ).length,
    genuineFailures: requests.filter((request) => request.failure === 'genuine' && !succeeds(request)).length,
    pending: requests.filter(
      (request) =>
        !succeeds(request) &&
        request.completedAt === undefined &&
        request.cancelledAt === undefined &&
        request.startedAt !== undefined &&
        request.failure !== 'genuine' &&
        request.failure !== 'unknown',
    ).length,
    unknown:
      requested -
      requests.length +
      requests.filter(
        (request) =>
          !succeeds(request) &&
          request.cancelledAt === undefined &&
          request.failure !== 'genuine' &&
          (request.startedAt === undefined ||
            request.failure === 'unknown' ||
            (request.completedAt !== undefined &&
              (request.outcome === undefined ||
                !lifecycleReleaseMatches(request, request.completedReleaseId, releases) ||
                !lifecycleReleaseMatches(request, request.startedReleaseId, releases)))),
      ).length,
    lateCompleted: requests.filter(
      (request) =>
        request.completedAt !== undefined &&
        Date.parse(request.completedAt) > Date.parse(request.requestedAt) + FOLLOW_UP_MS &&
        Date.parse(request.completedAt) <= observedThrough,
    ).length,
    immature: requests.filter((request) => Date.parse(request.requestedAt) + FOLLOW_UP_MS > observedThrough).length,
    triggers: Object.fromEntries(
      [...AUTOMATIC_TRIGGERS, 'download-all'].map((trigger) => [
        trigger,
        requests.filter((request) => request.trigger === trigger).length,
      ]),
    ),
  };
}

/** Pure evaluation: reads no files or services and never changes runtime defaults. */
export function evaluateOfflineBulkValidation(rawInput: unknown) {
  const input = parseOfflineBulkValidation(rawInput);
  const blockers: string[] = [];
  const start = Date.parse(input.enrollmentStart);
  const end = Date.parse(input.enrollmentEnd);
  const observedThrough = Date.parse(input.observedThrough);
  if (input.evidenceType === 'synthetic') blockers.push('Synthetic evidence cannot authorize GO.');
  if (Date.parse(input.preregisteredAt) >= start) blockers.push('Protocol must be preregistered before enrollment.');
  if (start >= end) blockers.push('Enrollment window must have positive duration.');
  if (observedThrough < end + FOLLOW_UP_MS) blockers.push('Seven-day follow-up after enrollment closes is incomplete.');
  if (!input.sourceFiltersVerified) blockers.push('Production/native/internal-test/OTA source filters are unverified.');
  if (!input.consentDeliveryCoverageDocumented) blockers.push('Consent and event-delivery coverage are undocumented.');
  if (input.queryEvidence.length === 0) blockers.push('Exact query evidence is missing.');
  const releases = new Map<string, Release>();
  for (const release of input.releases) {
    if (releases.has(release.id)) blockers.push(`Duplicate eligible release: ${release.id}.`);
    releases.set(release.id, release);
  }
  const unique = new Map<string, BulkValidationRequest>();
  for (const request of input.requests) {
    const earlier = unique.get(request.requestId);
    if (earlier !== undefined && JSON.stringify(earlier) !== JSON.stringify(request)) {
      blockers.push(`Conflicting observations for request ${request.requestId}.`);
    } else unique.set(request.requestId, request);
  }
  const requested = [...unique.values()];
  const eligible: BulkValidationRequest[] = [];
  let excludedOutsideEnrollment = 0;
  let excludedUnknownRelease = 0;
  for (const request of requested) {
    const requestedAt = Date.parse(request.requestedAt);
    if (requestedAt < start || requestedAt >= end) {
      excludedOutsideEnrollment++;
      continue;
    }
    if (!releases.has(request.releaseId)) {
      excludedUnknownRelease++;
      continue;
    }
    if (request.requestedScopeCount === 0)
      blockers.push(`Request ${request.requestId}: requestedScopeCount must be positive.`);
    for (const [stage, at, executingReleaseId] of [
      ['started', request.startedAt, request.startedReleaseId],
      ['completed', request.completedAt, request.completedReleaseId],
    ] as const) {
      if (at !== undefined && !lifecycleReleaseMatches(request, executingReleaseId, releases))
        blockers.push(`Request ${request.requestId}: ${stage} release is missing, ineligible or on another platform.`);
    }
    if (request.completedAt !== undefined && request.outcome !== 'completed' && request.outcome !== 'already_available')
      blockers.push(`Request ${request.requestId}: completed timestamp requires an explicit completion outcome.`);
    if (request.outcome === 'completed' && request.startedAt === undefined)
      blockers.push(`Request ${request.requestId}: fresh completion lacks Started coverage.`);
    if (request.outcome === 'cancelled' && request.cancelledAt === undefined)
      blockers.push(`Request ${request.requestId}: cancelled outcome lacks timestamp.`);
    for (const [stage, at] of [
      ['started', request.startedAt],
      ['completed', request.completedAt],
      ['cancelled', request.cancelledAt],
    ] as const) {
      if (at !== undefined && (Date.parse(at) < requestedAt || Date.parse(at) > observedThrough)) {
        blockers.push(`Request ${request.requestId} has ${stage} timestamp outside observed lifecycle.`);
      }
    }
    if (
      request.startedAt !== undefined &&
      request.completedAt !== undefined &&
      Date.parse(request.completedAt) < Date.parse(request.startedAt)
    ) {
      blockers.push(`Request ${request.requestId} completes before it starts.`);
    }
    eligible.push(request);
  }
  const batches = new Map<string, BulkValidationRequest[]>();
  for (const request of eligible) {
    const earlier = batches.get(request.batchId) ?? [];
    if (
      earlier.some(
        (sibling) =>
          sibling.personKey !== request.personKey ||
          sibling.releaseId !== request.releaseId ||
          sibling.trigger !== request.trigger,
      )
    ) {
      blockers.push(`Batch ${request.batchId}: inconsistent person, release or trigger.`);
    }
    if (earlier.some((sibling) => sibling.scopeKey === request.scopeKey))
      blockers.push(`Batch ${request.batchId}: repeated scope with different request IDs.`);
    earlier.push(request);
    batches.set(request.batchId, earlier);
  }
  for (const [batchId, members] of batches) {
    const counts = new Set(members.map((request) => request.requestedScopeCount));
    const expected = members[0].requestedScopeCount;
    const observed = new Set(members.map((request) => request.scopeKey)).size;
    if (counts.size !== 1 || expected !== observed)
      blockers.push(`Batch ${batchId}: requested-scope count disagrees with observed unique members.`);
  }
  for (const release of releases.values()) {
    if (
      !eligible.some(
        (request) =>
          request.releaseId === release.id &&
          request.trigger !== 'download-all' &&
          request.outcome !== 'already_available',
      )
    )
      blockers.push(`Release ${release.id}: fresh automatic production evidence missing.`);
    if (
      !input.devices.some(
        (device) => device.releaseId === release.id && device.trigger !== 'download-all' && device.freshDownload,
      )
    )
      blockers.push(`Release ${release.id}: fresh automatic device evidence missing.`);
  }
  if (excludedUnknownRelease > 0)
    blockers.push(`${excludedUnknownRelease} enrolled requests lack eligible release attribution.`);
  const cohorts = PLATFORMS.flatMap((platform) => {
    if (![...releases.values()].some((release) => release.platform === platform))
      blockers.push(`${platform}: eligible runtime and bundle identity missing.`);
    const platformRequests = eligible.filter((request) => releases.get(request.releaseId)?.platform === platform);
    return (['automatic', 'deliberate'] as const).map((cohort) => {
      const subset = platformRequests.filter((request) =>
        cohort === 'automatic' ? request.trigger !== 'download-all' : request.trigger === 'download-all',
      );
      const summary = cohortSummary(subset, observedThrough, releases);
      const label = `${platform}/${cohort}`;
      if (cohort === 'automatic') {
        if (summary.requested === 0) blockers.push(`${label}: no eligible requested scopes.`);
        if (summary.immature > 0) blockers.push(`${label}: requests have insufficient follow-up.`);
        if (summary.completionRate < OFFLINE_BULK_TARGETS.scopeCompletion)
          blockers.push(`${label}: scope completion below 99%.`);
        if (summary.allCompletedPeopleRate < OFFLINE_BULK_TARGETS.personCompletion)
          blockers.push(`${label}: every-scope person completion below 95%.`);
        if (summary.scopeConfidenceLower < OFFLINE_BULK_TARGETS.scopeCompletion)
          blockers.push(`${label}: scope confidence lower bound below 99%.`);
        if (summary.personConfidenceLower < OFFLINE_BULK_TARGETS.personCompletion)
          blockers.push(`${label}: person confidence lower bound below 95%.`);
        for (const trigger of AUTOMATIC_TRIGGERS) {
          if (!subset.some((request) => request.trigger === trigger && request.outcome !== 'already_available'))
            blockers.push(`${platform}: missing fresh production ${trigger} requests.`);
        }
        const batchScopes = new Map<string, Set<string>>();
        for (const request of subset) {
          const scopes = batchScopes.get(request.batchId) ?? new Set<string>();
          scopes.add(request.scopeKey);
          batchScopes.set(request.batchId, scopes);
        }
        if (
          !subset.some(
            (request) =>
              request.boardType === 'kilter' &&
              request.outcome !== 'already_available' &&
              (batchScopes.get(request.batchId)?.size ?? 0) > 1,
          )
        ) {
          blockers.push(`${platform}: no automatic multi-scope Kilter batch.`);
        }
      }
      return { platform, cohort, ...summary };
    });
  });
  for (const platform of PLATFORMS) {
    const devices = input.devices.filter((device) => releases.get(device.releaseId)?.platform === platform);
    for (const trigger of [...AUTOMATIC_TRIGGERS, 'download-all']) {
      if (!devices.some((device) => device.trigger === trigger && (trigger === 'download-all' || device.freshDownload)))
        blockers.push(`${platform}: missing ${trigger} device evidence.`);
    }
    const automatic = devices.filter((device) => device.trigger !== 'download-all');
    if (!automatic.some((device) => device.heavyKilter && device.freshDownload && device.requestedScopeCount > 1))
      blockers.push(`${platform}: heavy Kilter bulk device evidence missing.`);
    if (!automatic.some((device) => device.cellular && device.freshDownload && device.requestedScopeCount > 1)) {
      blockers.push(`${platform}: fresh automatic bulk cellular evidence missing.`);
    }
    for (const scenario of ['foreground', 'background', 'relaunch', 'cellular'] as const) {
      if (!automatic.some((device) => device.freshDownload && device[scenario]))
        blockers.push(`${platform}: automatic ${scenario} device coverage missing.`);
    }
  }
  const deviceBatchIds = new Set<string>();
  for (const device of input.devices) {
    if (deviceBatchIds.has(device.batchId))
      blockers.push(`Device batch ${device.batchId}: duplicate batch resource measurements.`);
    deviceBatchIds.add(device.batchId);
    const label = `Device batch ${device.batchId}`;
    if (!releases.has(device.releaseId)) blockers.push(`${label}: unknown release.`);
    if (device.completedScopeCount !== device.requestedScopeCount || device.offlineAvailableAfterRelaunch !== true)
      blockers.push(`${label}: every requested scope must complete and remain available offline after relaunch.`);
    if (device.requestedScopeCount === 0) blockers.push(`${label}: no requested scopes.`);
    if (device.cellular && device.freshDownload && device.cellularBytes === 0)
      blockers.push(`${label}: fresh cellular download has no measured traffic.`);
    if (device.evidence.length === 0) blockers.push(`${label}: raw measurement evidence missing.`);
    if (!device.includesAllStorage || !device.includesRetries)
      blockers.push(`${label}: storage components or retry traffic omitted.`);
    if (device.retainedBytes === null || device.retainedBytes > OFFLINE_BULK_TARGETS.retainedBytes)
      blockers.push(`${label}: retained storage unknown or above 2 GiB.`);
    if (
      device.peakBytes === null ||
      device.peakBytes > OFFLINE_BULK_TARGETS.peakBytes ||
      device.peakCoverage !== 'complete' ||
      device.peakSampleIntervalMs === null ||
      device.peakSampleIntervalMs <= 0
    )
      blockers.push(`${label}: peak storage unknown, incompletely observed, or above 4 GiB.`);
    if (device.peakBytes !== null && device.retainedBytes !== null && device.peakBytes < device.retainedBytes)
      blockers.push(`${label}: peak storage is below retained storage.`);
    if (
      device.cellular &&
      (device.cellularBytes === null ||
        (device.trigger !== 'download-all' && device.cellularBytes > OFFLINE_BULK_TARGETS.cellularBytes))
    )
      blockers.push(`${label}: automatic cellular traffic unknown or above 500 MiB.`);
  }
  for (const issue of REQUIRED_DEPENDENCIES) {
    const dispositions = input.dependencies.filter((dependency) => dependency.issue === issue);
    if (
      dispositions.length !== 1 ||
      dispositions[0].disposition === 'unresolved' ||
      dispositions[0].evidence.length === 0
    )
      blockers.push(`#${issue}: release-specific disposition and evidence required.`);
  }
  return {
    schemaVersion: 1,
    studyId: input.studyId,
    decisionDate: input.observedThrough.slice(0, 10),
    decision: blockers.length === 0 ? ('GO' as const) : ('HOLD' as const),
    metricStatus: 'noncanonical exploratory release-validation measures',
    targets: OFFLINE_BULK_TARGETS,
    manifest: {
      preregisteredAt: input.preregisteredAt,
      enrollmentStart: input.enrollmentStart,
      enrollmentEnd: input.enrollmentEnd,
      observedThrough: input.observedThrough,
      releases: input.releases,
    },
    observations: {
      inputRequests: input.requests.length,
      uniqueRequests: requested.length,
      duplicateRecords: input.requests.length - requested.length,
      excludedOutsideEnrollment,
      excludedUnknownRelease,
    },
    cohorts,
    devices: input.devices,
    dependencies: input.dependencies,
    queryEvidence: input.queryEvidence,
    blockers: [...new Set(blockers)],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [inputPath, outputPath, ...extra] = process.argv.slice(2);
    if (!inputPath || !outputPath || extra.length > 0)
      throw new Error('Usage: vp exec tsx scripts/offline-bulk-validation.ts INPUT.json OUTPUT.json');
    const report = evaluateOfflineBulkValidation(JSON.parse(readFileSync(inputPath, 'utf8')) as unknown);
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${report.decision}: ${report.blockers.length} blockers. Report: ${outputPath}\n`);
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
