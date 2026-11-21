/// <reference types="node" />

// One-off, noncanonical download investigation (#7987). The classifier does not
// infer a failed request from a missing completion or a bootstrap Failed event.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DOWNLOAD_FOLLOW_UP_MS = 7 * 24 * 60 * 60 * 1000;
export const DOWNLOAD_AUDIT_WINDOW = {
  cohortFrom: Date.parse('2026-10-17T00:00:00Z'),
  cohortTo: Date.parse('2026-11-14T00:00:00Z'),
  observedTo: Date.parse('2026-11-21T00:00:00Z'),
};

export type DownloadAuditWindow = typeof DOWNLOAD_AUDIT_WINDOW;
export type DownloadAuditEvent = {
  uuid: string;
  timestamp: string;
  event: string;
  clientId: string;
  personId: string;
  scopeKey: string;
  platform: string;
  nativeVersion: string | null;
  runtimeVersion: string | null;
  updateId: string | null;
  embedded: boolean | null;
  enabled?: boolean | null;
  trigger?: string | null;
  reason?: string | null;
  stage?: string | null;
  source?: string | null;
  requestId?: string | null;
  attemptId?: string | null;
  state?: string | null;
  origin?: string | null;
  requestedAt?: number | null;
  completionSource?: string | null;
};

export type DownloadAuditOutcome = 'no-start' | 'completed' | 'abandoned' | 'confirmed-failure' | 'unknown';
type Observation = {
  anchor: DownloadAuditEvent;
  anchorAt: number;
  origin: 'enable-event' | 'requested' | 'start-only';
  requestId?: string;
  events: DownloadAuditEvent[];
  supersededBy?: DownloadAuditEvent;
};
export type DownloadAuditClassification = {
  anchor: DownloadAuditEvent;
  origin: Observation['origin'];
  outcome: DownloadAuditOutcome;
  mature: boolean;
  started: boolean;
  starts: number;
  restarts: number;
  pauses: number;
  resumes: number;
  failuresObserved: number;
  cached: boolean;
  completionAfterPause: boolean;
  trigger: string;
};

const STARTED = 'Offline Board Download Started';
const COMPLETED = 'Offline Board Download Completed';
const FAILED = 'Offline Board Download Failed';
const TOGGLED = 'Offline Board Toggled';
const LIFECYCLE = 'Offline Board Download Lifecycle';
const ABANDONED = new Set(['abandoned-disabled', 'abandoned-removed', 'abandoned-signed-out']);

function timestampOf(event: DownloadAuditEvent): number {
  return Date.parse(event.timestamp);
}

function compareEvents(left: DownloadAuditEvent, right: DownloadAuditEvent): number {
  return (
    timestampOf(left) - timestampOf(right) ||
    left.timestamp.localeCompare(right.timestamp) ||
    left.uuid.localeCompare(right.uuid)
  );
}

function orderedEvents(events: readonly DownloadAuditEvent[]): DownloadAuditEvent[] {
  return [...events].sort(compareEvents);
}

function streamKey(event: DownloadAuditEvent): string {
  return JSON.stringify([event.clientId, event.platform, event.scopeKey]);
}

function isTerminalEvent(event: DownloadAuditEvent): boolean {
  return (
    event.event === COMPLETED ||
    (event.event === TOGGLED && event.enabled === false) ||
    (event.event === FAILED && ABANDONED.has(event.reason ?? '')) ||
    (event.event === LIFECYCLE && ['completed', 'abandoned', 'failed'].includes(event.state ?? ''))
  );
}

function classifyObservation(observation: Observation, window: DownloadAuditWindow): DownloadAuditClassification {
  const deadline = observation.anchorAt + DOWNLOAD_FOLLOW_UP_MS;
  const candidates = observation.events.filter((event) => {
    const timestamp = timestampOf(event);
    return (
      timestamp <= deadline &&
      timestamp < window.observedTo &&
      (!observation.supersededBy || compareEvents(event, observation.supersededBy) < 0)
    );
  });
  const terminalIndex = candidates.findIndex(isTerminalEvent);
  const relevant = terminalIndex < 0 ? candidates : candidates.slice(0, terminalIndex + 1);
  const terminal = terminalIndex < 0 ? undefined : candidates[terminalIndex];
  const starts = relevant.filter((event) => event.event === STARTED).length;
  const started =
    starts > 0 ||
    relevant.some((event) => event.event === LIFECYCLE && ['started', 'resumed'].includes(event.state ?? ''));
  const pauses = new Set(
    relevant
      .filter(
        (event) =>
          (event.event === FAILED && event.reason === 'aborted-background') ||
          (event.event === LIFECYCLE && event.state === 'paused'),
      )
      .map((event) => event.attemptId ?? event.uuid),
  ).size;
  let outcome: DownloadAuditOutcome = started ? 'unknown' : 'no-start';
  if (terminal?.event === COMPLETED || terminal?.state === 'completed') outcome = 'completed';
  else if (terminal?.state === 'failed') outcome = 'confirmed-failure';
  else if (terminal) outcome = 'abandoned';
  return {
    anchor: observation.anchor,
    origin: observation.origin,
    outcome,
    mature: deadline <= window.observedTo,
    started,
    starts,
    restarts:
      Math.max(0, starts - 1) +
      Number(
        observation.origin === 'start-only' &&
          observation.supersededBy?.event === STARTED &&
          !terminal &&
          timestampOf(observation.supersededBy) <= deadline,
      ),
    pauses,
    resumes: relevant.filter((event) => event.event === LIFECYCLE && event.state === 'resumed').length,
    failuresObserved: relevant.filter(
      (event) => event.event === FAILED && !ABANDONED.has(event.reason ?? '') && event.reason !== 'aborted-background',
    ).length,
    cached: outcome === 'completed' && terminal?.completionSource === 'cached',
    completionAfterPause: outcome === 'completed' && pauses > 0,
    trigger: observation.anchor.trigger ?? relevant.find((event) => event.event === STARTED)?.trigger ?? 'unknown',
  };
}

/** Historical enables are inferred generations; lifecycle request IDs are exact. */
export function classifyDownloadRequests(
  events: readonly DownloadAuditEvent[],
  window: DownloadAuditWindow = DOWNLOAD_AUDIT_WINDOW,
): DownloadAuditClassification[] {
  const streams = new Map<string, { enabled: boolean; active?: Observation; byId: Map<string, Observation> }>();
  const observations: Observation[] = [];
  for (const event of orderedEvents(events)) {
    if (timestampOf(event) >= window.observedTo) continue;
    const key = streamKey(event);
    let stream = streams.get(key);
    if (!stream) {
      stream = { enabled: false, byId: new Map() };
      streams.set(key, stream);
    }
    const identifiedRequest =
      event.event === LIFECYCLE && event.state === 'requested' && event.origin === 'requested' && event.requestId;
    const legacyRequest = event.event === TOGGLED && event.enabled === true && !event.requestId && !stream.enabled;
    if (identifiedRequest || legacyRequest) {
      // Repeated delivery of a requested lifecycle event is not another request.
      if (event.requestId && stream.byId.has(event.requestId)) continue;
      if (stream.active) stream.active.supersededBy = event;
      const observation: Observation = {
        anchor: event,
        anchorAt: identifiedRequest && typeof event.requestedAt === 'number' ? event.requestedAt : timestampOf(event),
        origin: identifiedRequest ? 'requested' : 'enable-event',
        ...(event.requestId ? { requestId: event.requestId } : {}),
        events: [],
      };
      observations.push(observation);
      stream.active = observation;
      if (event.requestId) stream.byId.set(event.requestId, observation);
    }
    // Legacy asynchronous terminals can arrive after a replacement request.
    // Identified generations need their own ID to establish a terminal outcome;
    // unkeyed history remains usable only for legacy, inferred generations.
    if (!event.requestId && stream.active?.requestId && isTerminalEvent(event)) continue;
    // An ID never falls back to the current scope: a stale callback belongs to
    // its original generation, including after disable/re-enable.
    const observation = event.requestId ? stream.byId.get(event.requestId) : stream.active;
    observation?.events.push(event);
    if (event.requestId && observation !== stream.active) continue;
    if (event.event === TOGGLED && event.enabled !== null && event.enabled !== undefined)
      stream.enabled = event.enabled;
    // Old clients reported a scope's terminal abandonment without always
    // delivering its disabled toggle. Close that generation before a later
    // enable; ordinary attempt failures and background pauses keep it open.
    if (
      (event.event === LIFECYCLE && event.state === 'abandoned') ||
      (event.event === FAILED && ABANDONED.has(event.reason ?? ''))
    )
      stream.enabled = false;
    if (identifiedRequest) stream.enabled = true;
  }
  return observations
    .filter(({ anchorAt }) => anchorAt >= window.cohortFrom && anchorAt < window.cohortTo)
    .map((observation) => classifyObservation(observation, window));
}

/** One completion can credit only the latest preceding start in a stream. */
export function classifyDownloadStarts(
  events: readonly DownloadAuditEvent[],
  window: DownloadAuditWindow = DOWNLOAD_AUDIT_WINDOW,
): DownloadAuditClassification[] {
  const activeByStream = new Map<string, Observation>();
  const observations: Observation[] = [];
  for (const event of orderedEvents(events)) {
    const key = streamKey(event);
    if (event.event === STARTED) {
      const previous = activeByStream.get(key);
      if (previous) previous.supersededBy = event;
      const observation: Observation = {
        anchor: event,
        anchorAt: timestampOf(event),
        origin: 'start-only',
        events: [event],
      };
      observations.push(observation);
      activeByStream.set(key, observation);
    } else {
      const active = activeByStream.get(key);
      // Identified callbacks must never cross a request-generation boundary.
      if (
        active &&
        (!active.anchor.requestId ||
          event.requestId === active.anchor.requestId ||
          (!event.requestId && !isTerminalEvent(event)))
      )
        active.events.push(event);
    }
  }
  return observations
    .filter(({ anchorAt }) => anchorAt >= window.cohortFrom && anchorAt < window.cohortTo)
    .map((observation) => classifyObservation(observation, window));
}

/** Aggregate output deliberately omits client, person, request and event IDs. */
export function summarizeDownloadAudit(classifications: readonly DownloadAuditClassification[]) {
  const mature = classifications.filter((observation) => observation.mature);
  const outcomes: Record<DownloadAuditOutcome, number> = {
    'no-start': 0,
    completed: 0,
    abandoned: 0,
    'confirmed-failure': 0,
    unknown: 0,
  };
  const people = new Map<string, boolean>();
  const releases = new Map<
    string,
    {
      platform: string;
      nativeVersion: string | null;
      runtimeVersion: string | null;
      updateId: string | null;
      embedded: boolean | null;
      requests: number;
      outcomes: Record<DownloadAuditOutcome, number>;
    }
  >();
  const origins: Record<string, number> = {};
  const triggers: Record<string, number> = {};
  const boards: Record<string, number> = {};
  for (const observation of mature) {
    outcomes[observation.outcome] += 1;
    origins[observation.origin] = (origins[observation.origin] ?? 0) + 1;
    triggers[observation.trigger] = (triggers[observation.trigger] ?? 0) + 1;
    const boardType = observation.anchor.scopeKey.split(':')[0];
    boards[boardType] = (boards[boardType] ?? 0) + 1;
    people.set(
      observation.anchor.personId,
      (people.get(observation.anchor.personId) ?? true) && observation.outcome === 'completed',
    );
    const { platform, nativeVersion, runtimeVersion, updateId, embedded } = observation.anchor;
    const key = JSON.stringify([platform, nativeVersion, runtimeVersion, updateId, embedded]);
    let release = releases.get(key);
    if (!release) {
      release = {
        platform,
        nativeVersion,
        runtimeVersion,
        updateId,
        embedded,
        requests: 0,
        outcomes: { 'no-start': 0, completed: 0, abandoned: 0, 'confirmed-failure': 0, unknown: 0 },
      };
      releases.set(key, release);
    }
    release.requests += 1;
    release.outcomes[observation.outcome] += 1;
  }
  return {
    observations: mature.length,
    immature: classifications.length - mature.length,
    outcomes,
    origins,
    triggers,
    boards,
    people: people.size,
    peopleCompletingEveryObservedRequest: [...people.values()].filter(Boolean).length,
    restarts: mature.reduce((total, observation) => total + observation.restarts, 0),
    pausesObserved: mature.reduce((total, observation) => total + observation.pauses, 0),
    resumesObserved: mature.reduce((total, observation) => total + observation.resumes, 0),
    requestsWithFailureEvents: mature.filter((observation) => observation.failuresObserved > 0).length,
    cachedCompletions: mature.filter((observation) => observation.cached).length,
    completionsAfterPause: mature.filter((observation) => observation.completionAfterPause).length,
    releases: [...releases.values()].sort(
      (left, right) => right.requests - left.requests || JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
  };
}

/** Accept the exact tuple exported by the evidence query, not whole properties. */
export function parseDownloadAuditTuples(tuples: readonly unknown[]): DownloadAuditEvent[] {
  return tuples.map((tuple) => {
    if (!Array.isArray(tuple) || tuple.length < 16) throw new Error('Expected a 16-column download audit tuple');
    const [
      uuid,
      timestamp,
      event,
      clientId,
      personId,
      scopeKey,
      platform,
      nativeVersion,
      runtimeVersion,
      updateId,
      embedded,
      enabled,
      trigger,
      reason,
      stage,
      source,
    ] = tuple as unknown[];
    if (![uuid, timestamp, event, clientId, personId, scopeKey, platform].every((field) => typeof field === 'string'))
      throw new Error('Invalid download audit identity or timestamp');
    const normalizedTimestamp = String(timestamp).replace(' ', 'T').replace(/Z?$/, 'Z');
    if (!Number.isFinite(Date.parse(normalizedTimestamp))) throw new Error('Invalid download audit timestamp');
    const stringOrNull = (field: unknown): string | null => (typeof field === 'string' ? field : null);
    return {
      uuid: String(uuid),
      timestamp: normalizedTimestamp,
      event: String(event),
      clientId: String(clientId),
      personId: String(personId),
      scopeKey: String(scopeKey),
      platform: String(platform),
      nativeVersion: stringOrNull(nativeVersion),
      runtimeVersion: stringOrNull(runtimeVersion),
      updateId: stringOrNull(updateId),
      embedded: typeof embedded === 'boolean' ? embedded : null,
      enabled: typeof enabled === 'boolean' ? enabled : null,
      trigger: stringOrNull(trigger),
      reason: stringOrNull(reason),
      stage: stringOrNull(stage),
      source: stringOrNull(source),
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tuples: unknown = JSON.parse(readFileSync(process.argv[2] ?? 0, 'utf8'));
  if (!Array.isArray(tuples)) throw new Error('Expected a JSON array of audit tuples');
  const events = parseDownloadAuditTuples(tuples);
  console.log(
    JSON.stringify(
      {
        requests: summarizeDownloadAudit(classifyDownloadRequests(events)),
        starts: summarizeDownloadAudit(classifyDownloadStarts(events)),
      },
      null,
      2,
    ),
  );
}
