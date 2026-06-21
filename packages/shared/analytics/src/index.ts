// @boardsesh/analytics — platform-neutral PostHog wrapper shared by web and
// mobile. The two apps supply their own SDK client (posthog-js-lite /
// posthog-react-native) and platform I/O (alias-dedupe storage); everything that
// would otherwise be duplicated — the wrapper surface, prop sanitization, the
// identity state machine, and the cross-platform event names — lives here.
export type { AnalyticsProperties, AnalyticsPropertyValue, PostHogClient } from './client';
export { sanitizeForPosthog } from './sanitize';
export { sanitizeErrorForAnalytics } from './sanitize-error';
export {
  createAnalytics,
  type AnalyticsApi,
  type AnalyticsEventProperties,
  type CreateAnalyticsOptions,
} from './create-analytics';
export {
  reconcileAnalyticsIdentity,
  type AliasDedupeStore,
  type IdentityClient,
  type ReconcileAnalyticsIdentityInput,
} from './reconcile-identity';
export { SHARED_EVENTS, type SharedEventKey, type SharedEventName } from './events';
