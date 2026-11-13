import { legacyBridgeMode } from './bridge';

export type NativeRevocationMode = 'legacy' | 'generation';
export const NATIVE_REVOCATION_ACTIVATION_BLOCKERS: readonly string[] = Object.freeze([
  'GARMIN_OFFLINE_TICK_QUEUE_PRESERVATION',
]);

export function parseNativeRevocationMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NativeRevocationMode {
  const mode = environment.AUTH_NATIVE_REVOCATION_MODE;
  if (!mode || mode === 'legacy') return 'legacy';
  if (mode === 'generation') return mode;
  throw new Error('Invalid AUTH_NATIVE_REVOCATION_MODE');
}

/** No environment, NODE_ENV, or operator override can close this code gate. */
export function assertNativeGenerationRevocationActivation(): void {
  if (NATIVE_REVOCATION_ACTIVATION_BLOCKERS.length > 0)
    throw new Error('NATIVE_REVOCATION_ACTIVATION_BLOCKED_GARMIN_OFFLINE_TICK_QUEUE_PRESERVATION');
}

export function currentNativeRevocationMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NativeRevocationMode {
  const mode = parseNativeRevocationMode(environment);
  if (mode === 'generation') assertNativeGenerationRevocationActivation();
  return mode;
}

export function assertNativeRevocationActivationConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const mode = currentNativeRevocationMode(environment);
  if (legacyBridgeMode(environment) === 'on' && mode !== 'generation')
    throw new Error('NATIVE_CANONICAL_ISSUANCE_REQUIRES_GENERATION_REVOCATION');
}
