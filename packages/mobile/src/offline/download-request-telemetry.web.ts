// Expo web has no native catalogue downloads or native storage measurements.
import type { DownloadRequestCorrelation, ScopeDownloadObservedInfo } from '@boardsesh/offline-sync';
import type { AnalyticsEventProperties } from '@boardsesh/analytics';

export function recordDownloadRequests(
  _scopes: readonly string[],
  _options: { trigger: string; source: string; replaceDisabled?: boolean },
): void {}
export function getDownloadRequestContext(_scopeKey: string): DownloadRequestCorrelation | undefined {
  return undefined;
}
export function downloadRequestProperties(
  _scopeKey: string,
  _request?: DownloadRequestCorrelation,
): AnalyticsEventProperties {
  return {};
}
export function recordDownloadStarted(_scopeKey: string, _request?: DownloadRequestCorrelation): void {}
export function recordDownloadCompleted(_scopeKey: string, _request?: DownloadRequestCorrelation): void {}
export function observeDownloadScope(_info: ScopeDownloadObservedInfo): void {}
export function clearDownloadRequestAttribution(): void {}
export function sampleDownloadStorage(_request: DownloadRequestCorrelation, _phase: string): void {}

export function downloadTransferProperties(_request?: DownloadRequestCorrelation): AnalyticsEventProperties {
  return {};
}

export function downloadFunnelProperties(
  _scopeKey: string,
  _request?: DownloadRequestCorrelation,
): AnalyticsEventProperties {
  return {};
}
