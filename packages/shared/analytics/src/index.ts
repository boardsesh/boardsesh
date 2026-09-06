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
// Board render mode telemetry (issue #2202). Cross-platform (SHARED_EVENTS),
// unlike the gym funnel below — mobile fires every one of these today.
export {
  buildBoardRenderTelemetryProps,
  climbViewOpened,
  boardPinch,
  climbFirstAction,
  boardRenderSettingsChanged,
  boardRenderPresetApplied,
  boardLookStepShown,
  boardLookStepResolved,
  boardRenderFailed,
  classifyBoardRenderErrorCode,
  type BoardRenderMode,
  type GlowFalloff,
  type GlowFalloffSource,
  type ClimbActionType,
  type BoardRenderEffectiveSettings,
  type BoardRenderContext,
  type BoardRenderTelemetryProps,
  type BoardRenderPayload,
  type ClimbViewOpenedInput,
  type BoardPinchInput,
  type ClimbFirstActionInput,
  type BoardRenderSettingsChangedInput,
  type BoardRenderPresetAppliedInput,
  type BoardRenderPresetSurface,
  type BoardLookOptionId,
  type BoardLookStepOutcome,
  type BoardLookStepShownInput,
  type BoardLookStepResolvedInput,
  type BoardRenderFailureSurface,
  type BoardRenderFailureStage,
  type BoardRenderNativeFailureKind,
  type BoardRenderImageLoadFailureKind,
  type BoardRenderConfigFailureKind,
  type BoardRenderFailureKind,
  type BoardRenderErrorCode,
  type BoardRenderFailureFields,
  type BoardRenderFailedInput,
} from './board-render-events';
export {
  buildCohortPersonProperties,
  type CohortProfileInput,
  type CohortPersonProperties,
} from './cohort-person-properties';
// www-only gym funnel (epic #4372 / issue #4374). Kept out of SHARED_EVENTS on
// purpose — that catalog is scoped to events BOTH platforms fire, and the gym
// directory, claim flow and manage console have no mobile counterpart.
export {
  GYM_FUNNEL_EVENTS,
  GYM_QR_MEDIUMS,
  GYM_QR_SRC_PARAM,
  GYM_QR_MEDIUM_PARAM,
  GYM_QR_SRC_VALUE,
  gymClaimCtaClicked,
  gymClaimSubmitted,
  gymClaimResult,
  gymQrScanned,
  gymPageCtaClicked,
  gymManageTabViewed,
  gymDirectorySearched,
  parseGymQrLanding,
  buildGymQrHref,
  stripGymQrParams,
  type GymFunnelEventKey,
  type GymFunnelEventName,
  type GymFunnelPayload,
  type GymClaimViewerState,
  type GymClaimPlacement,
  type GymClaimSubmitMethod,
  type GymClaimResultStatus,
  type GymQrMedium,
  type GymPageCta,
  type GymManageTabName,
  type GymClaimCtaClickedInput,
  type GymClaimSubmittedInput,
  type GymClaimResultInput,
  type GymQrScannedInput,
  type GymPageCtaClickedInput,
  type GymManageTabViewedInput,
  type GymDirectorySearchedInput,
  type GymQrSearchParams,
  type GymQrLanding,
} from './gym-funnel';
// www-only CNC build-pack funnel (plan section B6). Out of SHARED_EVENTS for the
// same reason as the gym funnel above: /build-plans has no mobile counterpart.
export {
  CNC_FUNNEL_EVENTS,
  cncBuildPlansPageViewed,
  cncConfiguratorChanged,
  cncArtworkPlaced,
  cncCheckoutStarted,
  type CncFunnelEventKey,
  type CncFunnelEventName,
  type CncFunnelPayload,
  type CncTier,
  type CncConfiguratorStep,
  type CncConfigProps,
  type CncPageViewedInput,
  type CncConfiguratorChangedInput,
  type CncArtworkPlacedInput,
  type CncCheckoutStartedInput,
} from './cnc-funnel';
