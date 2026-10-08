import { captureBackendEvent } from './posthog';

/*
 * Live Activity telemetry. Operational, not product analytics: it says whether
 * APNs pushes and widget taps work, so it is sent whatever a climber's consent
 * and carries nobody's identity. `captureBackendEvent` gives every event its own
 * random distinct id and no person profile; nothing here passes a user id.
 *
 * The `... Attribution Gap` events still exist because they count a different
 * condition (a push token registered without a user), not because the main
 * events carry a user.
 */

type WidgetNavigationOutcome =
  | 'success'
  | 'rate_limited'
  | 'wrong_session'
  | 'session_ended'
  | 'not_participant'
  | 'queue_empty'
  | 'target_out_of_bounds'
  | 'error';

interface LiveActivityRegistrationEvent {
  sessionId: string;
  tokenLength: number;
  apnsConfigured: boolean;
  tokenPreviouslyRegistered: boolean;
  tokenRebound: boolean;
}

interface LiveActivityEndEvent {
  sessionId: string;
  reason: 'unregister' | 'session-ended';
  tokenCount?: number;
}

interface LiveActivityEndAttributionGapEvent {
  sessionId: string;
  reason: 'missing_user_id';
  tokenCount: number;
}

interface LiveActivityWidgetNavigationEvent {
  sessionId: string;
  action: 'next' | 'previous';
  outcome: WidgetNavigationOutcome;
  statusCode: number;
  queueLength?: number;
  serverCurrentIndex?: number;
  targetIndex?: number;
  boundSessionId?: string;
}

interface LiveActivityWidgetNavigationAttributionGapEvent {
  sessionId: string;
  action: 'next' | 'previous';
  outcome: WidgetNavigationOutcome;
  statusCode: number;
  reason: 'missing_user_id';
  queueLength?: number;
  serverCurrentIndex?: number;
  targetIndex?: number;
  boundSessionId?: string;
}

interface LiveActivityPushDeliveryEvent {
  sessionId: string;
  event: 'update' | 'end';
  source: 'event' | 'heartbeat' | 'registration';
  tokenCount: number;
  sentCount: number;
  failedCount: number;
  staleCount: number;
  elapsedMs: number;
}

interface LiveActivityPushDeliveryAttributionGapEvent {
  sessionId: string;
  event: 'update' | 'end';
  source: 'event' | 'heartbeat' | 'registration';
  reason: 'missing_user_id';
  tokenCount: number;
  sentCount: number;
  failedCount: number;
  staleCount: number;
  elapsedMs: number;
}

export function trackLiveActivityStarted(event: LiveActivityRegistrationEvent): void {
  captureBackendEvent('Live Activity Started', {
    properties: {
      sessionId: event.sessionId,
      tokenLength: event.tokenLength,
      apnsConfigured: event.apnsConfigured,
      tokenPreviouslyRegistered: event.tokenPreviouslyRegistered,
      tokenRebound: event.tokenRebound,
    },
  });
}

export function trackLiveActivityEnded(event: LiveActivityEndEvent): void {
  captureBackendEvent('Live Activity Ended', {
    properties: {
      sessionId: event.sessionId,
      reason: event.reason,
      tokenCount: event.tokenCount,
    },
  });
}

export function trackLiveActivityEndedAttributionGap(event: LiveActivityEndAttributionGapEvent): void {
  captureBackendEvent('Live Activity Ended Attribution Gap', {
    properties: {
      sessionId: event.sessionId,
      reason: event.reason,
      tokenCount: event.tokenCount,
    },
  });
}

export function trackLiveActivityWidgetNavigation(event: LiveActivityWidgetNavigationEvent): void {
  captureBackendEvent('Live Activity Widget Navigation', {
    properties: {
      sessionId: event.sessionId,
      action: event.action,
      outcome: event.outcome,
      statusCode: event.statusCode,
      queueLength: event.queueLength,
      serverCurrentIndex: event.serverCurrentIndex,
      targetIndex: event.targetIndex,
      boundSessionId: event.boundSessionId,
    },
  });
}

export function trackLiveActivityWidgetNavigationAttributionGap(
  event: LiveActivityWidgetNavigationAttributionGapEvent,
): void {
  captureBackendEvent('Live Activity Widget Navigation Attribution Gap', {
    properties: {
      sessionId: event.sessionId,
      action: event.action,
      outcome: event.outcome,
      statusCode: event.statusCode,
      reason: event.reason,
      queueLength: event.queueLength,
      serverCurrentIndex: event.serverCurrentIndex,
      targetIndex: event.targetIndex,
      boundSessionId: event.boundSessionId,
    },
  });
}

// Only deliveries that actually went wrong are captured. Every push used to fire
// one of these — 26.6k events across 191 users in a 30-day window, of which 34
// carried a failure, and a third were `source: 'heartbeat'` keep-alives. Nothing
// read the clean rows: no insight, dashboard, or alert referenced this event.
// The failure/stale rate is the question this event exists to answer, so the
// denominator lives in the APNs logs rather than in PostHog's event budget.
export function trackLiveActivityPushDelivery(event: LiveActivityPushDeliveryEvent): void {
  if (event.failedCount === 0 && event.staleCount === 0) return;

  captureBackendEvent('Live Activity Push Delivery', {
    properties: {
      sessionId: event.sessionId,
      event: event.event,
      source: event.source,
      tokenCount: event.tokenCount,
      sentCount: event.sentCount,
      failedCount: event.failedCount,
      staleCount: event.staleCount,
      elapsedMs: event.elapsedMs,
    },
  });
}

export function trackLiveActivityPushDeliveryAttributionGap(event: LiveActivityPushDeliveryAttributionGapEvent): void {
  captureBackendEvent('Live Activity Push Delivery Attribution Gap', {
    properties: {
      sessionId: event.sessionId,
      event: event.event,
      source: event.source,
      reason: event.reason,
      tokenCount: event.tokenCount,
      sentCount: event.sentCount,
      failedCount: event.failedCount,
      staleCount: event.staleCount,
      elapsedMs: event.elapsedMs,
    },
  });
}
