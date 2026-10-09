import type { OtaStatusProperties, OtaLaunchUpdateProperties } from './ota-telemetry';

/** The health sink accepts build metadata and launch outcomes, never arbitrary properties. */
export function anonymousOtaStatusProperties(properties: OtaStatusProperties) {
  return {
    isEnabled: properties.isEnabled,
    isEmbeddedLaunch: properties.isEmbeddedLaunch,
    updateId: properties.updateId,
    channel: properties.channel,
    branch: properties.branch,
    runtimeVersion: properties.runtimeVersion,
    createdAtIso: properties.createdAtIso,
    isEmergencyLaunch: properties.isEmergencyLaunch,
  };
}

export function anonymousOtaLaunchProperties(properties: OtaLaunchUpdateProperties) {
  return {
    outcome: properties.outcome,
    phase_at_release: properties.phase_at_release,
    duration_ms: properties.duration_ms,
    trigger: properties.trigger,
    cap_ms: properties.cap_ms,
    ota_runtime_version: properties.ota_runtime_version,
    ota_is_embedded: properties.ota_is_embedded,
  };
}
