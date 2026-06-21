import { captureBackendEvent } from './posthog';

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
  userId: string;
  sessionId: string;
  tokenLength: number;
  apnsConfigured: boolean;
  tokenPreviouslyRegistered: boolean;
  tokenRebound: boolean;
}

interface LiveActivityEndEvent {
  userId: string;
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
  userId: string;
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
  userId: string;
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
    distinctId: event.userId,
    properties: {
      userId: event.userId,
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
    distinctId: event.userId,
    properties: {
      userId: event.userId,
      sessionId: event.sessionId,
      reason: event.reason,
      tokenCount: event.tokenCount,
    },
  });
}

export function trackLiveActivityEndedAttributionGap(event: LiveActivityEndAttributionGapEvent): void {
  captureBackendEvent('Live Activity Ended Attribution Gap', {
    distinctId: `live-activity-session:${event.sessionId}`,
    processPersonProfile: false,
    properties: {
      sessionId: event.sessionId,
      reason: event.reason,
      tokenCount: event.tokenCount,
    },
  });
}

export function trackLiveActivityWidgetNavigation(event: LiveActivityWidgetNavigationEvent): void {
  captureBackendEvent('Live Activity Widget Navigation', {
    distinctId: event.userId,
    properties: {
      userId: event.userId,
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
    distinctId: `live-activity-session:${event.sessionId}`,
    processPersonProfile: false,
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

export function trackLiveActivityPushDelivery(event: LiveActivityPushDeliveryEvent): void {
  captureBackendEvent('Live Activity Push Delivery', {
    distinctId: event.userId,
    properties: {
      userId: event.userId,
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
    distinctId: `live-activity-session:${event.sessionId}`,
    processPersonProfile: false,
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
