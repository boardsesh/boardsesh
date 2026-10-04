import type { LaunchUpdateOutcome, LaunchUpdatePhase, LaunchUpdateTrigger } from './launch-update-gate';

// OTA-adoption telemetry. Mobile-only (web has no OTA), so the event names stay
// free-string constants rather than entries in @boardsesh/analytics'
// SHARED_EVENTS (which is for names fired by BOTH platforms). See
// docs/mobile-ota-updates.md for what each event measures.

// Fired once per launch with the running JS bundle's metadata. The adoption
// signal: isEmbeddedLaunch === false means the install is running an OTA'd
// bundle; group by updateId to size the rollout of a specific JS-only fix; and
// runtimeVersion is the fingerprint cohort that can receive OTAs at all.
export const OTA_UPDATE_STATUS_EVENT = 'OTA Update Status';

// Fired when a newer bundle finishes downloading this session (it applies on the
// next launch, which the following launch's OTA Update Status event records).
// Together they form the published → downloaded → applied funnel.
export const OTA_UPDATE_DOWNLOADED_EVENT = 'OTA Update Downloaded';

// Fired exactly once per gated cold start by the launch update gate
// (launch-update-gate.ts): before the reload when the gate reloads onto a fresh
// bundle, on release otherwise. `duration_ms` against `cap_ms` is how the caps
// get tuned; `trigger` separates a binary's first launch from an ordinary cold
// start; `phase_at_release` says whether the gate ended while still waiting on
// the manifest (`check`), with a download under way or done (`download`), or
// with neither (`none`), which is what tells a hung manifest request from a
// slow download among the `timed_out` launches. A launch the gate skips (dev, updates disabled, emergency launch,
// background launch, the runtime a reload produced) fires nothing.
export const OTA_LAUNCH_UPDATE_EVENT = 'OTA Launch Update';

export type OtaLaunchUpdateProperties = {
  outcome: LaunchUpdateOutcome;
  phase_at_release: LaunchUpdatePhase;
  duration_ms: number;
  trigger: LaunchUpdateTrigger;
  cap_ms: number;
  ota_runtime_version: string | null;
  ota_is_embedded: boolean;
};

export function buildOtaLaunchUpdateProperties(fields: {
  outcome: LaunchUpdateOutcome;
  phase: LaunchUpdatePhase;
  durationMs: number;
  trigger: LaunchUpdateTrigger;
  capMs: number;
  runtimeVersion: string | null | undefined;
  isEmbeddedLaunch: boolean;
}): OtaLaunchUpdateProperties {
  return {
    outcome: fields.outcome,
    phase_at_release: fields.phase,
    duration_ms: Math.max(0, Math.round(fields.durationMs)),
    trigger: fields.trigger,
    cap_ms: fields.capMs,
    ota_runtime_version: fields.runtimeVersion ?? null,
    ota_is_embedded: fields.isEmbeddedLaunch,
  };
}

// The raw expo-updates constants the status event is built from. Nullable string
// and Date fields accept `undefined` too so the mapper can run against the
// disabled-Updates state (dev / Expo Go), where they are absent.
export type OtaUpdateFields = {
  isEnabled: boolean;
  isEmbeddedLaunch: boolean;
  updateId: string | null | undefined;
  channel: string | null | undefined;
  branch: string | null | undefined;
  runtimeVersion: string | null | undefined;
  createdAt: Date | null | undefined;
  isEmergencyLaunch: boolean;
  emergencyLaunchReason: string | null | undefined;
};

export type OtaStatusProperties = {
  isEnabled: boolean;
  isEmbeddedLaunch: boolean;
  updateId: string | null;
  channel: string | null;
  branch: string | null;
  runtimeVersion: string | null;
  createdAtIso: string | null;
  isEmergencyLaunch: boolean;
  emergencyLaunchReason: string | null;
};

// Maps the expo-updates constants to a flat PostHog property object. Coerces
// absent fields to null (PostHog drops undefined) and the Date to an ISO string.
// Pure so it unit-tests with plain objects, no native module.
export function buildOtaStatusProperties(fields: OtaUpdateFields): OtaStatusProperties {
  return {
    isEnabled: fields.isEnabled,
    isEmbeddedLaunch: fields.isEmbeddedLaunch,
    updateId: fields.updateId ?? null,
    channel: fields.channel ?? null,
    branch: fields.branch ?? null,
    runtimeVersion: fields.runtimeVersion ?? null,
    createdAtIso: fields.createdAt ? fields.createdAt.toISOString() : null,
    isEmergencyLaunch: fields.isEmergencyLaunch,
    emergencyLaunchReason: fields.emergencyLaunchReason ?? null,
  };
}

/** Read xprem's running branch marker without depending on native manifest types. */
export function readOtaBranch(manifest: unknown): string | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  const extra = (manifest as Record<string, unknown>).extra;
  if (typeof extra !== 'object' || extra === null) return null;
  const branch = (extra as Record<string, unknown>).branch;
  return typeof branch === 'string' && branch.length > 0 ? branch : null;
}
