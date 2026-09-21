// @boardsesh/analytics — platform-neutral PostHog wrapper shared by web and
// mobile. The two apps supply their own SDK client (posthog-js-lite /
// posthog-react-native) and platform I/O (alias-dedupe storage); everything that
// would otherwise be duplicated — the wrapper surface, prop sanitization, the
// identity state machine, and the cross-platform event names — lives here.
export type { AnalyticsCaptureOptions, AnalyticsProperties, AnalyticsPropertyValue, PostHogClient } from './client';
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
  boardRenderSettingsChanged,
  boardRenderPresetApplied,
  boardLookStepShown,
  boardLookStepResolved,
  boardRenderFailed,
  classifyBoardRenderErrorCode,
  type BoardRenderMode,
  type GlowFalloff,
  type GlowFalloffSource,
  type BoardRenderEffectiveSettings,
  type BoardRenderContext,
  type BoardRenderTelemetryProps,
  type BoardRenderPayload,
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
  type BoardRenderStallState,
  type BoardRenderImageLoadFailureKind,
  type BoardRenderConfigFailureKind,
  type BoardRenderFailureKind,
  type BoardRenderErrorCode,
  type BoardRenderFailureFields,
  type BoardRenderFailedInput,
} from './board-render-events';
// Spray wall telemetry (epic #5346). Cross-platform names, mobile-only call
// sites today — www has no wall surface. Outcomes only: one event per wall per
// step, and nothing that identifies a wall or what is on it.
export {
  sprayWallPhotoPicked,
  sprayWallUploadFinished,
  sprayWallDetectionFinished,
  sprayHoldsReviewed,
  sprayWallResetPreviewed,
  sprayWallResetApplied,
  climbRemixedFromBroken,
  SPRAY_ROLLOUT_GATES,
  type SprayWallPayload,
  type SprayPhotoSource,
  type SprayUploadOutcome,
  type SprayDetectionOutcome,
  type SprayRemixSurface,
  type SprayWallPhotoPickedProps,
  type SprayWallUploadFinishedProps,
  type SprayWallDetectionFinishedProps,
  type SprayHoldsReviewedProps,
  type SprayWallResetPreviewedProps,
  type SprayWallResetAppliedProps,
  type ClimbRemixedFromBrokenProps,
} from './spray-wall-events';
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
